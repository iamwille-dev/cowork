import { Button, buttonClassName } from './app/components/button';
import { Input } from './app/components/input';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { channelAgents, channelAgentIds, type ChannelAgent } from './channel-agents';
import { api } from './app/components/api';
import { ManagedConnections, type AgentGrants } from './app/components/managed-connections';
import type { WorkspaceAgent } from './app/components/onboarding';

const sections = [
  { id: 'appearance', title: 'Appearance' },
  { id: 'members', title: 'Members' },
  { id: 'channels', title: 'Messaging channels' },
  { id: 'agent-connection', title: 'Agent Connection' },
  { id: 'git-tokens', title: 'Git tokens' },
] as const;

const gitProviders = { github: 'GitHub', gitlab: 'GitLab' } as const;
export type GitProvider = keyof typeof gitProviders;
type Theme = 'light' | 'dark';

type SettingsProps = {
  theme: Theme;
  members: { ID: string; Name: string; Email: string; Role: string }[];
  owner: boolean;
  invite: string;
  channels: Partial<Record<'WhatsApp' | 'Telegram', string>>;
  telegramBot?: string;
  telegramAgents?: Partial<Record<ChannelAgent, { Username: string; Destination: string }>>;
  saveTelegram: (settings: { Agent?: ChannelAgent; Token?: string; Destination?: string; Remove?: boolean }) => Promise<boolean>;
  changeTheme: (theme: Theme) => void;
  saveChannel: (provider: 'WhatsApp', destination: string, button: HTMLButtonElement) => void;
  agentConnection: { enabled: boolean; hasKey: boolean };
  managedConnections?: { agents: WorkspaceAgent[]; grants: AgentGrants; busy: boolean; saveGrants: (value: AgentGrants) => void };
  saveAgentConnection: (settings: { Enabled: boolean; Key?: string; RemoveKey?: boolean }) => Promise<boolean>;
  gitTokenStatus: Partial<Record<GitProvider, boolean>>;
  saveGitToken: (settings: { Provider: GitProvider; Token?: string; Remove?: boolean }) => Promise<boolean>;
  announce: (message: string) => void;
};

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-form-section settings-form-row">
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
      <div className="settings-form-body">{children}</div>
    </section>
  );
}

function SettingsIntro({ title, description }: { title: string; description: string }) {
  return <header className="settings-form-section">
    <h2>{title}</h2>
    <p>{description}</p>
  </header>;
}

function SettingsGroup({ id, title, logo, children }: {
  id: string; title: string; logo?: 'slack' | 'telegram' | 'whatsapp'; children: ReactNode;
}) {
  return <section className="settings-form-section settings-form-row" aria-labelledby={id}>
    <h3 id={id}>
      {logo && <span className="settings-group-icon" data-provider={logo} aria-hidden="true" />}
      {title}
    </h3>
    <div className="settings-form-body">{children}</div>
  </section>;
}

function ThemeOptions({ theme, changeTheme }: Pick<SettingsProps, 'theme' | 'changeTheme'>) {
  return (
    <div className="theme-options grid grid-cols-2 gap-3" role="group" aria-label="Color theme">
      {(['light', 'dark'] as const).map((choice) => (
        <button key={choice} type="button" aria-pressed={theme === choice} onClick={() => changeTheme(choice)}>
          <span className={`theme-preview theme-preview-${choice}`} aria-hidden="true"><i /><i /><i /></span>
          <strong>{choice === 'light' ? 'Light' : 'Dark'}</strong>
        </button>
      ))}
    </div>
  );
}

function MemberList({ members }: Pick<SettingsProps, 'members'>) {
  return (
    <ul role="list" className="settings-member-list overflow-hidden rounded-xl border">
      {[...members].sort((a, b) => a.Name.localeCompare(b.Name) || a.Email.localeCompare(b.Email)).map((member) => {
        const initials = member.Name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0] ?? '').join('').toUpperCase();
        return (
          <li key={member.ID} className="relative flex items-center justify-between gap-x-4 px-4 py-4 sm:gap-x-6 sm:px-6">
            <div className="flex min-w-0 items-center gap-x-4">
              <span className="avatar settings-member-avatar" aria-hidden="true">{initials}</span>
              <div className="min-w-0 flex-auto">
                <strong className="block truncate text-sm/6">{member.Name}</strong>
                <a className="settings-member-email block truncate text-xs/5 hover:underline" href={`mailto:${encodeURIComponent(member.Email).replace('%40', '@')}`}>{member.Email}</a>
              </div>
            </div>
            <span className="settings-member-role shrink-0 text-sm/6">{member.Role}</span>
          </li>
        );
      })}
    </ul>
  );
}

function InviteCode({ invite, announce }: Pick<SettingsProps, 'invite' | 'announce'>) {
  const input = useRef<HTMLInputElement>(null);
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(invite);
      announce('Invite code copied.');
    } catch {
      input.current?.focus();
      input.current?.select();
      announce('The invite code is selected and ready to copy.');
    }
  }
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="min-w-0 flex-1" htmlFor="invite-code">
        Workspace invite code
        <Input id="invite-code" ref={input} value={invite} readOnly />
      </label>
      <Button variant="quiet" type="button" onClick={copyCode}>Copy code</Button>
    </div>
  );
}

function ChannelForm({ provider, destination, owner, saveChannel }: {
  provider: 'WhatsApp'; destination: string; owner: boolean; saveChannel: SettingsProps['saveChannel'];
}) {
  const submit = useRef<HTMLButtonElement>(null);
  return (
    <form className="settings-channel-form flex flex-wrap items-end gap-3" onSubmit={(event) => {
      event.preventDefault();
      if (owner && submit.current) {
        saveChannel(provider, String(new FormData(event.currentTarget).get('Destination') ?? ''), submit.current);
      }
    }}>
      <label className="min-w-0 flex-1">
        Destination
        <Input name="Destination" defaultValue={destination} readOnly={!owner} placeholder="Channel or conversation ID" />
      </label>
      {owner && <Button type="submit" ref={submit}>Save</Button>}
    </form>
  );
}

type SlackConnection = {
  available: boolean;
  status: 'disconnected' | 'active';
  team?: string;
  appId?: string;
  teamId?: string;
};

export function SlackConnectionForm({ owner, agent, workspaceName, onConnected }: {
  owner: boolean; agent?: ChannelAgent; workspaceName?: string; onConnected?: (value: boolean) => void;
}) {
  const name = agent ? channelAgents[agent].name : 'Cowork';
  const endpoint = agent ? 'slack/' + agent : 'slack';
  const [connection, setConnection] = useState<SlackConnection>();
  const [busy, setBusy] = useState<'connect' | 'disconnect'>();
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    api<SlackConnection>(endpoint).then(
      (result) => { if (active) setConnection(result); },
      (failure: Error) => { if (active) setError(failure.message); },
    );
    return () => { active = false; };
  }, [endpoint, loadAttempt]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get('slack');
    if (!outcome || (url.searchParams.get('agent') ?? undefined) !== agent) return;
    if (outcome === 'connected') setFeedback(`${name} is connected to Slack.`);
    if (outcome === 'canceled') setFeedback('Slack authorization was canceled. You can continue setup below.');
    if (outcome === 'conflict') setError('Choose the Slack workspace already linked to this Cowork workspace, or disconnect the conflicting installation.');
    if (outcome === 'retry') setError('Slack setup could not be completed. Start again below.');
    url.searchParams.delete('slack');
    url.searchParams.delete('agent');
    window.history.replaceState(window.history.state, '', url);
  }, [agent, name]);

  async function update(action: 'connect' | 'disconnect') {
    setBusy(action);
    setError('');
    setFeedback('');
    try {
      if (action === 'connect') {
        const { authorizationUrl } = await api<{ authorizationUrl: string }>(endpoint, { action });
        window.location.assign(authorizationUrl);
        return;
      }
      setConnection(await api<SlackConnection>(endpoint, { action }));
      setFeedback('Slack disconnected.');
    } catch (failure) {
      setError((failure as Error).message);
      setLoadAttempt((previous) => previous + 1);
    } finally {
      setBusy(undefined);
    }
  }

  const connected = connection?.status === 'active';
  useEffect(() => { onConnected?.(connected); }, [onConnected, connected]);
  if (!agent && !connected && !feedback && !error) return null;
  const slackLink = connection?.appId && connection.teamId
    ? 'https://slack.com/app_redirect?' + new URLSearchParams({ app: connection.appId, team: connection.teamId })
    : undefined;
  return (
    <div className="stack">
      <h4 className="font-semibold">{agent ? `${workspaceName ?? name} · ${channelAgents[agent].role}` : 'Cowork'}</h4>
      {workspaceName && workspaceName !== name && <p>The Slack app is listed as {name}.</p>}
      <p>{connected
        ? `Connected to ${connection.team}. DM ${name}, or invite the app to a channel and mention @${name}.`
        : connection && !connection.available
          ? 'Slack setup is unavailable on this deployment.'
          : owner ? `Add ${name} to Slack to chat in a DM or channel.` : 'Your workspace owner can connect Slack.'}</p>
      {feedback && <p role="status">{feedback}</p>}
      {error && <p role="alert">{error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        {slackLink && <a className={buttonClassName('primary')} data-button-variant="primary" href={slackLink}>Open Slack</a>}
        {owner && connection?.available && !connected &&
          <Button type="button" disabled={Boolean(busy)} onClick={() => void update('connect')}>
            {busy === 'connect' ? 'Opening Slack…' : `Add ${name} to Slack`}
          </Button>}
        {owner && connected &&
          <Button variant="quiet" type="button" disabled={Boolean(busy)} onClick={() => void update('disconnect')}>
            {busy === 'disconnect' ? 'Disconnecting…' : `Disconnect ${name} from Slack`}
          </Button>}
        {!connection && (error
          ? <Button variant="quiet" type="button" onClick={() => { setError(''); setLoadAttempt((previous) => previous + 1); }}>Retry</Button>
          : <span role="status">Checking Slack connection…</span>)}
      </div>

    </div>
  );
}

export function TelegramForm({ owner, agent, name, destination, telegramBot, saveTelegram }: Pick<SettingsProps, 'owner' | 'telegramBot' | 'saveTelegram'> & {
  agent?: ChannelAgent;
  name?: string;
  destination?: string;
}) {
  const [busy, setBusy] = useState(false);
  const token = useRef<HTMLInputElement>(null);
  async function save(settings: Parameters<SettingsProps['saveTelegram']>[0]) {
    setBusy(true);
    try {
      if (await saveTelegram({ ...settings, Agent: agent }) && token.current) token.current.value = '';
    } finally {
      setBusy(false);
    }
  }
  return <div className="grid gap-y-3">
    <h4 className="font-semibold">{agent ? `${name ?? channelAgents[agent].name} · ${channelAgents[agent].role}` : 'Cowork'}</h4>
    <p>{telegramBot ? `Saved bot @${telegramBot}` : 'Add the workspace bot to your Telegram group and disable group privacy in BotFather.'}</p>
    {owner && <form className="settings-channel-form grid gap-y-3" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void save({ Token: String(data.get('Token')), Destination: String(data.get('Destination')) });
    }}>
      <label>BotFather token
        <Input ref={token} name="Token" type="password" autoComplete="off" required={!telegramBot}
          placeholder={telegramBot ? 'Enter a token to replace the saved bot' : 'Paste the bot token'} />
      </label>
      <label>Telegram group ID
        <Input name="Destination" defaultValue={destination ?? ''} required placeholder="Negative group ID" />
      </label>
      <div className="flex flex-wrap gap-3">
        <Button type="submit" disabled={busy}>Save Telegram settings</Button>
        {telegramBot && <Button variant="quiet" type="button" disabled={busy} onClick={() => void save({ Remove: true })}>Disconnect bot</Button>}
      </div>
    </form>}
  </div>;
}

function AgentConnectionForm({ owner, agentConnection, saveAgentConnection, managed }: Pick<SettingsProps, 'owner' | 'agentConnection' | 'saveAgentConnection'> & { managed: boolean }) {
  const [enabledDraft, setEnabledDraft] = useState<boolean>();
  const enabled = enabledDraft ?? agentConnection.enabled;
  const [saving, setSaving] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);

  async function save(removeKey = false) {
    setSaving(true);
    try {
      const saved = await saveAgentConnection(removeKey
        ? { Enabled: false, RemoveKey: true }
        : { Enabled: enabled, Key: keyInput.current?.value });
      if (!saved) return;
      setEnabledDraft(undefined);
      if (keyInput.current) keyInput.current.value = '';
    } finally {
      setSaving(false);
    }
  }

  if (!owner) return <p>{agentConnection.enabled ? 'Enabled' : 'Disabled'}. The workspace owner manages this connection.</p>;

  const keyControls = <div className="stack">
    <label>
      Workspace key
      <Input ref={keyInput} type="password" autoComplete="new-password" spellCheck={false} maxLength={268} disabled={saving}
        placeholder={agentConnection.hasKey ? 'Enter a replacement key' : 'Paste an existing Agent Connections key'} />
    </label>
    {!managed && !agentConnection.hasKey && <p className="text-sm">Leave this blank if your deployment supplies a workspace key.</p>}
    {agentConnection.hasKey && <Button variant="quiet" type="button" disabled={saving} onClick={() => void save(true)}>Remove key</Button>}
  </div>;
  return (
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="flex items-center gap-2">
        <input className="!w-auto" type="checkbox" checked={enabled} disabled={saving} onChange={(event) => setEnabledDraft(event.target.checked)} />
        Enable connected tools in Cowork
      </label>
      {managed ? <details>
        <summary className="cursor-pointer">Use an existing workspace key</summary>
        {keyControls}
      </details> : keyControls}
      <div><Button type="submit" disabled={saving}>Save Agent Connections settings</Button></div>
    </form>
  );
}

function GitTokenForm({ provider, configured, owner, saveGitToken }: {
  provider: GitProvider; configured: boolean; owner: boolean; saveGitToken: SettingsProps['saveGitToken'];
}) {
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function save(remove = false) {
    setSaving(true);
    try {
      const saved = await saveGitToken(remove
        ? { Provider: provider, Remove: true }
        : { Provider: provider, Token: input.current?.value });
      if (saved && input.current) input.current.value = '';
    } finally {
      setSaving(false);
    }
  }

  const name = gitProviders[provider];
  if (!owner) return <p>{configured ? 'Token saved' : 'No token saved'}</p>;
  return (
    <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>
        {name} access token
        <Input ref={input} type="password" autoComplete="new-password" spellCheck={false} maxLength={1024}
          required disabled={saving} placeholder={configured ? 'Enter a new token to replace the saved token' : 'Paste an access token'} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving}>Save token</Button>
        {configured && <Button variant="quiet" type="button" disabled={saving} onClick={() => void save(true)}>Remove token</Button>}
        <span className="text-sm">{configured ? 'Token saved' : 'No token saved'}</span>
      </div>
    </form>
  );
}

export function Settings(props: SettingsProps) {
  const [active, setActive] = useState<(typeof sections)[number]['id']>('appearance');
  useEffect(() => {
    const section = sections.find(({ id }) => id === new URLSearchParams(window.location.search).get('section'));
    if (section) setActive(section.id);
  }, []);
  return (
    <div className="settings-page">
      <header className="settings-nav-header">
        <nav aria-label="Settings sections">
          <ul role="list" className="flex flex-wrap gap-1 py-2">
            {sections.map((section) => (
              <li key={section.id}>
                <button type="button" onClick={() => setActive(section.id)} aria-current={active === section.id ? 'page' : undefined}>
                  {section.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <div className="settings-content">
        {active === 'appearance' && (
          <SettingsSection title="Color theme" description="Choose how Cowork looks in this browser.">
            <ThemeOptions theme={props.theme} changeTheme={props.changeTheme} />
          </SettingsSection>
        )}
        {active === 'members' && (
          <>
            <SettingsSection title="Workspace members" description="People who can chat with your agent and access workspace tasks and reminders.">
              <MemberList members={props.members} />
            </SettingsSection>
            {props.owner && props.invite && (
              <SettingsSection title="Invite teammates" description="Share this code with teammates so they can join during signup.">
                <InviteCode invite={props.invite} announce={props.announce} />
              </SettingsSection>
            )}
          </>
        )}
        {active === 'agent-connection' && (
          <>
            <SettingsIntro title="Agent Connections" description="Manage connected accounts and grant access to your agents. Use connected apps in conversations without guest access." />
            {props.owner && props.managedConnections && (
              <SettingsGroup id="connected-apps-settings" title="Connected apps">
                <ManagedConnections enabled agents={props.managedConnections.agents}
                  grants={props.managedConnections.grants} onGrants={props.managedConnections.saveGrants}
                  savingGrants={props.managedConnections.busy} keySaved={props.agentConnection.hasKey}
                  saveKey={async (key) => {
                    if (!await props.saveAgentConnection({ Enabled: true, Key: key })) {
                      throw new Error('Cowork could not save the workspace key.');
                    }
                  }} />
              </SettingsGroup>
            )}
            <SettingsGroup id="agent-connection-settings" title="Connection settings">
              <AgentConnectionForm owner={props.owner} agentConnection={props.agentConnection}
                saveAgentConnection={props.saveAgentConnection} managed={Boolean(props.managedConnections)} />
            </SettingsGroup>
          </>
        )}
        {active === 'git-tokens' && (
          <>
            <SettingsIntro title="Git provider access" description="Workspace owners manage these tokens. Workspace members can ask the agent to read repositories the tokens can access in conversations without guests. Use tokens with read-only repository access." />
            {(['github', 'gitlab'] as const).map((provider) => (
              <SettingsGroup key={provider} id={`${provider}-token-settings`} title={gitProviders[provider]}>
                <GitTokenForm provider={provider} configured={Boolean(props.gitTokenStatus[provider])}
                  owner={props.owner} saveGitToken={props.saveGitToken} />
              </SettingsGroup>
            ))}
          </>
        )}
        {active === 'channels' && (
          <>
            <SettingsIntro title="Messaging channels" description="Connect your Cowork agent to the places your team chats." />
            <SettingsGroup id="slack-settings" title="Slack" logo="slack">
              <div className="settings-provider-entries">
                {channelAgentIds.map((agent) => <SlackConnectionForm key={agent} owner={props.owner} agent={agent} />)}
                <SlackConnectionForm owner={props.owner} />
              </div>
            </SettingsGroup>
            <SettingsGroup id="telegram-settings" title="Telegram" logo="telegram">
              <div className="settings-provider-entries">
                {channelAgentIds.map((agent) => {
                  const telegram = props.telegramAgents?.[agent];
                  return (
                    <TelegramForm key={JSON.stringify([agent, telegram?.Username, telegram?.Destination])} owner={props.owner}
                      agent={agent} telegramBot={telegram?.Username} destination={telegram?.Destination} saveTelegram={props.saveTelegram} />
                  );
                })}
                {props.telegramBot && <TelegramForm key={JSON.stringify([props.telegramBot, props.channels.Telegram])}
                  owner={props.owner} telegramBot={props.telegramBot} destination={props.channels.Telegram} saveTelegram={props.saveTelegram} />}
              </div>
            </SettingsGroup>
            <SettingsGroup id="whatsapp-settings" title="WhatsApp" logo="whatsapp">
              <ChannelForm key={props.channels.WhatsApp} provider="WhatsApp" destination={props.channels.WhatsApp ?? ''}
                owner={props.owner} saveChannel={props.saveChannel} />
            </SettingsGroup>
          </>
        )}
      </div>
    </div>
  );
}
