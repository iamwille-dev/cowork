import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Chat } from 'chat';
import { createWebAdapter } from '@chat-adapter/web';
import { createMemoryState } from '@chat-adapter/state-memory';

type ChatUser = { id: string; name: string };
type Turn = { user: ChatUser; cookie: string; timeZone: string; threadId: string; guest: boolean };
const turns = new AsyncLocalStorage<Turn>();
const encore = 'http://127.0.0.1:4000';
const bot = new Chat({
  userName: 'cowork',
  adapters: {
    web: createWebAdapter({
      userName: 'cowork',
      persistMessageHistory: false,
      getUser: () => turns.getStore()?.user ?? null,
      threadIdFor: ({ user }) => `web:${user.id}:${turns.getStore()?.threadId || "cowork"}`,
    }),
  },
  state: createMemoryState(),
});

bot.onDirectMessage(async (thread, message) => {
  const turn = turns.getStore();
  if (!turn) throw new Error('Sign in to continue.');
  const response = await fetch(encore + (turn.guest ? '/api/guest/chat' : '/api/chat'), {
    method: 'POST',
    headers: { Cookie: turn.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ Text: message.text, TimeZone: turn.timeZone, ThreadID: turn.threadId }),
    signal: AbortSignal.timeout(185_000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Cowork could not complete the chat request.');
  const messages = turn.guest ? data.messages : turn.threadId
    ? data.workspace.Threads?.find((item: { ID: string }) => item.ID === turn.threadId)?.Messages
    : data.workspace.Messages;
  await thread.post(messages.at(-1).Text);
});

export async function handleWebChat(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== 'POST' || !request.headers['content-type']?.startsWith('application/json')) {
    response.writeHead(405).end('Use a JSON POST.');
    return;
  }
  const cookie = request.headers.cookie ?? '';
  const guest = request.headers['x-cowork-guest'] === '1';
  const auth = await fetch(encore + (guest ? '/api/guest/session' : '/api/chat-session'), {
    headers: { Cookie: cookie },
    signal: AbortSignal.timeout(5_000),
  });
  if (!auth.ok) {
    response.writeHead(auth.status).end('Sign in to continue.');
    return;
  }
  const user: ChatUser = await auth.json();
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > 64 * 1024) {
      response.writeHead(413).end('Chat request is too large.');
      return;
    }
    chunks.push(chunk);
  }
  const header = request.headers['x-cowork-time-zone'];
  const timeZone = typeof header === 'string' ? header : 'UTC';
  const threadId = request.headers['x-cowork-thread'] ?? '';
  if (typeof threadId !== 'string' || (threadId && !/^[a-f0-9]{48}$/.test(threadId))) {
    response.writeHead(400).end('Invalid conversation.');
    return;
  }
  const webRequest = new Request('http://localhost/api/web-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: Buffer.concat(chunks).toString(),
  });
  const result = await turns.run({ user, cookie, timeZone, threadId, guest }, () => bot.webhooks.web(webRequest));
  response.writeHead(result.status, Object.fromEntries(result.headers));
  if (result.body) await pipeline(Readable.from(result.body), response);
  else response.end();
}
