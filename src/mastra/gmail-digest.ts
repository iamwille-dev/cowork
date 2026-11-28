import { z } from 'zod';
import { agentConnection, type AgentConnection, type AgentConnectionContext } from './tools/agent-connection.ts';

const messageId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const mailboxSearch = z.object({
  messages: z.array(z.object({ id: messageId })).default([]),
  nextPageToken: z.string().optional(),
});
const mailboxMessage = z.object({
  headers: z.object({ from: z.string().optional(), subject: z.string().optional(), date: z.string().optional() }).default({}),
  snippet: z.string().nullish(),
  text: z.string().nullish(),
});
const maxMessages = 10;
export const gmailDigestUnavailable = 'The selected Gmail account is unavailable to this agent. Check its grant in Settings.';

export async function gmailDigestConnection(context: AgentConnectionContext, id: string) {
  if (!context.AgentConnectionIDs?.includes(id)) return;
  const access = await agentConnection({ ...context, AgentConnectionIDs: [id] });
  if (access.connection?.hasTools('gmail_search', 'gmail_read')) return access.connection;
}

export async function readUnreadGmail(connection: AgentConnection, id: string) {
  const signal = AbortSignal.timeout(35_000);
  return connection.connect(async (client) => {
    const options = { timeout: 12_000, signal };
    const search = await client.callTool({
      name: 'gmail_search', arguments: { connection_id: id, query: 'in:inbox is:unread' },
    }, undefined, options);
    const page = mailboxSearch.safeParse(search.structuredContent);
    if (search.isError || !page.success) throw new Error('Unread Gmail search failed.');

    const selected = page.data.messages.slice(0, maxMessages);
    const messages = [];
    for (let index = 0; index < selected.length; index += 4) {
      const results = await Promise.allSettled(selected.slice(index, index + 4).map(async ({ id: message }) => {
        const result = await client.callTool({
          name: 'gmail_read', arguments: { connection_id: id, message_id: message },
        }, undefined, options);
        if (result.isError) throw new Error('Gmail message unavailable.');
        const { headers, text, snippet } = mailboxMessage.parse(result.structuredContent);
        return {
          from: headers.from?.slice(0, 240), subject: headers.subject?.slice(0, 300),
          date: headers.date?.slice(0, 100), excerpt: (text?.trim() || snippet || '').slice(0, 1500),
        };
      }));
      for (const result of results) if (result.status === 'fulfilled') messages.push(result.value);
    }
    if (selected.length && !messages.length) throw new Error('No Gmail messages could be read.');
    return { messages, more: Boolean(page.data.nextPageToken) || page.data.messages.length > maxMessages,
      skipped: selected.length - messages.length };
  });
}
