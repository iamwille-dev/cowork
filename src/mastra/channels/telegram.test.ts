import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('Telegram webhooks reach the registered agent and use the correct bot installation', { timeout: 15_000 }, async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'cowork-telegram-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  process.env.COWORK_STATE_DIR = state;
  process.env.COWORK_TELEGRAM_BRIDGE_SECRET = 'test-telegram-bridge';
  const installs = ['a', 'b'].map((id) => ({
    WorkspaceID: id.repeat(48), Agent: 'agent:social-media', Role: 'Social Media', Version: id.repeat(48),
    Username: id + '_cowork_bot', Token: id + '-token',
  }));
  const chat = { id: -100123, type: 'supergroup', title: 'Project group' };
  const botAPICalls: { token: string; method: string; target?: string; text?: string }[] = [];
  const bridgeCalls: Record<string, unknown>[] = [];
  const linkCalls: Record<string, unknown>[] = [];
  let installationLookups = 0;
  const turns: Promise<unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    if (url.pathname === '/internal/telegram/installation') {
      installationLookups++;
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-telegram-bridge');
      const result = installs.find(({ Version }) => Version === url.searchParams.get('version'));
      return result ? Response.json(result) : new Response(null, { status: 404 });
    }
    if (url.pathname === '/internal/telegram/link') {
      linkCalls.push(JSON.parse(String(init?.body)));
      return Response.json({ linked: true });
    }
    if (url.pathname === '/internal/telegram/message') {
      const payload = JSON.parse(String(init?.body));
      bridgeCalls.push(payload);
      return Response.json({ reply: payload.Reply ? '**Cowork reply**' : '' });
    }
    if (url.hostname === 'api.telegram.org') {
      const [, bot, method] = url.pathname.split('/');
      const token = bot.slice(3);
      const install = installs.find(({ Token }) => Token === token);
      assert.ok(install);
      if (method === 'getMe') {
        return Response.json({ ok: true, result: { id: 50 + installs.indexOf(install), is_bot: true, first_name: 'Cowork', username: install.Username } });
      }
      const body = JSON.parse(String(init?.body));
      botAPICalls.push({ token, method, target: String(body.chat_id), text: body.rich_message?.markdown ?? body.text });
      assert.ok(method === 'sendRichMessage' || method === 'sendMessage');
      return Response.json({ ok: true, result: { chat, message_id: 500, date: 1_700_000_000, text: 'Cowork reply' } });
    }
    throw new Error('Unexpected request to ' + url.hostname + url.pathname);
  });

  const { mastra } = await import('../index.ts');
  const { createTelegramHandler } = await import('./telegram.ts');
  const registered = mastra.getAgent('Social Media');
  const channels = registered.getChannels()!;
  assert.ok(channels.hasAdapter('telegram'));
  for (const agent of Object.values(mastra.listAgents())) assert.ok(agent.getChannels()?.hasAdapter('telegram'));
  assert.ok(channels.getWebhookRoutes().some(({ path }) => path === '/api/agents/social-media/channels/telegram/webhook'));
  const dispatch = channels.handleWebhookEvent.bind(channels);
  t.mock.method(channels, 'handleWebhookEvent', (...[platform, request, options]: Parameters<typeof dispatch>) =>
    dispatch(platform, request, { waitUntil(turn) {
      turns.push(turn);
      options?.waitUntil?.(turn);
    } }));
  const handler = createTelegramHandler(mastra);
  const send = (install: typeof installs[number], text: string, messageId: number, valid = true, role = 'social-media') => {
    const secret = createHmac('sha256', 'test-telegram-bridge').update('cowork-telegram-webhook\0' + install.Version).digest('hex');
    const command = text.startsWith('/') ? text.split(' ')[0] : undefined;
    return handler(new Request(`https://cowork.example/api/agents/${role}/channels/telegram/webhook?installation=${install.Version}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-telegram-bot-api-secret-token': valid ? secret : '0'.repeat(64) },
      body: JSON.stringify({ update_id: messageId, message: {
        message_id: messageId, chat, from: { id: 10, is_bot: false, first_name: 'Participant' },
        date: 1_700_000_000, text, entities: command ? [{ type: 'bot_command', offset: 0, length: command.length }] : [],
      } }),
    }));
  };
  assert.equal((await send(installs[0], 'Reject', 1, false)).status, 401);
  assert.equal(installationLookups, 0);
  assert.equal((await send(installs[0], 'Wrong role', 2, true, 'developer')).status, 404);
  const code = 'c'.repeat(48);
  assert.equal((await send(installs[0], '/start@a_cowork_bot ' + code, 3)).status, 200);
  assert.equal((await send(installs[0], '/ask@a_cowork_bot Review the brief', 4)).status, 200);
  assert.equal((await send(installs[1], '/ask@b_cowork_bot Check the draft', 4)).status, 200);
  assert.equal((await send(installs[0], 'Discussion in the linked group', 5)).status, 200);
  await Promise.all(turns);
  assert.equal(linkCalls.length, 1);
  assert.deepEqual(linkCalls[0], { WorkspaceID: installs[0].WorkspaceID, Agent: installs[0].Agent, Version: installs[0].Version,
    Code: code, ChatID: String(chat.id), Title: chat.title });
  assert.deepEqual(bridgeCalls.map(({ WorkspaceID, Text, Reply, Agent }) => [WorkspaceID, Text, Reply, Agent]).sort(), [
    [installs[0].WorkspaceID, 'Discussion in the linked group', false, installs[0].Agent],
    [installs[0].WorkspaceID, 'Review the brief', true, installs[0].Agent],
    [installs[1].WorkspaceID, 'Check the draft', true, installs[1].Agent],
  ]);
  assert.deepEqual(botAPICalls.map(({ token, target, method }) => [token, target, method]).sort(), [
    ['a-token', '-100123', 'sendMessage'],
    ['a-token', '-100123', 'sendRichMessage'],
    ['b-token', '-100123', 'sendRichMessage'],
  ]);
});
