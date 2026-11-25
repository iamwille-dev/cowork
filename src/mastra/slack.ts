import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createClient } from '@libsql/client';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { createSlackAdapter, verifySlackRequest } from '@mastra/slack';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { liveModel, model, roleInstructions } from './agents/index.ts';

const app = new Hono();
const callbackPath = '/integrations/slack/oauth/callback';
const eventsPath = '/integrations/slack/events';
const settingsPath = '/settings?section=channels';
const cookieName = 'cowork_slack_state';
const cookieOptions = { path: callbackPath, secure: true, httpOnly: true, sameSite: 'Lax' } as const;
const oauthLifetime = 15 * 60;
const scopes = 'app_mentions:read,chat:write,channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read';

type Role = keyof typeof roleInstructions;
type OAuthResult = {
  access_token?: string; token_type?: string; bot_user_id?: string;
  app_id?: string; team?: { id?: string; name?: string }; is_enterprise_install?: boolean;
};

function configuration() {
  const clientId = process.env.SLACK_CLIENT_ID?.trim();
  const clientSecret = process.env.SLACK_CLIENT_SECRET?.trim();
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
  const appId = process.env.SLACK_APP_ID?.trim();
  const secret = process.env.MASTRA_ENCRYPTION_KEY?.trim();
  const publicUrl = URL.parse(process.env.COWORK_PUBLIC_URL ?? '');
  if (!clientId || !clientSecret || !signingSecret || !appId || !secret || secret.length < 32 ||
      publicUrl?.protocol !== 'https:' || publicUrl.username || publicUrl.password) return;
  return {
    clientId, clientSecret, signingSecret, appId,
    callbackUrl: publicUrl.origin + callbackPath,
    encryptionKey: createHash('sha256').update('cowork-slack-oauth\0').update(secret).digest(),
  };
}

const config = configuration();
app.use('/api/slack', bodyLimit({ maxSize: 4096 }));
if (config) createIntegration(config);

function createIntegration(settings: NonNullable<typeof config>) {
  const url = `file:${resolve('backend/.cowork/slack-oauth.db')}`;
  const db = createClient({ url });
  const storage = new LibSQLStore({ id: 'cowork-slack', url });
  const mastra = new Mastra({ storage });
  const memory = new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } });
  const channels = new Map<string, ReturnType<typeof createChannels>>();
  const changes = new Set<string>();
  let ready: Promise<unknown> | undefined;
  function initialize() {
    ready ??= db.batch([
      `CREATE TABLE IF NOT EXISTS cowork_slack_installations (
        workspace TEXT PRIMARY KEY, team_id TEXT UNIQUE NOT NULL, team_name TEXT NOT NULL,
        bot_user TEXT NOT NULL, bot_token TEXT NOT NULL, role TEXT NOT NULL,
        installation_id TEXT NOT NULL, installed_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS cowork_slack_oauth (
        workspace TEXT PRIMARY KEY, nonce TEXT UNIQUE NOT NULL, role TEXT NOT NULL, expires INTEGER NOT NULL
      )`,
    ], 'write').catch((error: unknown) => { ready = undefined; throw error; });
    return ready;
  }

  function encrypt(token: string, id: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', settings.encryptionKey, iv);
    cipher.setAAD(Buffer.from(id));
    const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }

  function decrypt(encrypted: string, id: string) {
    const bytes = Buffer.from(encrypted, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', settings.encryptionKey, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from(id));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }

  async function slackApi<T>(method: string, data: Record<string, string>, token?: string) {
    const response = await fetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: token ? { Authorization: 'Bearer ' + token } : undefined,
      body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, ...data }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Slack API unavailable.');
    return await response.json() as T & { ok?: boolean; error?: string };
  }

  async function createChannels(id: string, botUser: string, token: string, role: Role) {
    const agent = new Agent({
      id: 'cowork-slack-' + id,
      name: 'Cowork',
      model,
      memory,
      instructions: `You are the Slack workspace’s ${role} coworker. ${roleInstructions[role]} Keep replies concise and use the current Slack conversation for context.`,
      channels: {
        adapters: { slack: { adapter: createSlackAdapter({ botToken: token, botUserId: botUser, signingSecret: settings.signingSecret, userName: 'Cowork' }), streaming: false } },
        tools: false,
        inlineLinks: [],
        inlineMedia: [],
        handlers: { onMessage: false, onSlashCommand: false, onAction: false },
      },
    });
    const instance = agent.getChannels()!;
    await instance.initialize(mastra);
    return instance;
  }

  async function forget(id: string) {
    const channel = channels.get(id);
    channels.delete(id);
    if (channel) await (await channel).close();
  }

  app.on(['GET', 'POST'], '/api/slack', async (c) => {
    c.header('Cache-Control', 'no-store');
    const workspace = await slackWorkspace(c.req.header('cookie'));
    if (workspace instanceof Response) return workspace;
    await initialize();
    if (c.req.method === 'GET') {
      const { rows: [row] } = await db.execute({
        sql: 'SELECT team_id, team_name FROM cowork_slack_installations WHERE workspace = ?', args: [workspace.id],
      });
      return c.json(row
        ? { available: liveModel, status: 'active', team: row.team_name, teamId: row.team_id, appId: settings.appId }
        : { available: liveModel, status: 'disconnected' });
    }
    if (!workspace.owner) return c.json({ error: 'Workspace owner access required.' }, 403);
    if (c.req.header('content-type')?.split(';', 1)[0] !== 'application/json') return c.json({ error: 'Invalid request.' }, 415);
    const input = await c.req.json<{ action?: string } | null>().catch(() => null);
    if (input?.action !== 'connect' && input?.action !== 'disconnect') return c.json({ error: 'Invalid Slack action.' }, 400);
    if (changes.has(workspace.id)) return c.json({ error: 'A Slack update is in progress. Try again shortly.' }, 409);
    changes.add(workspace.id);
    try {
      const { rows: [row] } = await db.execute({
        sql: 'SELECT installation_id, bot_token FROM cowork_slack_installations WHERE workspace = ?', args: [workspace.id],
      });
      if (input.action === 'disconnect') {
        await db.execute({ sql: 'DELETE FROM cowork_slack_oauth WHERE workspace = ?', args: [workspace.id] });
        if (row) {
          const id = String(row.installation_id);
          const result = await slackApi('apps.uninstall', {}, decrypt(String(row.bot_token), id));
          if (!result.ok && !['token_revoked', 'account_inactive', 'invalid_auth', 'not_authed'].includes(result.error ?? '')) {
            return c.json({ error: 'Slack could not remove Cowork. Try again or remove Cowork in Slack.' }, 502);
          }
          await db.execute({ sql: 'DELETE FROM cowork_slack_installations WHERE installation_id = ?', args: [id] });
          await forget(id);
        }
        return c.json({ available: liveModel, status: 'disconnected' });
      }
      if (row) return c.json({ error: 'Slack is already connected.' }, 409);
      if (!liveModel) return c.json({ error: 'The Cowork agent is unavailable on this deployment.' }, 503);
      const nonce = randomBytes(32).toString('hex');
      await db.batch([
        { sql: 'DELETE FROM cowork_slack_oauth WHERE expires <= ?', args: [Date.now()] },
        { sql: 'INSERT OR REPLACE INTO cowork_slack_oauth VALUES (?, ?, ?, ?)',
          args: [workspace.id, nonce, workspace.role, Date.now() + oauthLifetime * 1000] },
      ], 'write');
      const query = new URLSearchParams({ client_id: settings.clientId, scope: scopes, redirect_uri: settings.callbackUrl, state: nonce });
      setCookie(c, cookieName, nonce, { ...cookieOptions, maxAge: oauthLifetime });
      return c.json({ authorizationUrl: 'https://slack.com/oauth/v2/authorize?' + query });
    } finally {
      changes.delete(workspace.id);
    }
  });

  app.get(callbackPath, async (c) => {
    c.header('Cache-Control', 'no-store');
    const finish = (outcome: string) => c.redirect(settingsPath + '&slack=' + outcome, 303);
    const state = c.req.query('state');
    if (!state || state !== getCookie(c, cookieName)) return finish('retry');
    deleteCookie(c, cookieName, cookieOptions);
    await initialize();
    const { rows: [pending] } = await db.execute({
      sql: 'DELETE FROM cowork_slack_oauth WHERE nonce = ? AND expires > ? RETURNING workspace, role', args: [state, Date.now()],
    });
    if (!pending) return finish('retry');
    if (c.req.query('error') === 'access_denied') return finish('canceled');
    const code = c.req.query('code');
    const workspace = String(pending.workspace);
    if (!code || changes.has(workspace)) return finish('retry');
    changes.add(workspace);
    try {
      const result = await slackApi<OAuthResult>('oauth.v2.access', { code, redirect_uri: settings.callbackUrl });
      if (!result.ok || result.app_id !== settings.appId || result.is_enterprise_install ||
          !result.team?.id || !result.access_token || result.token_type !== 'bot' || !result.bot_user_id) return finish('retry');
      const id = randomBytes(24).toString('hex');
      const saved = await db.execute({
        sql: 'INSERT INTO cowork_slack_installations VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
        args: [workspace, result.team.id, result.team.name || result.team.id, result.bot_user_id,
          encrypt(result.access_token, id), pending.role, id, Date.now()],
      });
      return finish(saved.rowsAffected ? 'connected' : 'conflict');
    } finally {
      changes.delete(workspace);
    }
  });

  app.post(eventsPath, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const body = await c.req.text();
    const timestamp = c.req.header('x-slack-request-timestamp') ?? '';
    const signature = c.req.header('x-slack-signature') ?? '';
    if (!/^\d{10}$/.test(timestamp) || !verifySlackRequest({ signingSecret: settings.signingSecret, timestamp, signature, body })) {
      return c.json({ error: 'Invalid Slack signature.' }, 401);
    }
    const payload = JSON.parse(body) as {
      type: string; challenge?: string; team_id?: string; api_app_id?: string;
      event_time?: number; event?: { type?: string };
    };
    if (payload?.type === 'url_verification' && typeof payload.challenge === 'string') return c.json({ challenge: payload.challenge });
    if (payload?.type !== 'event_callback' || payload.api_app_id !== settings.appId || !payload.team_id) return c.json({ ok: true });
    await initialize();
    const { rows: [row] } = await db.execute({
      sql: 'SELECT * FROM cowork_slack_installations WHERE team_id = ?', args: [payload.team_id],
    });
    if (!row) return c.json({ ok: true });
    const id = String(row.installation_id);
    if (payload.event?.type === 'app_uninstalled') {
      if (Number(row.installed_at) < (Number(payload.event_time) + 1) * 1000) {
        await db.execute({ sql: 'DELETE FROM cowork_slack_installations WHERE installation_id = ?', args: [id] });
        await forget(id);
      }
      return c.json({ ok: true });
    }
    if (!liveModel) return c.json({ ok: true });
    let channel = channels.get(id);
    if (!channel) {
      channel = createChannels(id, String(row.bot_user), decrypt(String(row.bot_token), id), row.role as Role)
        .catch((error: unknown) => { channels.delete(id); throw error; });
      channels.set(id, channel);
    }
    return (await channel).handleWebhookEvent('slack', new Request(c.req.url, {
      method: 'POST', headers: c.req.raw.headers, body,
    }), { waitUntil: (task) => { void task.catch(() => console.error('Cowork could not process a Slack event.')); } });
  });

}

if (!config) {
  app.get('/api/slack', async (c) => {
    c.header('Cache-Control', 'no-store');
    const workspace = await slackWorkspace(c.req.header('cookie'));
    return workspace instanceof Response ? workspace : c.json({ available: false, status: 'disconnected' });
  });
}

async function slackWorkspace(cookie?: string) {
  const response = await fetch('http://127.0.0.1:4000/api/slack-context', {
    headers: { Cookie: cookie ?? '' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  const workspace = await response.json() as { id: string; role: Role; owner: boolean };
  if (!/^[a-f0-9]{48}$/.test(workspace.id) || !Object.hasOwn(roleInstructions, workspace.role)) throw new Error('Invalid workspace.');
  return workspace;
}

app.onError((_error, c) => {
  console.error('Cowork Slack integration request failed.');
  return c.req.path === callbackPath
    ? c.redirect(settingsPath + '&slack=retry', 303)
    : c.json({ error: 'Cowork could not complete the Slack request. Try again shortly.' }, 502);
});

export const handleSlack = app.fetch;
