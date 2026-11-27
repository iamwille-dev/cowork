import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { coworkStateDir } from '../state.ts';
import { createClient } from '@libsql/client';
import type { ChannelHandler } from '@mastra/core/channels';
import { respondFromChannel, saveSlackMessage, type ChannelActor } from './channel-tools.ts';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { createSlackAdapter, verifySlackRequest } from '@mastra/slack';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { channelAgents, channelAgentIds, type ChannelAgent } from '../channel-agents.ts';
import { liveModel, model, roleInstructions } from './agents/index.ts';

const app = new Hono();
const settingsPath = '/settings?section=channels';
const callbackSuffix = '/oauth/callback';
const cookieName = 'cowork_slack_state';
const oauthLifetime = 15 * 60;
const scopes = [
  'app_mentions:read', 'chat:write', 'channels:history', 'channels:read', 'groups:history', 'groups:read',
  'im:history', 'im:read', 'mpim:history', 'mpim:read', 'users:read',
  ...(process.env.COWORK_SLACK_CUSTOM_NAMES === '1' ? ['chat:write.customize'] : []),
].join(',');

type Role = keyof typeof roleInstructions;
type OAuthResult = {
  access_token?: string; token_type?: string; bot_user_id?: string;
  app_id?: string; team?: { id?: string; name?: string }; is_enterprise_install?: boolean;
};

function configuration(agent: ChannelAgent | '') {
  const prefix = agent ? `SLACK_${agent.toUpperCase()}_` : 'SLACK_';
  const clientId = process.env[prefix + 'CLIENT_ID']?.trim();
  const clientSecret = process.env[prefix + 'CLIENT_SECRET']?.trim();
  const signingSecret = process.env[prefix + 'SIGNING_SECRET']?.trim();
  const appId = process.env[prefix + 'APP_ID']?.trim();
  const secret = process.env.MASTRA_ENCRYPTION_KEY?.trim();
  const publicUrl = URL.parse(process.env.COWORK_PUBLIC_URL ?? '');
  if (!clientId || !clientSecret || !signingSecret || !appId || !secret || secret.length < 32 ||
      publicUrl?.protocol !== 'https:' || publicUrl.username || publicUrl.password) return;
  return {
    clientId, clientSecret, signingSecret, appId,
    callbackUrl: publicUrl.origin + eventBase(agent) + callbackSuffix,
    agent,
    name: agent ? channelAgents[agent].name : 'Cowork',
    encryptionKey: createHash('sha256').update('cowork-slack-oauth\0').update(secret).digest(),
  };
}

function eventBase(agent: ChannelAgent | '') {
  return '/integrations/slack' + (agent ? '/' + agent : '');
}

const url = `file:${resolve(coworkStateDir, 'slack-oauth.db')}`;
const db = createClient({ url });
const storage = new LibSQLStore({ id: 'cowork-slack', url });
const mastra = new Mastra({ storage });
const memory = new Memory({ storage, options: { lastMessages: 20, semanticRecall: false } });
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
    `CREATE TABLE IF NOT EXISTS cowork_slack_agent_installations (
      agent TEXT NOT NULL, workspace TEXT NOT NULL, team_id TEXT NOT NULL, team_name TEXT NOT NULL,
      bot_user TEXT NOT NULL, bot_token TEXT NOT NULL, role TEXT NOT NULL,
      installation_id TEXT UNIQUE NOT NULL, installed_at INTEGER NOT NULL,
      PRIMARY KEY (agent, workspace), UNIQUE (agent, team_id)
    )`,
    `CREATE TABLE IF NOT EXISTS cowork_slack_agent_oauth (
      agent TEXT NOT NULL, workspace TEXT NOT NULL, nonce TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY (agent, workspace)
    )`,
    'CREATE TABLE IF NOT EXISTS cowork_slack_migrations (version INTEGER PRIMARY KEY)',
    `INSERT OR IGNORE INTO cowork_slack_agent_installations
      SELECT '', workspace, team_id, team_name, bot_user, bot_token, role, installation_id, installed_at
      FROM cowork_slack_installations WHERE NOT EXISTS (SELECT 1 FROM cowork_slack_migrations WHERE version = 1)`,
    `INSERT OR IGNORE INTO cowork_slack_agent_oauth
      SELECT '', workspace, nonce, role, expires FROM cowork_slack_oauth
      WHERE NOT EXISTS (SELECT 1 FROM cowork_slack_migrations WHERE version = 1)`,
    'DELETE FROM cowork_slack_installations WHERE NOT EXISTS (SELECT 1 FROM cowork_slack_migrations WHERE version = 1)',
    'DELETE FROM cowork_slack_oauth WHERE NOT EXISTS (SELECT 1 FROM cowork_slack_migrations WHERE version = 1)',
    'INSERT OR IGNORE INTO cowork_slack_migrations VALUES (1)',
  ], 'write').catch((error: unknown) => { ready = undefined; throw error; });
  return ready;
}

const registeredApps = new Set<string>();
for (const agent of ['', ...channelAgentIds] as const) {
  const apiPath = '/api/slack' + (agent ? '/' + agent : '');
  app.use(apiPath, bodyLimit({ maxSize: 4096 }));
  const config = configuration(agent);
  if (config && !registeredApps.has(config.appId)) {
    registeredApps.add(config.appId);
    createIntegration(config, apiPath);
    continue;
  }
  app.get(apiPath, async (c) => {
    c.header('Cache-Control', 'no-store');
    const workspace = await slackWorkspace(c.req.header('cookie'));
    return workspace instanceof Response ? workspace : c.json({ available: false, status: 'disconnected' });
  });
}

function createIntegration(settings: NonNullable<ReturnType<typeof configuration>>, apiPath: string) {
  const agentId = settings.agent;
  const callbackPath = eventBase(agentId) + callbackSuffix;
  const eventsPath = eventBase(agentId) + '/events';
  const cookieOptions = { path: callbackPath, secure: true, httpOnly: true, sameSite: 'Lax' } as const;
  const returnURL = settingsPath + (agentId ? '&agent=' + agentId : '');
  const channels = new Map<string, ReturnType<typeof createChannels>>();
  const changes = new Set<string>();

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

  async function createChannels(id: string, botUser: string, token: string, role: Role, workspace: string, team: string) {
    const installationActive = async () => {
      const { rows } = await db.execute({
        sql: 'SELECT 1 FROM cowork_slack_agent_installations WHERE installation_id = ? AND workspace = ? AND team_id = ? AND agent = ?',
        args: [id, workspace, team, agentId],
      });
      return rows.length > 0;
    };
    const replyContext = new AsyncLocalStorage<{ source: 'mention' | 'dm' | 'thread'; messageId: string; threadId: string }>();
    const adapter = createSlackAdapter({ botToken: token, botUserId: botUser, signingSecret: settings.signingSecret, userName: settings.name });
    const postMessage = adapter.postMessage.bind(adapter);
    const log = (event: string, fields: object) => {
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, agent: agentId || 'cowork', teamId: team, ...fields }));
    };
    adapter.postMessage = async (...args) => {
      const sent = await postMessage(...args);
      const source = replyContext.getStore();
      if (source) log('slack.reply.sent', { ...source, replyId: sent.id });
      return sent;
    };
    const handle: ChannelHandler = async (thread, message, defaultHandler) => {
      // Slack Connect and external guests cannot use the linked workspace's tools.
      const userResponse = await fetch('https://slack.com/api/users.info?' + new URLSearchParams({ user: message.author.userId }), {
        headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      const identity = await userResponse?.json().catch(() => undefined) as {
        ok?: boolean; user?: { team_id?: string; team?: string; is_stranger?: boolean; is_external?: boolean; suspended?: boolean; is_bot?: boolean; is_restricted?: boolean; is_ultra_restricted?: boolean; deleted?: boolean };
      } | undefined;
      const user = identity?.user;
      if (!identity?.ok || !user || (user.team_id ?? user.team) !== team || user.is_stranger ||
          user.is_external || user.suspended || user.is_bot || user.is_restricted || user.is_ultra_restricted || user.deleted) {
        if (!agentId || message.isMention || thread.isDM) await defaultHandler(thread, message);
        return;
      }
      const actor: ChannelActor = {
        WorkspaceID: workspace, Channel: 'slack', Agent: agentId, Installation: id, Conversation: thread.id,
        SenderID: message.author.userId, Author: message.author.fullName || message.author.userName,
      };
      const { channel, threadTs } = adapter.decodeThreadId(thread.id);
      const passive = Boolean(agentId && replyContext.getStore()?.source !== 'mention' && !thread.isDM);
      let mirrored: Awaited<ReturnType<typeof saveSlackMessage>> | undefined;
      if (agentId && channel.startsWith('C') && threadTs) {
        const channelResponse = await fetch('https://slack.com/api/conversations.info?' + new URLSearchParams({ channel }), {
          headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(4000),
        }).catch(() => undefined);
        const channelInfo = await channelResponse?.json().catch(() => undefined) as { ok?: boolean; channel?: {
          name?: string; is_channel?: boolean; is_private?: boolean; is_ext_shared?: boolean; is_org_shared?: boolean; is_shared?: boolean;
        } } | undefined;
        const details = channelInfo?.channel;
        if (channelInfo?.ok && details?.is_channel && details.is_private === false && !details.is_ext_shared && !details.is_org_shared && !details.is_shared && await installationActive()) {
          mirrored = await saveSlackMessage(actor, {
            ID: message.id, Title: details.name ? '#' + details.name : undefined,
            Text: message.text.slice(0, 4000), At: message.metadata.dateSent.toISOString(),
          });
        }
      }
      if (mirrored?.Duplicate || passive) return;

      await thread.refresh().catch(() => undefined);
      const history = thread.recentMessages.filter((item) => item.id !== message.id && item.text.trim())
        .sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime()).slice(-23);
      const messages = [...history, message].map((item) => ({
        Author: item.author.fullName || item.author.userName,
        Text: item.text.slice(0, 4000),
        SenderID: item.author.userId,
      }));
      let name = settings.name;
      try {
        const reply = await respondFromChannel(actor, mirrored?.Messages ?? messages, installationActive, async (status, displayName) => {
          name = displayName;
          await thread.startTyping(status).catch(() => undefined);
        });
        if (reply && await installationActive()) {
          let replyId: string | undefined;
          if (name !== settings.name) {
            const response = await fetch('https://slack.com/api/chat.postMessage', {
              method: 'POST', headers: { Authorization: 'Bearer ' + token },
              body: new URLSearchParams({
                channel, ...(threadTs && { thread_ts: threadTs }), text: reply, username: name,
                unfurl_links: 'false', unfurl_media: 'false',
              }),
              signal: AbortSignal.timeout(10_000),
            });
            const posted = await response.json() as { ok?: boolean; ts?: string; error?: string };
            if (posted.ok && posted.ts) replyId = posted.ts;
            else if (posted.error !== 'missing_scope') throw new Error('Slack could not post the reply.');
          }
          replyId ??= (await thread.post(reply)).id;
          if (mirrored?.Sync) {
            await saveSlackMessage(actor, { ID: replyId, Text: reply.slice(0, 12000), At: new Date().toISOString(), Reply: true });
          }
          if (!thread.isDM && (!agentId || mirrored?.Sync)) await thread.subscribe();
        }
      } finally {
        await thread.startTyping('').catch(() => undefined);
      }
    };
    const route = (source: 'mention' | 'dm' | 'thread'): ChannelHandler => async (thread, message, fallback, context) => {
      if (message.author.isBot === true || message.author.isMe || !message.text.trim()) return;
      const event = { source: message.isMention ? 'mention' as const : source, messageId: message.id, threadId: thread.id };
      if (event.source === 'mention') log('slack.mention.received', event);
      await replyContext.run(event, async () => {
        try {
          await handle(thread, message, fallback, context);
        } catch (error) {
          log('slack.reply.failed', event);
          throw error;
        }
      });
    };

    const agent = new Agent({
      id: 'cowork-slack-' + id,
      name: settings.name,
      model,
      memory,
      instructions: `You are ${settings.name}, the Slack workspace’s ${role} coworker. ${roleInstructions[role]} Keep replies concise and use the current Slack conversation for context.`,
      channels: {
        adapters: { slack: { adapter, streaming: false } },
        tools: false,
        inlineLinks: [],
        inlineMedia: [],
        handlers: { onDirectMessage: route('dm'), onMention: route('mention'), onSubscribedMessage: route('thread'), onMessage: false, onSlashCommand: false, onAction: false },
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

  app.on(['GET', 'POST'], apiPath, async (c) => {
    c.header('Cache-Control', 'no-store');
    const workspace = await slackWorkspace(c.req.header('cookie'));
    if (workspace instanceof Response) return workspace;
    await initialize();
    if (c.req.method === 'GET') {
      const { rows: [row] } = await db.execute({
        sql: 'SELECT team_id, team_name FROM cowork_slack_agent_installations WHERE workspace = ? AND agent = ?', args: [workspace.id, agentId],
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
        sql: 'SELECT installation_id, bot_token FROM cowork_slack_agent_installations WHERE workspace = ? AND agent = ?', args: [workspace.id, agentId],
      });
      if (input.action === 'disconnect') {
        await db.execute({ sql: 'DELETE FROM cowork_slack_agent_oauth WHERE workspace = ? AND agent = ?', args: [workspace.id, agentId] });
        if (row) {
          const id = String(row.installation_id);
          const result = await slackApi('apps.uninstall', {}, decrypt(String(row.bot_token), id));
          if (!result.ok && !['token_revoked', 'account_inactive', 'invalid_auth', 'not_authed'].includes(result.error ?? '')) {
            return c.json({ error: 'Slack could not remove this agent. Try again or remove the app in Slack.' }, 502);
          }
          await db.execute({ sql: 'DELETE FROM cowork_slack_agent_installations WHERE installation_id = ?', args: [id] });
          await forget(id);
        }
        return c.json({ available: liveModel, status: 'disconnected' });
      }
      if (row) return c.json({ error: 'Slack is already connected.' }, 409);
      if (!liveModel) return c.json({ error: 'The Cowork agent is unavailable on this deployment.' }, 503);
      const nonce = randomBytes(32).toString('hex');
      await db.batch([
        { sql: 'DELETE FROM cowork_slack_agent_oauth WHERE expires <= ?', args: [Date.now()] },
        { sql: 'INSERT OR REPLACE INTO cowork_slack_agent_oauth VALUES (?, ?, ?, ?, ?)',
          args: [agentId, workspace.id, nonce, agentId ? channelAgents[agentId].role : workspace.role, Date.now() + oauthLifetime * 1000] },
      ], 'write');
      const query = new URLSearchParams({ client_id: settings.clientId, scope: scopes, redirect_uri: settings.callbackUrl, state: nonce });
      const { rows: [existing] } = await db.execute({
        sql: 'SELECT team_id FROM cowork_slack_agent_installations WHERE workspace = ? LIMIT 1', args: [workspace.id],
      });
      if (existing) query.set('team', String(existing.team_id));
      setCookie(c, cookieName, nonce, { ...cookieOptions, maxAge: oauthLifetime });
      return c.json({ authorizationUrl: 'https://slack.com/oauth/v2/authorize?' + query });
    } finally {
      changes.delete(workspace.id);
    }
  });

  app.get(callbackPath, async (c) => {
    c.header('Cache-Control', 'no-store');
    const finish = (outcome: string) => c.redirect(returnURL + '&slack=' + outcome, 303);
    const state = c.req.query('state');
    if (!state || state !== getCookie(c, cookieName)) return finish('retry');
    deleteCookie(c, cookieName, cookieOptions);
    await initialize();
    const { rows: [pending] } = await db.execute({
      sql: 'DELETE FROM cowork_slack_agent_oauth WHERE nonce = ? AND agent = ? AND expires > ? RETURNING workspace, role', args: [state, agentId, Date.now()],
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
        sql: `INSERT INTO cowork_slack_agent_installations
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM cowork_slack_agent_installations
            WHERE (workspace = ? AND team_id <> ?) OR (team_id = ? AND workspace <> ?)
          ) ON CONFLICT DO NOTHING`,
        args: [agentId, workspace, result.team.id, result.team.name || result.team.id, result.bot_user_id,
          encrypt(result.access_token, id), pending.role, id, Date.now(),
          workspace, result.team.id, result.team.id, workspace],
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
    const logWebhook = (event: string, fields: object = {}) => {
      console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, agent: agentId || 'cowork', ...fields }));
    };
    const payload = (() => {
      try {
        return JSON.parse(body) as {
          type?: string; challenge?: string; team_id?: string; api_app_id?: string;
          event_time?: number; is_ext_shared_channel?: boolean;
          event?: { type?: string; channel_type?: string; channel?: string; ts?: string };
        } | null;
      } catch {
        return null;
      }
    })();
    const verification = payload?.type === 'url_verification';
    const validTimestamp = /^\d{10}$/.test(timestamp);
    const currentTimestamp = validTimestamp && Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
    if (!currentTimestamp || !verifySlackRequest({ signingSecret: settings.signingSecret, timestamp, signature, body })) {
      if (verification || signature) {
        logWebhook('slack.webhook.rejected', {
          request: verification ? 'verification' : 'event',
          reason: !timestamp || !signature ? 'missing_signature_headers' : !currentTimestamp ? 'invalid_timestamp' : 'signature_mismatch',
        });
      }
      return c.json({ error: 'Invalid Slack signature.' }, 401);
    }
    if (!payload || typeof payload !== 'object') return c.json({ error: 'Invalid Slack JSON.' }, 400);
    if (verification) {
      if (typeof payload.challenge !== 'string' || !payload.challenge) return c.json({ error: 'Invalid Slack challenge.' }, 400);
      logWebhook('slack.verification.replied');
      return c.text(payload.challenge);
    }
    if (payload.type !== 'event_callback') return c.json({ ok: true });
    const mention = payload.event?.type === 'app_mention';
    const audit = {
      messageId: payload.event?.ts,
      channelId: payload.event?.channel,
    };
    const ignore = (reason: string) => {
      if (mention) logWebhook('slack.mention.ignored', { ...audit, reason });
      return c.json({ ok: true });
    };
    if (payload.api_app_id !== settings.appId || !payload.team_id) return ignore('app_or_team_mismatch');
    const uninstall = payload.event?.type === 'app_uninstalled';
    if (agentId && !mention && !uninstall &&
        (payload.event?.type !== 'message' || !['im', 'channel'].includes(payload.event.channel_type ?? ''))) {
      return c.json({ ok: true });
    }

    if (mention) logWebhook('slack.mention.delivered', audit);
    await initialize();
    const { rows: [row] } = await db.execute({
      sql: 'SELECT * FROM cowork_slack_agent_installations WHERE team_id = ? AND agent = ?', args: [payload.team_id, agentId],
    });
    if (!row) return ignore('installation_missing');
    const id = String(row.installation_id);
    if (payload.event?.type === 'app_uninstalled') {
      if (Number(row.installed_at) < (Number(payload.event_time) + 1) * 1000) {
        await db.execute({ sql: 'DELETE FROM cowork_slack_agent_installations WHERE installation_id = ?', args: [id] });
        await forget(id);
      }
      return c.json({ ok: true });
    }
    if (!liveModel) return ignore('model_unavailable');
    if (payload.is_ext_shared_channel) return ignore('slack_connect_channel');
    let channel = channels.get(id);
    if (!channel) {
      channel = createChannels(id, String(row.bot_user), decrypt(String(row.bot_token), id), row.role as Role, String(row.workspace), String(row.team_id))
        .catch((error: unknown) => { channels.delete(id); throw error; });
      channels.set(id, channel);
    }
    const result = await (await channel).handleWebhookEvent('slack', new Request(c.req.url, {
      method: 'POST', headers: c.req.raw.headers, body,
    }), { waitUntil: (task) => {
      void task.catch(() => {
        if (mention) logWebhook('slack.mention.dispatch_failed', audit);
        else console.error('Cowork could not process a Slack event.');
      });
    } });
    if (!result.ok && mention) logWebhook('slack.mention.dispatch_rejected', { ...audit, status: result.status });
    return result;
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
  const agent = channelAgentIds.find((id) => c.req.path === eventBase(id) + callbackSuffix);
  return c.req.path.endsWith(callbackSuffix)
    ? c.redirect(settingsPath + (agent ? '&agent=' + agent : '') + '&slack=retry', 303)
    : c.json({ error: 'Cowork could not complete the Slack request. Try again shortly.' }, 502);
});

export const handleSlack = app.fetch;
