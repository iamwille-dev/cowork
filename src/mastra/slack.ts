import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { coworkStateDir } from '../state.ts';
import { createSlackAdapter, SlackFormatConverter, type SlackAdapter } from '@chat-adapter/slack';
import { verifySlackRequest } from '@chat-adapter/slack/webhook';
import { MemoryStateAdapter } from '@chat-adapter/state-memory';
import { createClient } from '@libsql/client';
import type { Mastra } from '@mastra/core';
import type { ChannelConfig, ChannelHandler } from '@mastra/core/channels';
import { channelAgentInstance, respondFromChannel, saveSlackMessage, type ChannelActor, type SlackAgentKey } from './channel-tools.ts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { channelAgents, channelAgentIds, roleAgentId, type ChannelAgent } from '../channel-agents.ts';
import type { Role } from './agents/index.ts';
import { channelReplyGuidance, normalizeChannelReply } from './channels/format.ts';

const settingsPath = '/settings?section=channels';
const callbackSuffix = '/oauth/callback';
const cookieName = 'cowork_slack_state';
const oauthLifetime = 15 * 60;
const slackFormat = new SlackFormatConverter();
const slackMarkdownLimit = 12_000;
const scopes = 'app_mentions:read,chat:write,chat:write.customize,channels:history,channels:read,groups:history,groups:read,im:history,im:read,mpim:history,mpim:read,users:read';

type OAuthResult = {
  access_token?: string; token_type?: string; bot_user_id?: string;
  app_id?: string; team?: { id?: string; name?: string }; is_enterprise_install?: boolean;
};

function slackWorkerSettings() {
  const secret = process.env.MASTRA_ENCRYPTION_KEY?.trim();
  const url = URL.parse(process.env.COWORK_PUBLIC_URL ?? '');
  if (!secret || secret.length < 32 || url?.protocol !== 'https:' || url.username || url.password) return;
  return {
    origin: url.origin,
    encryptionKey: createHash('sha256').update('cowork-slack-oauth\0').update(secret).digest(),
  };
}

const workerSettings = slackWorkerSettings();

function encrypt(token: string, id: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', workerSettings!.encryptionKey, iv);
  cipher.setAAD(Buffer.from(id));
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function decrypt(encrypted: string, id: string) {
  const bytes = Buffer.from(encrypted, 'base64');
  const cipher = createDecipheriv('aes-256-gcm', workerSettings!.encryptionKey, bytes.subarray(0, 12));
  cipher.setAAD(Buffer.from(id));
  cipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
}

async function slackApi<T>(method: string, data: Record<string, string>, token?: string) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: token ? { Authorization: 'Bearer ' + token } : undefined,
    body: new URLSearchParams(data),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('Slack API unavailable.');
  return await response.json() as T & { ok?: boolean; error?: string };
}

function configuration(agent: ChannelAgent | '') {
  const prefix = agent ? `SLACK_${agent.toUpperCase()}_` : 'SLACK_';
  const clientId = process.env[prefix + 'CLIENT_ID']?.trim();
  const clientSecret = process.env[prefix + 'CLIENT_SECRET']?.trim();
  const signingSecret = process.env[prefix + 'SIGNING_SECRET']?.trim();
  const appId = process.env[prefix + 'APP_ID']?.trim();
  if (!clientId || !clientSecret || !signingSecret || !appId || !workerSettings) return;
  return {
    clientId, clientSecret, signingSecret, appId,
    callbackUrl: workerSettings.origin + eventBase(agent) + callbackSuffix,
    agent,
    name: agent ? channelAgents[agent].name : 'Cowork',
  };
}

function eventBase(agent: ChannelAgent | '') {
  return '/integrations/slack' + (agent ? '/' + agent : '');
}

const url = `file:${resolve(coworkStateDir, 'slack-oauth.db')}`;
let database: ReturnType<typeof createClient> | undefined;

function slackDatabase() {
  return database ??= createClient({ url });
}

let ready: Promise<unknown> | undefined;

function initialize() {
  ready ??= slackDatabase().batch([
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
    `CREATE TABLE IF NOT EXISTS cowork_slack_configuration (
      workspace TEXT PRIMARY KEY, team_id TEXT UNIQUE NOT NULL, tokens TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cowork_slack_managed_apps (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, agent TEXT NOT NULL,
      team_id TEXT NOT NULL, app_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, credentials TEXT NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      UNIQUE (workspace, agent)
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

type SlackApp = Omit<NonNullable<ReturnType<typeof configuration>>, 'agent'> & {
  agent: SlackAgentKey;
  workspace?: string;
  team?: string;
};
type SlackDelivery = {
  request: Request;
  settings: SlackApp;
  installationId: string;
  workspace: string;
  team: string;
  botUser: string;
  token: string;
  mention: boolean;
};
const delivery = new AsyncLocalStorage<SlackDelivery>();
const configuredApps = new Map<ChannelAgent | '', NonNullable<ReturnType<typeof configuration>>>();
for (const agent of ['', ...channelAgentIds] as const) {
  const config = configuration(agent);
  if (config && ![...configuredApps.values()].some(({ appId }) => appId === config.appId)) {
    configuredApps.set(agent, config);
  }
}

class SlackState extends MemoryStateAdapter {
  // A workspace can install the shared app and a named app for the same role.
  // Keep each bot's subscriptions and message deduplication independent.
  private installationKey(key: string) {
    const event = delivery.getStore();
    if (!event) throw new Error('Slack installation context is unavailable.');
    return event.installationId + ':' + key;
  }

  override subscribe(threadId: string) {
    return super.subscribe(this.installationKey(threadId));
  }

  override unsubscribe(threadId: string) {
    return super.unsubscribe(this.installationKey(threadId));
  }

  override isSubscribed(threadId: string) {
    return super.isSubscribed(this.installationKey(threadId));
  }

  override setIfNotExists(key: string, value: unknown, ttlMs?: number) {
    return super.setIfNotExists(this.installationKey(key), value, ttlMs);
  }
}

export function slackChannelConfig(role: Role): ChannelConfig | undefined {
  const settings = [...configuredApps.values()].find(({ agent }) => !agent || channelAgents[agent].role === role);
  if (!settings && !workerSettings) return;

  const adapter = createSlackAdapter({
    // Explicit OAuth configuration keeps Chat SDK in installation-provider mode.
    clientId: settings?.clientId ?? 'cowork-managed',
    // The Cowork webhook verifies the exact request against the receiving app's
    // signing secret before handing it to the agent's channel.
    webhookVerifier: (request) => delivery.getStore()?.request === request,
    installationProvider: {
      async getInstallation(team, enterprise) {
        const event = delivery.getStore();
        return !enterprise && event?.team === team
          ? { botToken: event.token, botUserId: event.botUser }
          : null;
      },
    },
  });
  const handle: ChannelHandler = async (thread, message, _defaultHandler, { mastra }) => {
    if (mastra) await handleSlackMessage(mastra, role, adapter, thread, message);
  };
  return {
    adapters: { slack: adapter },
    state: new SlackState(),
    tools: false,
    handlers: {
      onDirectMessage: handle, onMention: handle, onSubscribedMessage: handle,
      onMessage: false, onSlashCommand: false, onAction: false,
    },
  };
}

export function createSlackHandler(mastra: Mastra, liveModel: boolean) {
  const app = new Hono();
  for (const agent of ['', ...channelAgentIds] as const) {
    const apiPath = '/api/slack' + (agent ? '/' + agent : '');
    app.use(apiPath, bodyLimit({ maxSize: 4096 }));
    const config = configuredApps.get(agent);
    if (config) {
      createIntegration(app, mastra, config, apiPath, liveModel);
      continue;
    }
    app.get(apiPath, async (c) => {
      c.header('Cache-Control', 'no-store');
      const workspace = await slackWorkspace(mastra, c.req.header('cookie'));
      return workspace instanceof Response ? workspace : c.json({ available: false, status: 'disconnected' });
    });
  }
  registerManagedSlack(app, mastra, liveModel, workerSettings?.origin);
  app.onError((_error, c) => {
    console.error('Cowork Slack integration request failed.');
    const agent = channelAgentIds.find((id) => c.req.path === eventBase(id) + callbackSuffix);
    return c.req.path.endsWith(callbackSuffix)
      ? c.redirect(settingsPath + (agent ? '&agent=' + agent : '') + '&slack=retry', 303)
      : c.json({ error: 'Cowork could not complete the Slack request. Try again shortly.' }, 502);
  });
  return app.fetch;
}

function createIntegration(app: Hono, mastra: Mastra, settings: NonNullable<ReturnType<typeof configuration>>, apiPath: string, liveModel: boolean) {
  const agentId = settings.agent;
  const callbackPath = eventBase(agentId) + callbackSuffix;
  const eventsPath = eventBase(agentId) + '/events';
  const cookieOptions = { path: callbackPath, secure: true, httpOnly: true, sameSite: 'Lax' } as const;
  const returnURL = settingsPath + (agentId ? '&agent=' + agentId : '');
  const changes = new Set<string>();

  app.on(['GET', 'POST'], apiPath, async (c) => {
    c.header('Cache-Control', 'no-store');
    const workspace = await slackWorkspace(mastra, c.req.header('cookie'));
    if (workspace instanceof Response) return workspace;
    await initialize();
    if (c.req.method === 'GET') {
      const { rows: [row] } = await slackDatabase().execute({
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
      const { rows: [row] } = await slackDatabase().execute({
        sql: 'SELECT installation_id, bot_token FROM cowork_slack_agent_installations WHERE workspace = ? AND agent = ?', args: [workspace.id, agentId],
      });
      if (input.action === 'disconnect') {
        await slackDatabase().execute({ sql: 'DELETE FROM cowork_slack_agent_oauth WHERE workspace = ? AND agent = ?', args: [workspace.id, agentId] });
        if (row) {
          const id = String(row.installation_id);
          const result = await slackApi('apps.uninstall', oauthCredentials(settings), decrypt(String(row.bot_token), id));
          if (!result.ok && !['token_revoked', 'account_inactive', 'invalid_auth', 'not_authed'].includes(result.error ?? '')) {
            return c.json({ error: 'Slack could not remove this agent. Try again or remove the app in Slack.' }, 502);
          }
          await slackDatabase().execute({ sql: 'DELETE FROM cowork_slack_agent_installations WHERE installation_id = ?', args: [id] });
        }
        return c.json({ available: liveModel, status: 'disconnected' });
      }
      if (row) return c.json({ error: 'Slack is already connected.' }, 409);
      if (!liveModel) return c.json({ error: 'The Cowork agent is unavailable on this deployment.' }, 503);
      const nonce = randomBytes(32).toString('hex');
      await slackDatabase().batch([
        { sql: 'DELETE FROM cowork_slack_agent_oauth WHERE expires <= ?', args: [Date.now()] },
        { sql: 'INSERT OR REPLACE INTO cowork_slack_agent_oauth VALUES (?, ?, ?, ?, ?)',
          args: [agentId, workspace.id, nonce, agentId ? channelAgents[agentId].role : workspace.role, Date.now() + oauthLifetime * 1000] },
      ], 'write');
      const query = new URLSearchParams({ client_id: settings.clientId, scope: scopes, redirect_uri: settings.callbackUrl, state: nonce });
      const { rows: [existing] } = await slackDatabase().execute({
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
    const { rows: [pending] } = await slackDatabase().execute({
      sql: 'DELETE FROM cowork_slack_agent_oauth WHERE nonce = ? AND agent = ? AND expires > ? RETURNING workspace, role', args: [state, agentId, Date.now()],
    });
    if (!pending) return finish('retry');
    if (c.req.query('error') === 'access_denied') return finish('canceled');
    const code = c.req.query('code');
    const workspace = String(pending.workspace);
    if (!code || changes.has(workspace)) return finish('retry');
    changes.add(workspace);
    try {
      const result = await slackApi<OAuthResult>('oauth.v2.access', { ...oauthCredentials(settings), code, redirect_uri: settings.callbackUrl });
      if (!result.ok || result.app_id !== settings.appId || result.is_enterprise_install ||
          !result.team?.id || !result.access_token || result.token_type !== 'bot' || !result.bot_user_id) return finish('retry');
      return finish(await saveInstallation(agentId, workspace, String(pending.role), result as InstalledOAuth) ? 'connected' : 'conflict');
    } finally {
      changes.delete(workspace);
    }
  });

  const webhookPaths = agentId
    ? [eventsPath, `/api/agents/${roleAgentId(channelAgents[agentId].role)}/channels/slack/webhook`]
    : [eventsPath];
  app.on('POST', webhookPaths, bodyLimit({ maxSize: 1024 * 1024 }), (c) => receiveSlackEvent(c, settings, mastra, liveModel));
}

type InstalledOAuth = { team: { id: string; name?: string }; access_token: string; bot_user_id: string };

async function saveInstallation(agent: SlackAgentKey, workspace: string, role: string, result: InstalledOAuth) {
  const id = randomBytes(24).toString('hex');
  const saved = await slackDatabase().execute({
    sql: `INSERT INTO cowork_slack_agent_installations
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM cowork_slack_agent_installations
        WHERE (workspace = ? AND team_id <> ?) OR (team_id = ? AND workspace <> ?)
        UNION ALL SELECT 1 FROM cowork_slack_configuration
        WHERE (workspace = ? AND team_id <> ?) OR (team_id = ? AND workspace <> ?)
      ) ON CONFLICT DO NOTHING`,
    args: [agent, workspace, result.team.id, result.team.name || result.team.id, result.bot_user_id,
      encrypt(result.access_token, id), role, id, Date.now(), workspace, result.team.id, result.team.id, workspace,
      workspace, result.team.id, result.team.id, workspace],
  });
  return Boolean(saved.rowsAffected);
}

function oauthCredentials(settings: SlackApp) {
  return { client_id: settings.clientId, client_secret: settings.clientSecret };
}

type ManifestCredentials = { clientId: string; clientSecret: string; signingSecret: string };
type ConfigurationTokens = { access: string; refresh: string; expires: number };
type ManagedApp = SlackApp & { id: string; workspace: string; team: string; verified: boolean };

function managedPath(id: string) {
  return '/integrations/slack/managed/' + id;
}

function managedApp(row: Record<string, unknown>, origin: string): ManagedApp {
  const id = String(row.id);
  const credentials = JSON.parse(decrypt(String(row.credentials), 'app:' + id)) as ManifestCredentials;
  return {
    ...credentials, id, agent: String(row.agent) as SlackAgentKey, workspace: String(row.workspace),
    team: String(row.team_id), appId: String(row.app_id), name: String(row.name), verified: Boolean(row.verified),
    callbackUrl: origin + managedPath(id) + callbackSuffix,
  };
}

function agentManifest(name: string, origin: string, id: string) {
  return JSON.stringify({
    display_information: { name, description: 'Chat with your Cowork agent in Slack.' },
    features: {
      bot_user: { display_name: name },
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    },
    oauth_config: { redirect_urls: [origin + managedPath(id) + callbackSuffix], scopes: { bot: scopes.split(',') } },
    settings: {
      event_subscriptions: {
        request_url: origin + managedPath(id) + '/events',
        bot_events: ['app_mention', 'message.channels', 'message.groups', 'message.im', 'message.mpim', 'app_uninstalled'],
      },
      socket_mode_enabled: false, org_deploy_enabled: false, token_rotation_enabled: false,
    },
  });
}

class SlackSetupError extends Error {}

async function configurationToken(workspace: string, refreshInput: string) {
  const db = slackDatabase();
  const { rows: [stored] } = await db.execute({
    sql: 'SELECT team_id, tokens FROM cowork_slack_configuration WHERE workspace = ?', args: [workspace],
  });
  const saved = stored && JSON.parse(decrypt(String(stored.tokens), 'config:' + workspace)) as ConfigurationTokens;
  if (!refreshInput && saved && saved.expires > Date.now() + 60_000) {
    return { team: String(stored.team_id), token: saved.access };
  }
  const refresh = refreshInput || saved?.refresh;
  if (!refresh) throw new SlackSetupError('Enter a Slack app configuration refresh token.');
  const result = await slackApi<{ team_id?: string; token?: string; refresh_token?: string; exp?: number }>(
    'tooling.tokens.rotate', { refresh_token: refresh },
  );
  if (result.error === 'invalid_refresh_token') {
    if (!refreshInput) await db.execute({ sql: 'DELETE FROM cowork_slack_configuration WHERE workspace = ?', args: [workspace] });
    throw new SlackSetupError('The Slack configuration token expired or was revoked. Generate a fresh refresh token in Slack.');
  }
  if (!result.ok || !result.team_id || !result.token || !result.refresh_token || !result.exp) {
    throw new Error('Slack configuration token rotation failed.');
  }
  const { rows: [conflict] } = await db.execute({
    sql: `SELECT team_id FROM cowork_slack_agent_installations
      WHERE (workspace = ? AND team_id <> ?) OR (workspace <> ? AND team_id = ?)
      UNION ALL SELECT team_id FROM cowork_slack_managed_apps
      WHERE (workspace = ? AND team_id <> ?) OR (workspace <> ? AND team_id = ?) LIMIT 1`,
    args: [workspace, result.team_id, workspace, result.team_id, workspace, result.team_id, workspace, result.team_id],
  });
  if (conflict) throw new SlackSetupError('Use a refresh token for the Slack workspace linked to this Cowork workspace.');
  const savedTokens: ConfigurationTokens = { access: result.token, refresh: result.refresh_token, expires: result.exp * 1000 };
  const written = await db.execute({
    sql: `INSERT INTO cowork_slack_configuration VALUES (?, ?, ?)
      ON CONFLICT(workspace) DO UPDATE SET team_id = excluded.team_id, tokens = excluded.tokens
      ON CONFLICT(team_id) DO NOTHING`,
    args: [workspace, result.team_id, encrypt(JSON.stringify(savedTokens), 'config:' + workspace)],
  });
  if (!written.rowsAffected) throw new SlackSetupError('This Slack workspace is linked to another Cowork workspace.');
  return { team: result.team_id, token: result.token };
}

async function provisionSlackApp(workspace: string, agent: SlackAgentKey, name: string, origin: string, refresh: string, existing?: ManagedApp): Promise<ManagedApp> {
  if (existing && existing.name === name) return existing;
  if (Array.from(name).length > 35) throw new SlackSetupError('Slack app names can be up to 35 characters. Shorten this agent’s name in Cowork and try again.');
  const { team, token } = await configurationToken(workspace, refresh);
  const id = existing?.id ?? randomBytes(24).toString('hex');
  const manifest = agentManifest(name, origin, id);
  if (existing) {
    const result = await slackApi('apps.manifest.update', { app_id: existing.appId, manifest }, token);
    if (!result.ok) throw new SlackSetupError('Slack could not update this app’s name. Check the agent name and the Slack configuration token.');
    await slackDatabase().execute({ sql: 'UPDATE cowork_slack_managed_apps SET name = ? WHERE id = ?', args: [name, id] });
    return { ...existing, name };
  }
  const result = await slackApi<{ app_id?: string; credentials?: { client_id?: string; client_secret?: string; signing_secret?: string } }>(
    'apps.manifest.create', { manifest }, token,
  );
  const { client_id: clientId, client_secret: clientSecret, signing_secret: signingSecret } = result.credentials ?? {};
  if (!result.ok || !result.app_id || !clientId || !clientSecret || !signingSecret) {
    if (result.error === 'invalid_manifest') throw new SlackSetupError('Slack rejected the app configuration. Check that the agent name is valid in Slack.');
    throw new SlackSetupError('Slack could not create the app. Check that the configuration token can create apps in this workspace.');
  }
  const credentials = { clientId, clientSecret, signingSecret };
  await slackDatabase().execute({
    sql: 'INSERT INTO cowork_slack_managed_apps (id, workspace, agent, team_id, app_id, name, credentials) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [id, workspace, agent, team, result.app_id, name, encrypt(JSON.stringify(credentials), 'app:' + id)],
  });
  return { ...credentials, id, workspace, agent, team, name, appId: result.app_id, verified: false,
    callbackUrl: origin + managedPath(id) + callbackSuffix };
}

function registerManagedSlack(app: Hono, mastra: Mastra, liveModel: boolean, origin?: string) {
  const apiPath = '/api/slack/agents/:agent';
  const callbackPath = managedPath(':id') + callbackSuffix;
  const eventsPath = managedPath(':id') + '/events';
  const changes = new Set<string>();
  const cookie = (path: string) => ({ path, secure: true, httpOnly: true, sameSite: 'Lax' } as const);
  const unavailable = { available: false, status: 'disconnected' };

  async function appForWebhook(id: string | undefined) {
    if (!id || !/^[a-f0-9]{48}$/.test(id) || !origin) return;
    await initialize();
    const { rows: [row] } = await slackDatabase().execute({ sql: 'SELECT * FROM cowork_slack_managed_apps WHERE id = ?', args: [id] });
    if (row) return managedApp(row, origin);
  }

  app.on(['GET', 'POST'], apiPath, bodyLimit({ maxSize: 4096 }), async (c) => {
    c.header('Cache-Control', 'no-store');
    const workspace = await slackWorkspace(mastra, c.req.header('cookie'));
    if (workspace instanceof Response) return workspace;
    const agent = workspace.agents?.find(({ ID }) => ID && ID === c.req.param('agent'));
    if (!agent || !Object.hasOwn(mastra.listAgents(), agent.Role)) return c.json({ error: 'Agent not found in this workspace.' }, 404);
    if (!origin) return c.req.method === 'GET' ? c.json(unavailable) : c.json({ error: 'Slack setup is unavailable on this deployment.' }, 503);
    const key: SlackAgentKey = `agent:${agent.ID}`;
    await initialize();
    const db = slackDatabase();
    const getApp = async () => {
      const { rows: [row] } = await db.execute({
        sql: 'SELECT * FROM cowork_slack_managed_apps WHERE workspace = ? AND agent = ?', args: [workspace.id, key],
      });
      if (row) return managedApp(row, origin);
    };
    const getInstallation = async () => {
      const { rows: [row] } = await db.execute({
        sql: 'SELECT * FROM cowork_slack_agent_installations WHERE workspace = ? AND agent = ?', args: [workspace.id, key],
      });
      return row;
    };
    if (c.req.method === 'GET') {
      const settings = await getApp();
      const installed = settings && await getInstallation();
      if (installed) return c.json({
        available: liveModel, status: 'active', team: installed.team_name, teamId: installed.team_id,
        appId: settings.appId, name: settings.name, needsVerification: !settings.verified,
      });
      const { rows } = await db.execute({ sql: 'SELECT 1 FROM cowork_slack_configuration WHERE workspace = ?', args: [workspace.id] });
      return c.json({ available: liveModel, status: 'disconnected', needsToken: !rows.length && settings?.name !== agent.Name });
    }
    if (!workspace.owner) return c.json({ error: 'Workspace owner access required.' }, 403);
    if (c.req.header('content-type')?.split(';', 1)[0] !== 'application/json') return c.json({ error: 'Invalid request.' }, 415);
    const input = await c.req.json<{ action?: string; refreshToken?: string } | null>().catch(() => null);
    if (input?.action !== 'connect' && input?.action !== 'disconnect') return c.json({ error: 'Invalid Slack action.' }, 400);
    const refresh = typeof input.refreshToken === 'string' ? input.refreshToken.trim() : '';
    if (refresh && !/^xoxe-[\w-]{1,1000}$/.test(refresh)) return c.json({ error: 'Enter the Slack app configuration refresh token that starts with xoxe-.' }, 400);
    if (changes.has(workspace.id)) return c.json({ error: 'A Slack update is in progress. Try again shortly.' }, 409);
    changes.add(workspace.id);
    try {
      const existing = await getApp();
      const installed = await getInstallation();
      if (input.action === 'disconnect') {
        await db.execute({ sql: 'DELETE FROM cowork_slack_agent_oauth WHERE workspace = ? AND agent = ?', args: [workspace.id, key] });
        if (existing && installed) {
          const id = String(installed.installation_id);
          const result = await slackApi('apps.uninstall', oauthCredentials(existing), decrypt(String(installed.bot_token), id));
          if (!result.ok && !['token_revoked', 'account_inactive', 'invalid_auth', 'not_authed'].includes(result.error ?? '')) {
            return c.json({ error: 'Slack could not remove this agent. Try again or remove the app in Slack.' }, 502);
          }
          await db.execute({ sql: 'DELETE FROM cowork_slack_agent_installations WHERE installation_id = ?', args: [id] });
        }
        return c.json({ available: liveModel, status: 'disconnected' });
      }
      if (installed) return c.json({ error: 'Slack is already connected.' }, 409);
      if (!liveModel) return c.json({ error: 'The Cowork agent is unavailable on this deployment.' }, 503);
      const { rows: [legacy] } = await db.execute({
        sql: `SELECT agent FROM cowork_slack_agent_installations WHERE workspace = ?
          AND ((agent IN ('ada', 'sam') AND role = ?) OR (agent = '' AND ? = ?)) LIMIT 1`,
        args: [workspace.id, agent.Role, workspace.role, agent.Role],
      });
      if (legacy) {
        return c.json({ error: 'Disconnect this agent’s existing Slack app in Messaging channels before connecting its named app.' }, 409);
      }
      const settings = await provisionSlackApp(workspace.id, key, agent.Name, origin, refresh, existing);
      const nonce = randomBytes(32).toString('hex');
      await db.batch([
        { sql: 'DELETE FROM cowork_slack_agent_oauth WHERE expires <= ?', args: [Date.now()] },
        { sql: 'INSERT OR REPLACE INTO cowork_slack_agent_oauth VALUES (?, ?, ?, ?, ?)',
          args: [key, workspace.id, nonce, agent.Role, Date.now() + oauthLifetime * 1000] },
      ], 'write');
      const query = new URLSearchParams({
        client_id: settings.clientId, scope: scopes, redirect_uri: settings.callbackUrl, state: nonce, team: settings.team,
      });
      setCookie(c, cookieName, nonce, { ...cookie(managedPath(settings.id) + callbackSuffix), maxAge: oauthLifetime });
      return c.json({ authorizationUrl: 'https://slack.com/oauth/v2/authorize?' + query });
    } catch (error) {
      if (error instanceof SlackSetupError) return c.json({ error: error.message }, 422);
      throw error;
    } finally {
      changes.delete(workspace.id);
    }
  });

  app.get(callbackPath, async (c) => {
    c.header('Cache-Control', 'no-store');
    const settings = await appForWebhook(c.req.param('id'));
    if (!settings) return c.redirect(settingsPath + '&slack=retry', 303);
    const agentId = settings.agent.slice('agent:'.length);
    const finish = (outcome: string) => c.redirect(settingsPath + '&agent=' + encodeURIComponent(agentId) + '&slack=' + outcome, 303);
    const state = c.req.query('state');
    if (!state || state !== getCookie(c, cookieName)) return finish('retry');
    deleteCookie(c, cookieName, cookie(c.req.path));
    const workspace = await slackWorkspace(mastra, c.req.header('cookie'));
    if (workspace instanceof Response || !workspace.owner || workspace.id !== settings.workspace) return finish('retry');
    const agent = workspace.agents?.find(({ ID }) => ID === agentId);
    if (!agent || changes.has(workspace.id)) return finish('retry');
    changes.add(workspace.id);
    try {
      const db = slackDatabase();
      const pending = await db.execute({
        sql: 'DELETE FROM cowork_slack_agent_oauth WHERE nonce = ? AND workspace = ? AND agent = ? AND role = ? AND expires > ?',
        args: [state, workspace.id, settings.agent, agent.Role, Date.now()],
      });
      if (!pending.rowsAffected) return finish('retry');
      if (c.req.query('error') === 'access_denied') return finish('canceled');
      const code = c.req.query('code');
      if (!code) return finish('retry');
      const result = await slackApi<OAuthResult>('oauth.v2.access', { ...oauthCredentials(settings), code, redirect_uri: settings.callbackUrl });
      if (!result.ok || result.app_id !== settings.appId || result.is_enterprise_install || !result.team?.id ||
          !result.access_token || result.token_type !== 'bot' || !result.bot_user_id) return finish('retry');
      if (result.team.id !== settings.team) return finish('conflict');
      return finish(await saveInstallation(settings.agent, workspace.id, agent.Role, result as InstalledOAuth) ? 'connected' : 'conflict');
    } finally {
      changes.delete(workspace.id);
    }
  });

  app.post(eventsPath, bodyLimit({ maxSize: 1024 * 1024 }), async (c) => {
    const settings = await appForWebhook(c.req.param('id'));
    return settings ? receiveSlackEvent(c, settings, mastra, liveModel) : c.notFound();
  });
}

async function receiveSlackEvent(c: Context, settings: SlackApp, mastra: Mastra, liveModel: boolean) {
  const agentId = settings.agent;
  const body = await verifySlackRequest(c.req.raw, { signingSecret: settings.signingSecret }).catch(() => undefined);
  const logWebhook = (event: string, fields: object = {}) => {
    console.info(JSON.stringify({ timestamp: new Date().toISOString(), event, agent: agentId || 'cowork', ...fields }));
  };
  if (body === undefined) {
    if (c.req.header('x-slack-signature')) logWebhook('slack.webhook.rejected');
    return c.json({ error: 'Invalid Slack signature.' }, 401);
  }
  let payload: {
    type?: string; challenge?: string; team_id?: string; api_app_id?: string;
    event_time?: number; is_ext_shared_channel?: boolean;
    event?: { type?: string; channel_type?: string; channel?: string; ts?: string };
  } | null;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: 'Invalid Slack JSON.' }, 400);
  }
  if (!payload || typeof payload !== 'object') return c.json({ error: 'Invalid Slack JSON.' }, 400);
  const markVerified = async () => {
    if (settings.workspace) await slackDatabase().execute({
      sql: 'UPDATE cowork_slack_managed_apps SET verified = 1 WHERE app_id = ? AND verified = 0',
      args: [settings.appId],
    });
  };
  if (payload.type === 'url_verification') {
    if (typeof payload.challenge !== 'string' || !payload.challenge) return c.json({ error: 'Invalid Slack challenge.' }, 400);
    await markVerified();
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
  if (payload.api_app_id !== settings.appId || !payload.team_id || (settings.team && payload.team_id !== settings.team)) {
    return ignore('app_or_team_mismatch');
  }
  await markVerified();
  const uninstall = payload.event?.type === 'app_uninstalled';
  if (agentId && !mention && !uninstall &&
      (payload.event?.type !== 'message' || !['im', 'channel'].includes(payload.event.channel_type ?? ''))) {
    return c.json({ ok: true });
  }

  if (mention) logWebhook('slack.mention.delivered', audit);
  await initialize();
  const { rows: [row] } = await slackDatabase().execute({
    sql: 'SELECT * FROM cowork_slack_agent_installations WHERE team_id = ? AND agent = ?', args: [payload.team_id, agentId],
  });
  if (!row || (settings.workspace && row.workspace !== settings.workspace)) return ignore('installation_missing');
  const id = String(row.installation_id);
  if (payload.event?.type === 'app_uninstalled') {
    if (Number(row.installed_at) < (Number(payload.event_time) + 1) * 1000) {
      await slackDatabase().execute({ sql: 'DELETE FROM cowork_slack_agent_installations WHERE installation_id = ?', args: [id] });
    }
    return c.json({ ok: true });
  }
  if (!liveModel) return ignore('model_unavailable');
  if (payload.is_ext_shared_channel) return ignore('slack_connect_channel');
  const role = String(row.role) as Role;
  if (!Object.hasOwn(mastra.listAgents(), role)) return ignore('agent_unavailable');
  const channels = mastra.getAgent(role).getChannels();
  if (!channels) return ignore('agent_unavailable');
  const request = new Request(c.req.url, { method: 'POST', headers: c.req.raw.headers, body });
  const result = await delivery.run({
    request, settings, installationId: id, workspace: String(row.workspace), team: payload.team_id,
    botUser: String(row.bot_user), token: decrypt(String(row.bot_token), id), mention,
  }, () => channels.handleWebhookEvent('slack', request, { waitUntil: (task) => {
    void task.catch(() => {
      if (mention) logWebhook('slack.mention.dispatch_failed', audit);
      else console.error('Cowork could not process a Slack event.');
    });
  } }));
  if (!result.ok && mention) logWebhook('slack.mention.dispatch_rejected', { ...audit, status: result.status });
  return result;
}

async function handleSlackMessage(
  mastra: Mastra,
  role: Role,
  adapter: SlackAdapter,
  thread: Parameters<ChannelHandler>[0],
  message: Parameters<ChannelHandler>[1],
) {
  const event = delivery.getStore();
  if (!event || message.author.isBot === true || message.author.isMe || !message.text.trim()) return;
  const { workspace, team, token, settings, installationId: id, mention } = event;
  const agentId = settings.agent;
  const source = { messageId: message.id, threadId: thread.id };
  const log = (name: string, fields: object) => {
    console.info(JSON.stringify({ timestamp: new Date().toISOString(), event: name, agent: agentId || 'cowork', teamId: team, ...fields }));
  };
  const installationActive = async () => {
    const { rows } = await slackDatabase().execute({
      sql: 'SELECT 1 FROM cowork_slack_agent_installations WHERE installation_id = ? AND workspace = ? AND team_id = ? AND agent = ?',
      args: [id, workspace, team, agentId],
    });
    return rows.length > 0;
  };
  if (!await installationActive()) return;
  if (mention || message.isMention) log('slack.mention.received', source);
  const actor: ChannelActor = {
    WorkspaceID: workspace, Channel: 'slack', Agent: agentId, Installation: id, Conversation: thread.id,
    SenderID: message.author.userId, Author: message.author.fullName || message.author.userName,
  };
  if (agentId.startsWith('agent:')) actor.AgentInstance = agentId.slice('agent:'.length);
  if (agentId) {
    actor.AgentInstance = await channelAgentInstance(actor);
    if (actor.AgentInstance === undefined) return;
  }
  // Slack Connect and external guests cannot use the linked workspace's tools.
  const userResponse = await fetch('https://slack.com/api/users.info?' + new URLSearchParams({ user: message.author.userId }), {
    headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
  const identity = await userResponse?.json().catch(() => undefined) as {
    ok?: boolean; user?: { team_id?: string; team?: string; tz?: string; is_stranger?: boolean; is_external?: boolean; suspended?: boolean; is_bot?: boolean; is_restricted?: boolean; is_ultra_restricted?: boolean; deleted?: boolean };
  } | undefined;
  const user = identity?.user;
  if (!identity?.ok || !user || (user.team_id ?? user.team) !== team || user.is_stranger ||
      user.is_external || user.suspended || user.is_bot || user.is_restricted || user.is_ultra_restricted || user.deleted) {
    if ((!agentId || message.isMention || mention || thread.isDM) && await installationActive() &&
        (!agentId || await channelAgentInstance(actor) === actor.AgentInstance)) {
      const messages = await slackMessages(thread, message);
      const reply = await mastra.getAgent(role).generate(
        `Respond to the last Slack message only. Conversation in chronological order:\n${JSON.stringify(messages)}`,
        { activeTools: [], system: channelReplyGuidance },
      );
      const markdown = normalizeChannelReply(reply.text);
      if (markdown && await installationActive() &&
          (!agentId || await channelAgentInstance(actor) === actor.AgentInstance)) await thread.post(slackReply(markdown));
    }
    return;
  }
  const { channel, threadTs } = adapter.decodeThreadId(thread.id);
  const passive = Boolean(agentId && !mention && !message.isMention && !thread.isDM);
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

  let name = settings.name;
  try {
    const reply = await respondFromChannel(mastra, actor, mirrored?.Messages ?? await slackMessages(thread, message), {
      installationActive,
      timeZone: slackTimeZone(user.tz),
      progress: async (status, displayName) => {
        name = displayName;
        await thread.startTyping(status).catch(() => undefined);
      },
    });
    if (reply && await installationActive() && (!agentId || await channelAgentInstance(actor) === actor.AgentInstance)) {
      const outbound = slackReply(reply);
      let replyId: string | undefined;
      if (name !== settings.name) {
        const response = await fetch('https://slack.com/api/chat.postMessage', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token },
          body: new URLSearchParams({
            channel, ...(threadTs && { thread_ts: threadTs }), ...slackFormat.toSlackPayload(outbound), username: name,
            unfurl_links: 'false', unfurl_media: 'false',
          }),
          signal: AbortSignal.timeout(10_000),
        });
        const posted = await response.json() as { ok?: boolean; ts?: string; error?: string };
        if (posted.ok && posted.ts) replyId = posted.ts;
        else if (posted.error !== 'missing_scope') throw new Error('Slack could not post the reply.');
      }
      replyId ??= (await thread.post(outbound)).id;
      log('slack.reply.sent', { ...source, replyId });
      if (mirrored?.Sync) {
        await saveSlackMessage(actor, { ID: replyId, Text: reply.slice(0, 12000), At: new Date().toISOString(), Reply: true });
      }
      if (!thread.isDM && (!agentId || mirrored?.Sync)) await thread.subscribe();
    }
  } finally {
    await thread.startTyping('').catch(() => undefined);
  }
}

function slackReply(markdown: string) {
  const message = { markdown };
  return markdown.length <= slackMarkdownLimit ? message : { raw: slackFormat.toResponseUrlText(message) };
}

function slackTimeZone(timeZone: unknown): string | undefined {
  if (typeof timeZone !== 'string' || !timeZone) return;
  try {
    return new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
  } catch {
    return;
  }
}

async function slackMessages(thread: Parameters<ChannelHandler>[0], message: Parameters<ChannelHandler>[1]) {
  await thread.refresh().catch(() => undefined);
  const history = thread.recentMessages.filter((item) => item.id !== message.id && item.text.trim())
    .sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime()).slice(-23);
  return [...history, message].map((item) => ({
    Author: item.author.fullName || item.author.userName,
    Text: item.text.slice(0, 4000),
    SenderID: item.author.userId,
  }));
}

async function slackWorkspace(mastra: Mastra, cookie?: string) {
  const response = await fetch('http://127.0.0.1:4000/api/slack-context', {
    headers: { Cookie: cookie ?? '' },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return new Response(response.body, { status: response.status, headers: { 'Content-Type': 'application/json' } });
  const workspace = await response.json() as { id: string; role: Role; owner: boolean; agents?: { ID: string; Name: string; Role: Role }[] };
  if (!/^[a-f0-9]{48}$/.test(workspace.id) || !Object.hasOwn(mastra.listAgents(), workspace.role)) throw new Error('Invalid workspace.');
  return workspace;
}
