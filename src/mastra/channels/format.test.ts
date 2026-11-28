import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTelegramAdapter } from '@mastra/telegram';
import { normalizeChannelReply } from './format.ts';

test('unwraps an accidental prose fence while preserving real code fences', () => {
  const tasks = "Here's what's on the board:\n\n1. **Get Mails** — Assigned";
  assert.equal(normalizeChannelReply('```vbnet\n' + tasks + '\n```'), tasks);
  const code = '```vbnet\nDim status As String = "Assigned"\nConsole.WriteLine(status)\n```';
  assert.equal(normalizeChannelReply(code), code);
  const mixed = tasks + '\n\n' + code;
  assert.equal(normalizeChannelReply(mixed), mixed);
});

test('Telegram sends rich Markdown with a MarkdownV2 fallback', async (t) => {
  const calls: { method: string; body: { text?: string; parse_mode?: string; rich_message?: { markdown: string } } }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const method = new URL(url).pathname.split('/').at(-1) ?? '';
    const body = JSON.parse(String(init.body));
    calls.push({ method, body });
    if (method === 'sendRichMessage') {
      return Response.json({ ok: false, error_code: 404, description: 'Not Found' }, { status: 404 });
    }
    assert.equal(method, 'sendMessage');
    return Response.json({ ok: true, result: {
      chat: { id: -100123, type: 'supergroup' }, message_id: 1, date: 1_700_000_000, text: body.text,
    } });
  });
  const adapter = createTelegramAdapter({ botToken: 'test-token', apiBaseUrl: 'https://telegram.example' });
  const markdown = '1. **Get Mails** — Assigned.\n2. See `next.config.mjs`.';
  await adapter.postMessage('telegram:-100123', { markdown });
  assert.deepEqual(calls.map(({ method }) => method), ['sendRichMessage', 'sendMessage']);
  assert.equal(calls[0]?.body.rich_message?.markdown, markdown);
  assert.equal(calls[1]?.body.parse_mode, 'MarkdownV2');
  assert.match(calls[1]?.body.text ?? '', /1\\\. \*Get Mails\* — Assigned\\\./);
  assert.match(calls[1]?.body.text ?? '', /`next\.config\.mjs`/);
});
