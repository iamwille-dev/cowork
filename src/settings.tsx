import { useRef, useState, type ReactNode } from 'react';

const sections = [
  { id: 'appearance', title: 'Appearance' },
  { id: 'members', title: 'Members' },
  { id: 'channels', title: 'Messaging channels' },
  { id: 'agent-connection', title: 'Agent Connection' },
  { id: 'git-tokens', title: 'Git tokens' },
] as const;

const providers = ['Slack', 'WhatsApp'] as const;
type Provider = typeof providers[number];
const gitProviders = { github: 'GitHub', gitlab: 'GitLab' } as const;
export type GitProvider = keyof typeof gitProviders;
type Theme = 'light' | 'dark';

type SettingsProps = {
  theme: Theme;
  members: { ID: string; Name: string; Email: string; Role: string }[];
  owner: boolean;
  invite: string;
  channels: Partial<Record<Provider | 'Telegram', string>>;
  telegramBot?: string;
  saveTelegram: (settings: { Token?: string; Destination?: string; Remove?: boolean }) => Promise<boolean>;
  changeTheme: (theme: Theme) => void;
  saveChannel: (provider: Provider, destination: string, button: HTMLButtonElement) => void;
  agentConnection: { enabled: boolean; hasKey: boolean };
  saveAgentConnection: (settings: { Enabled: boolean; Key?: string; RemoveKey?: boolean }) => Promise<boolean>;
  gitTokenStatus: Partial<Record<GitProvider, boolean>>;
  saveGitToken: (settings: { Provider: GitProvider; Token?: string; Remove?: boolean }) => Promise<boolean>;
  announce: (message: string) => void;
};

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="settings-form-section grid grid-cols-1 gap-x-8 gap-y-5 px-4 py-8 sm:px-6 md:grid-cols-3 lg:px-8">
      <div>
        <h2 className="text-base/7 font-semibold">{title}</h2>
        <p className="mt-1 text-sm/6">{description}</p>
      </div>
      <div className="min-w-0 md:col-span-2"><div className="max-w-xl">{children}</div></div>
    </section>
  );
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
        <input id="invite-code" ref={input} value={invite} readOnly />
      </label>
      <button className="quiet" type="button" onClick={copyCode}>Copy code</button>
    </div>
  );
}

function ChannelForm({ provider, destination, owner, saveChannel }: {
  provider: Provider; destination: string; owner: boolean; saveChannel: SettingsProps['saveChannel'];
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
        {provider}
        <input name="Destination" defaultValue={destination} readOnly={!owner} placeholder="Channel or conversation ID" />
      </label>
      {owner && <button className="primary" type="submit" ref={submit}>Save</button>}
    </form>
  );
}

function TelegramForm({ owner, channels, telegramBot, saveTelegram }: Pick<SettingsProps, 'owner' | 'channels' | 'telegramBot' | 'saveTelegram'>) {
  const [busy, setBusy] = useState(false);
  const token = useRef<HTMLInputElement>(null);
  async function save(settings: Parameters<SettingsProps['saveTelegram']>[0]) {
    setBusy(true);
    try {
      if (await saveTelegram(settings) && token.current) token.current.value = '';
    } finally {
      setBusy(false);
    }
  }
  return <div className="grid gap-y-3">
    <h3 className="font-semibold">Telegram</h3>
    <p>{telegramBot ? `Saved bot @${telegramBot}` : 'Add the workspace bot to your Telegram group and disable group privacy in BotFather.'}</p>
    {owner && <form className="settings-channel-form grid gap-y-3" onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      void save({ Token: String(data.get('Token')), Destination: String(data.get('Destination')) });
    }}>
      <label>BotFather token
        <input ref={token} name="Token" type="password" autoComplete="off" required={!telegramBot}
          placeholder={telegramBot ? 'Enter a token to replace the saved bot' : 'Paste the bot token'} />
      </label>
      <label>Telegram group ID
        <input name="Destination" defaultValue={channels.Telegram ?? ''} required placeholder="Negative group ID" />
      </label>
      <div className="flex flex-wrap gap-3">
        <button className="primary" type="submit" disabled={busy}>Save Telegram settings</button>
        {telegramBot && <button className="quiet" type="button" disabled={busy} onClick={() => void save({ Remove: true })}>Disconnect bot</button>}
      </div>
    </form>}
  </div>;
}

function AgentConnectionForm({ owner, agentConnection, saveAgentConnection }: Pick<SettingsProps, 'owner' | 'agentConnection' | 'saveAgentConnection'>) {
  const [enabled, setEnabled] = useState(agentConnection.enabled);
  const [saving, setSaving] = useState(false);
  const keyInput = useRef<HTMLInputElement>(null);

  async function save(removeKey = false) {
    setSaving(true);
    try {
      const saved = await saveAgentConnection(removeKey
        ? { Enabled: false, RemoveKey: true }
        : { Enabled: enabled, Key: keyInput.current?.value });
      if (!saved) return;
      if (removeKey) setEnabled(false);
      if (keyInput.current) keyInput.current.value = '';
    } finally {
      setSaving(false);
    }
  }

  if (!owner) return <p>{agentConnection.enabled ? 'Enabled' : 'Disabled'}. The workspace owner manages this connection.</p>;

  return (
    <form className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label className="flex items-center gap-2">
        <input className="!w-auto" type="checkbox" checked={enabled} disabled={saving} onChange={(event) => setEnabled(event.target.checked)} />
        Enable Agent Connection
      </label>
      <label>
        Agent key
        <input ref={keyInput} type="password" autoComplete="new-password" spellCheck={false} maxLength={268} disabled={saving}
          placeholder={agentConnection.hasKey ? 'Enter a new key to replace the saved key' : 'Paste a named agent key'} />
      </label>
      <p className="text-sm">{agentConnection.hasKey
        ? 'A workspace key is saved.'
        : 'Add a key from Agent Connections, or leave this blank if your deployment has assigned a key to this workspace.'}</p>
      <div className="flex flex-wrap gap-3">
        <button className="primary" type="submit" disabled={saving}>Save</button>
        {agentConnection.hasKey && <button className="quiet" type="button" disabled={saving} onClick={() => void save(true)}>Remove key</button>}
      </div>
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
  if (!owner) return <p>{name} · {configured ? 'Token saved' : 'No token saved'}</p>;
  return (
    <form className="grid gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <label>
        {name} access token
        <input ref={input} type="password" autoComplete="new-password" spellCheck={false} maxLength={1024}
          required disabled={saving} placeholder={configured ? 'Enter a new token to replace the saved token' : 'Paste an access token'} />
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="primary" type="submit" disabled={saving}>Save token</button>
        {configured && <button className="quiet" type="button" disabled={saving} onClick={() => void save(true)}>Remove token</button>}
        <span className="text-sm">{configured ? 'Token saved' : 'No token saved'}</span>
      </div>
    </form>
  );
}

export function Settings(props: SettingsProps) {
  const [active, setActive] = useState<(typeof sections)[number]['id']>('appearance');
  return (
    <div className="settings-page">
      <header className="settings-nav-header">
        <nav aria-label="Settings sections">
          <ul role="list" className="flex flex-wrap gap-1 px-3 py-2.5 sm:px-5 lg:px-7">
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
        <SettingsSection title="Agent Connection" description="Let your Cowork agent search and read a connected work Gmail mailbox. Use a conversation without guest access.">
          <AgentConnectionForm owner={props.owner} agentConnection={props.agentConnection} saveAgentConnection={props.saveAgentConnection} />
        </SettingsSection>
      )}
      {active === 'git-tokens' && (
        <SettingsSection title="Git provider access" description="Workspace owners manage these tokens. Workspace members can ask the agent to read repositories the tokens can access in conversations without guests. Use tokens with read-only repository access.">
          <div className="grid gap-y-6">
            {(['github', 'gitlab'] as const).map((provider) => (
              <GitTokenForm key={provider} provider={provider} configured={Boolean(props.gitTokenStatus[provider])}
                owner={props.owner} saveGitToken={props.saveGitToken} />
            ))}
          </div>
        </SettingsSection>
      )}
      {active === 'channels' && (
        <SettingsSection title="Channel destinations" description="Connect a Telegram bot for this workspace. Slack and WhatsApp currently save destination IDs for future use.">
          <div className="grid gap-y-5">
            <TelegramForm key={JSON.stringify([props.telegramBot, props.channels.Telegram])} {...props} />
            {providers.map((provider) => (
              <ChannelForm key={JSON.stringify([provider, props.channels[provider]])}
                provider={provider} destination={props.channels[provider] ?? ''}
                owner={props.owner} saveChannel={props.saveChannel} />
            ))}
          </div>
        </SettingsSection>
      )}
    </div>
  );
}
