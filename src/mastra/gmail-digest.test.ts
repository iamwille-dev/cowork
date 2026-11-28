import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gmailDigestConnection, readUnreadGmail } from './gmail-digest.ts';
import type { AgentConnection } from './tools/agent-connection.ts';

test('reads only a bounded sample of unread inbox messages from the selected Gmail connection', async () => {
  const calls: { name: string; arguments?: Record<string, unknown> }[] = [];
  const mailbox: AgentConnection = {
    hasTools: () => true,
    connect: async (use) => use({
      callTool: async (params) => {
        calls.push(params);
        return params.name === 'gmail_search'
          ? { content: [], structuredContent: { messages: Array.from({ length: 12 }, (_, i) => ({ id: String(i) })) } }
          : params.arguments?.message_id === '2'
            ? { content: [], isError: true }
            : { content: [], structuredContent: { headers: { subject: 'Reading list', to: 'hidden' }, text: 'a'.repeat(2000) } };
      },
    }),
  };
  const digest = await readUnreadGmail(mailbox, 'selected');
  assert.deepEqual(calls[0], { name: 'gmail_search', arguments: { connection_id: 'selected', query: 'in:inbox is:unread' } });
  assert.deepEqual(calls.slice(1), Array.from({ length: 10 }, (_, i) => ({
    name: 'gmail_read', arguments: { connection_id: 'selected', message_id: String(i) },
  })));
  assert.equal(digest.messages.length, 9);
  assert.equal(digest.skipped, 1);
  assert.equal(digest.more, true);
  assert.equal(digest.messages[0].excerpt.length, 1500);
  assert.equal(Object.hasOwn(digest.messages[0], 'to'), false);
  assert.equal(await gmailDigestConnection({ AgentConnectionIDs: ['selected'] }, 'other'), undefined);
});
