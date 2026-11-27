import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RequestContext } from '@mastra/core/request-context';

test('Slack provisions named apps and routes managed and legacy installs to registered agents', { timeout: 15_000 }, async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'cowork-slack-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const team = 'TWORKSPACE';
  const workspace = 'a'.repeat(48);
  const installs = {
    shared: { app: 'ASHARED', bot: 'UBOTSHARED', token: 'shared-token', secret: 'shared-secret' },
    ada: { app: 'AADA', bot: 'UBOTADA', token: 'ada-token', secret: 'ada-secret' },
  };
  const workspaceAgents = [
    { ID: 'product-manager', Name: 'Nova', Role: 'Product Manager' },
    { ID: 'social-media', Name: 'Atlas', Role: 'Social Media' },
  ];
  const created = new Map<string, {
    app: string; bot: string; token: string; secret: string; name: string; webhook: string; callback: string;
  }>();
  let rotations = 0;
  const posted: (string | undefined)[] = [];
  const sdk = createServer((req, res) => {
    const path = req.url?.split('?')[0];
    const user = { id: 'UMEMBER', team_id: team, real_name: 'Workspace Member' };
    const replies: Record<string, object> = {
      '/users.info': { user },
      '/conversations.history': { messages: [] },
      '/conversations.replies': { messages: [] },
      '/conversations.info': { channel: { name: 'general' } },
      '/chat.postMessage': { ts: '1700000001.000001' },
      '/assistant.threads.setStatus': {},
    };
    if (path === '/chat.postMessage') posted.push(req.headers.authorization);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(path && replies[path] ? { ok: true, ...replies[path] } : { ok: false, error: 'unknown_method' }));
  });
  sdk.listen(0, '127.0.0.1');
  await once(sdk, 'listening');
  t.after(() => { sdk.closeAllConnections(); sdk.close(); });
  const address = sdk.address();
  assert.ok(address && typeof address === 'object');

  Object.assign(process.env, {
    COWORK_STATE_DIR: state, COWORK_PUBLIC_URL: 'https://cowork.example',
    MASTRA_ENCRYPTION_KEY: 'test-encryption-key-for-slack-installations',
    SLACK_API_URL: `http://127.0.0.1:${address.port}/`,
    SLACK_CLIENT_ID: 'shared', SLACK_CLIENT_SECRET: 'secret', SLACK_SIGNING_SECRET: installs.shared.secret, SLACK_APP_ID: installs.shared.app,
    SLACK_ADA_CLIENT_ID: 'ada', SLACK_ADA_CLIENT_SECRET: 'secret', SLACK_ADA_SIGNING_SECRET: installs.ada.secret, SLACK_ADA_APP_ID: installs.ada.app,
  });

  const bridgeCalls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input);
    switch (url.pathname) {
      case '/api/slack-context':
        return Response.json({ id: workspace, role: 'Developer', owner: true, agents: workspaceAgents });
      case '/api/tooling.tokens.rotate':
        rotations++;
        assert.equal((init?.body as URLSearchParams).get('refresh_token'), 'xoxe-1-test');
        return Response.json({ ok: true, team_id: team, token: 'configuration-access', refresh_token: 'xoxe-1-rotated',
          exp: Math.floor(Date.now() / 1000) + 3600 });
      case '/api/apps.manifest.create': {
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer configuration-access');
        const manifest = JSON.parse((init?.body as URLSearchParams).get('manifest')!);
        const name = manifest.display_information.name as string;
        assert.equal(manifest.features.bot_user.display_name, name);
        const client = 'client-' + name;
        const config = {
          name, app: 'A' + name.toUpperCase(), bot: 'UBOT' + name.toUpperCase(), token: 'token-' + name, secret: 'secret-' + name,
          webhook: new URL(manifest.settings.event_subscriptions.request_url).pathname,
          callback: new URL(manifest.oauth_config.redirect_urls[0]).pathname,
        };
        created.set(client, config);
        return Response.json({ ok: true, app_id: config.app, credentials: {
          client_id: client, client_secret: 'client-secret-' + name, signing_secret: config.secret,
        } });
      }
      case '/api/oauth.v2.access': {
        const input = init?.body as URLSearchParams;
        const client = input.get('client_id')!;
        const { app, bot, token } = created.get(client) ?? installs[client as keyof typeof installs];
        return Response.json({ ok: true, app_id: app, bot_user_id: bot, access_token: token, token_type: 'bot',
          team: { id: input.get('code') === 'wrong-team' ? 'TOTHER' : team } });
      }
      case '/api/users.info':
        return Response.json({ ok: true, user: { team_id: team } });
      case '/api/conversations.info':
        return Response.json({ ok: true, channel: { name: 'general', is_channel: true, is_private: false } });
      case '/internal/channel-tools/available': {
        const actor = JSON.parse(String(init?.body));
        return Response.json({ agentID: actor.AgentInstance ?? 'developer' });
      }
      case '/internal/channel-tools/context': {
        const actor = JSON.parse(String(init?.body));
        bridgeCalls.push(actor.Agent);
        assert.equal(actor.WorkspaceID, workspace);
        if (actor.Agent.startsWith('agent:')) {
          const agent = workspaceAgents.find(({ ID }) => ID === actor.AgentInstance);
          assert.ok(agent);
          assert.equal(actor.Agent, 'agent:' + agent.ID);
          return Response.json({ Role: agent.Role, AgentName: agent.Name });
        }
        return Response.json({ Role: 'Developer', AgentName: actor.Agent ? 'Ada' : 'Cowork' });
      }
      case '/internal/channel-tools/slack-message':
        return Response.json({ Sync: true });
      default:
        throw new Error('Unexpected request to ' + url.pathname);
    }
  });

  const { mastra } = await import('./index.ts');
  const { developer } = await import('./agents/index.ts');
  const { createSlackHandler } = await import('./slack.ts');
  const handler = createSlackHandler(mastra, true);
  const canonical = '/api/agents/developer/channels/slack/webhook';
  assert.equal(mastra.getAgent('Developer'), developer);
  assert.equal(developer.getChannels()?.getWebhookRoutes()[0]?.path, canonical);
  assert.ok(Object.hasOwn(await developer.listTools(), 'scheduleTask'));

  const turns: Promise<unknown>[] = [];
  const modelCalls: string[] = [];
  t.mock.method(developer, 'stream', async (prompt: string, { requestContext }: { requestContext: RequestContext }) => {
    const tools = await developer.listTools({ requestContext });
    assert.deepEqual(Object.keys(tools), ['createTask']);
    modelCalls.push(prompt);
    return { text: Promise.resolve('Cowork reply'), fullStream: [] };
  });

  const request = (path: string, options?: RequestInit) => new Request('https://cowork.example' + path, options);
  const send = async (path: string, payload: object, secret: string, time = Math.floor(Date.now() / 1000)) => {
    const body = JSON.stringify(payload);
    const signature = createHmac('sha256', secret).update(`v0:${time}:${body}`).digest('hex');
    return handler(request(path, {
      method: 'POST', body,
      headers: { 'Content-Type': 'application/json', 'x-slack-request-timestamp': String(time), 'x-slack-signature': 'v0=' + signature },
    }));
  };

  const challenge = { type: 'url_verification', challenge: 'slack-challenge' };
  assert.equal((await send(canonical, challenge, installs.shared.secret)).status, 401);
  assert.equal((await send(canonical, challenge, installs.ada.secret, 1)).status, 401);
  const verified = await send(canonical, challenge, installs.ada.secret);
  assert.equal(verified.status, 200);
  assert.equal(await verified.text(), challenge.challenge);

  for (const slug of ['', '/ada']) {
    const started = await handler(request('/api/slack' + slug, {
      method: 'POST', body: '{"action":"connect"}', headers: { 'Content-Type': 'application/json' },
    }));
    assert.equal(started.status, 200);
    const cookie = started.headers.get('Set-Cookie')?.split(';')[0];
    assert.ok(cookie);
    const { authorizationUrl } = await started.json();
    const nonce = new URL(authorizationUrl).searchParams.get('state');
    const callback = await handler(request(`/integrations/slack${slug}/oauth/callback?code=test&state=${nonce}`, {
      headers: { Cookie: cookie },
    }));
    assert.match(callback.headers.get('Location') ?? '', /slack=connected/);
  }

  // Capture background work so assertions run after both installations have replied.
  const channels = developer.getChannels()!;
  const handleWebhookEvent = channels.handleWebhookEvent.bind(channels);
  t.mock.method(channels, 'handleWebhookEvent', (platform: string, req: Request, options?: { waitUntil?: (task: Promise<unknown>) => void }) =>
    handleWebhookEvent(platform, req, { waitUntil: (task) => {
      turns.push(task);
      options?.waitUntil?.(task);
    } }));

  const event = ({ app, bot }: typeof installs.ada) => ({
    type: 'event_callback', api_app_id: app, team_id: team, event_id: 'E' + app,
    authorizations: [{ team_id: team, user_id: bot, is_bot: true }],
    event: { type: 'app_mention', user: 'UMEMBER', text: `<@${bot}> Hello from Slack`, channel: 'CGENERAL', ts: '1700000000.000001' },
  });
  const results = await Promise.all([
    send('/integrations/slack/events', event(installs.shared), installs.shared.secret),
    send(canonical, event(installs.ada), installs.ada.secret),
  ]);
  assert.deepEqual(results.map(({ status }) => status), [200, 200]);
  await Promise.all(turns);
  assert.deepEqual(bridgeCalls.sort(), ['', 'ada']);
  assert.equal(modelCalls.length, 2);
  assert.ok(modelCalls.every((prompt) => prompt.includes('Hello from Slack')));
  assert.deepEqual(posted.sort(), ['Bearer ada-token', 'Bearer shared-token']);

  for (const [index, agent] of workspaceAgents.entries()) {
    const endpoint = '/api/slack/agents/' + agent.ID;
    const initial = await (await handler(request(endpoint))).json();
    assert.equal(initial.needsToken, index === 0);
    const start = async (refreshToken?: string) => {
      const started = await handler(request(endpoint, {
        method: 'POST', body: JSON.stringify({ action: 'connect', refreshToken }), headers: { 'Content-Type': 'application/json' },
      }));
      const result = await started.json();
      assert.equal(started.status, 200, JSON.stringify(result));
      const cookie = started.headers.get('Set-Cookie')?.split(';')[0];
      assert.ok(cookie);
      const authorization = new URL(result.authorizationUrl);
      assert.equal(authorization.searchParams.get('team'), team);
      const app = created.get(authorization.searchParams.get('client_id')!)!;
      assert.equal(app.name, agent.Name);
      const state = authorization.searchParams.get('state');
      return { app, callback: (code: string) => handler(request(app.callback + '?code=' + code + '&state=' + state, {
        headers: { Cookie: cookie },
      })) };
    };
    let pending = await start(index === 0 ? 'xoxe-1-test' : undefined);
    if (!index) {
      const conflict = await pending.callback('wrong-team');
      assert.match(conflict.headers.get('Location') ?? '', /slack=conflict/);
      pending = await start();
      assert.equal(created.size, 1);
    }
    assert.equal((await send(pending.app.webhook, challenge, installs.ada.secret)).status, 401);
    assert.equal(await (await send(pending.app.webhook, challenge, pending.app.secret)).text(), challenge.challenge);
    const callback = await pending.callback('test');
    assert.match(callback.headers.get('Location') ?? '', /slack=connected/);
    const status = await (await handler(request(endpoint))).json();
    assert.equal(status.name, agent.Name);
    assert.equal(status.appId, pending.app.app);
    assert.equal(status.needsVerification, false);
    const registered = mastra.getAgent(agent.Role);
    const registeredChannels = registered.getChannels()!;
    const webhook = registeredChannels.handleWebhookEvent.bind(registeredChannels);
    t.mock.method(registeredChannels, 'handleWebhookEvent', (platform: string, req: Request) =>
      webhook(platform, req, { waitUntil: (task) => { turns.push(task); } }));
    t.mock.method(registered, 'stream', async (prompt: string) => {
      modelCalls.push(agent.ID + ': ' + prompt);
      return { text: Promise.resolve(agent.Name + ' reply'), fullStream: [] };
    });
    assert.equal((await send(pending.app.webhook, event(pending.app), pending.app.secret)).status, 200);
    await Promise.all(turns);
    assert.equal(posted.at(-1), 'Bearer ' + pending.app.token);
    assert.match(modelCalls.at(-1) ?? '', new RegExp('^' + agent.ID));
  }
  assert.equal(rotations, 1);
  assert.equal(created.size, 2);
});
