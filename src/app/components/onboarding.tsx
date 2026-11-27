'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeftIcon } from '@heroicons/react/24/outline';
import { SlackConnectionForm, TelegramForm } from '../../settings';
import type { ChannelAgent } from '../../channel-agents';
import { api } from './api';
import { ManagedConnections, saveConnectionKey, type AgentGrants } from './managed-connections';
import { AgentPicker, agentCatalog, type AgentChoices } from './agent-picker';

export type WorkspaceAgent = { ID: string; Role: string; Name: string; Channel?: string; ConnectionIDs?: string[] };
type Telegram = { Username: string; Destination: string };
type Setup = {
  workspace?: { Agents?: WorkspaceAgent[]; OnboardingStep?: 'tools' | 'channels' };
  LinkRequired?: boolean;
  Imported?: boolean;
  NewWorkspace?: boolean;
};
type Channel = 'cowork' | 'slack' | 'telegram';

export function WorkspaceOnboarding<T extends Setup>({ setup, busy, save, configured, managed, grants, saveGrants, telegram, saveTelegram }: {
  setup?: T;
  busy: boolean;
  save: (input: object) => Promise<boolean>;
  configured: boolean;
  managed: boolean;
  grants: AgentGrants;
  saveGrants: (value: AgentGrants) => void;
  telegram?: Partial<Record<ChannelAgent, Telegram>>;
  saveTelegram: (settings: { Agent?: ChannelAgent; Token?: string; Destination?: string; Remove?: boolean }) => Promise<boolean>;
}) {
  const [entry, setEntry] = useState<Setup>();
  const [lookupError, setLookupError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [join, setJoin] = useState(false);
  const [choices, setChoices] = useState<AgentChoices>({});
  const [channel, setChannel] = useState<Channel>('cowork');
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [connectedSlack, setConnectedSlack] = useState<Partial<Record<ChannelAgent, boolean>>>({});
  const heading = useRef<HTMLHeadingElement>(null);
  const stage = setup?.workspace?.OnboardingStep;
  const agents = setup?.workspace?.Agents ?? [];
  const messagingAgents = agents.flatMap((agent) => {
    const option = agentCatalog.find(({ id }) => id === agent.ID);
    return option && 'messaging' in option ? [{ ...agent, slug: option.messaging }] : [];
  });

  useEffect(() => {
    if (setup) return;
    let canceled = false;
    setLookupError('');
    api<Setup>('onboarding').then(
      (value) => { if (!canceled) setEntry(value); },
      (error: Error) => { if (!canceled) setLookupError(error.message); },
    );
    return () => { canceled = true; };
  }, [setup, attempt]);

  useEffect(() => {
    if (stage === 'channels' && new URLSearchParams(window.location.search).has('slack')) setChannel('slack');
    if (stage) heading.current?.focus();
  }, [stage]);

  const channelReady = channel === 'cowork' || messagingAgents.some(({ slug }) =>
    channel === 'slack' ? connectedSlack[slug] : Boolean(telegram?.[slug]?.Username),
  );

  const submit = (event: FormEvent<HTMLFormElement>, action: (form: FormData) => void) => {
    event.preventDefault();
    action(new FormData(event.currentTarget));
  };

  async function saveExistingKey(data: FormData) {
    setKeyBusy(true);
    setKeyError('');
    try {
      await saveConnectionKey(String(data.get('Key') ?? ''));
      setKeySaved(true);
      setKeyOpen(false);
    } catch (error) {
      setKeyError((error as Error).message);
    } finally {
      setKeyBusy(false);
    }
  }

  if (!setup && !entry) return <section className="workspace-setup">
    {lookupError ? <>
      <p role="alert">{lookupError}</p>
      <button className="quiet" type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</button>
    </> : <p role="status">Loading workspace setup…</p>}
  </section>;

  if (!setup && entry?.LinkRequired) return (
    <section className="workspace-setup">
      <header><h1>Open your existing workspace</h1>
        <p>{entry.Imported ? 'Continue to link your Clerk sign-in to your Cowork account.' : 'Confirm your previous Cowork password to link your existing account.'}</p></header>
      <form className="stack" onSubmit={(event) => submit(event, (data) => { void save({ Password: data.get('Password') }); })}>
        {!entry.Imported && <label>Previous Cowork password<input autoComplete="off" name="Password" type="password" maxLength={128} required /></label>}
        <div><button className="primary" disabled={busy}>Open workspace</button></div>
      </form>
    </section>
  );

  if (stage === 'tools') return (
    <section className="workspace-setup">
      <header>
        <h1 ref={heading} tabIndex={-1}>Connect tools</h1>
        <p>Connect the accounts your agents need. You can add more in Settings.</p>
      </header>
      <div className="setup-agents" aria-label="Your agents">
        {agents.map(({ ID, Name, Role }) => <div key={ID}>
          <strong>{Name}{Name !== Role && <span> · {Role}</span>}</strong>
          <p>{agentCatalog.find(({ id }) => id === ID)?.description}</p>
        </div>)}
      </div>
      {managed ? <ManagedConnections enabled agents={agents} grants={grants} onGrants={saveGrants} savingGrants={busy}
        keySaved={configured || keySaved} saveKey={async (value) => { await saveConnectionKey(value); setKeySaved(true); }} onBusy={setToolBusy} onboarding />
        : <p>Tool setup is unavailable on this deployment. You can finish setup and connect tools later.</p>}
      {configured || keySaved ? <p className="status review" role="status">Agent Connections key saved</p>
        : keyOpen ? <form className="stack" onSubmit={(event) => submit(event, (data) => { void saveExistingKey(data); })}>
          <label>Agent Connections key
            <input name="Key" type="password" autoComplete="off" required placeholder="Paste the key from Agent Connections" />
          </label>
          {keyError && <p role="alert">{keyError}</p>}
          <div><button className="quiet" disabled={keyBusy}>Save key</button></div>
        </form> : <div><button className="quiet" type="button" onClick={() => setKeyOpen(true)}>Use an Agent Connections key</button></div>}
      <footer className="setup-controls">
        <button className="primary" disabled={busy || keyBusy || toolBusy} onClick={() => void save({ Step: 'channels' })}>Done for now</button>
      </footer>
    </section>
  );

  if (stage === 'channels') return (
    <section className="workspace-setup">
      <header>
        <h1 ref={heading} tabIndex={-1}>Where do you want to work?</h1>
        <p>Choose where to start a conversation with {agents.length === 1 ? agents[0].Name : 'your agents'}.</p>
      </header>
      <fieldset className="onboarding-roles">
        <legend className="sr-only">Conversation channel</legend>
        {([
          ['cowork', 'Cowork', 'Start a conversation here in your workspace.'],
          ['slack', 'Slack', 'Install the app to chat in Slack. Public channel threads appear in Cowork.'],
          ['telegram', 'Telegram', 'Connect an existing Telegram bot to a group.'],
        ] as const).filter(([id]) => id === 'cowork' || messagingAgents.length > 0).map(([id, title, description]) => (
          <label key={id} className="onboarding-role">
            <span><strong>{title}</strong><small>{description}</small></span>
            <input type="radio" name="where-to-work" value={id} checked={channel === id} onChange={() => setChannel(id)} />
          </label>
        ))}
      </fieldset>
      {channel !== 'cowork' && <div className="setup-agents">
        {messagingAgents.length === 0 && <p>Messaging setup is available for the Developer and Sales Lead agents.</p>}
        {messagingAgents.map(({ slug, Name }) => channel === 'slack'
          ? <SlackConnectionForm key={slug} owner agent={slug} workspaceName={Name} onConnected={(value) => {
            setConnectedSlack((current) => current[slug] === value ? current : { ...current, [slug]: value });
          }} />
          : <TelegramForm key={slug} owner agent={slug} name={Name} telegramBot={telegram?.[slug]?.Username}
            destination={telegram?.[slug]?.Destination} saveTelegram={saveTelegram} />)}
      </div>}
      <footer className="setup-controls">
        <button className="primary" disabled={busy || !channelReady} onClick={() => void save({ Step: 'complete', Channel: channel })}>
          {channel === 'cowork' ? 'Open conversations' : 'Finish setup'}
        </button>
        {channel !== 'cowork' && <button className="quiet" disabled={busy} onClick={() => void save({ Step: 'complete', Channel: 'cowork' })}>Start in Cowork instead</button>}
      </footer>
    </section>
  );

  if (join) return (
    <section className="workspace-setup">
      <header><h1>Join your workspace</h1><p>Enter the invite code your teammate shared.</p></header>
      <form className="stack" onSubmit={(event) => submit(event, (data) => { void save({ Invite: data.get('Invite') }); })}>
        <label>Workspace invite code<input name="Invite" required autoComplete="off" /></label>
        <footer className="setup-controls">
          <button className="primary" disabled={busy}>Join workspace</button>
          <button className="quiet" type="button" onClick={() => setJoin(false)}><ArrowLeftIcon className="size-4" aria-hidden="true" /> Back</button>
        </footer>
      </form>
    </section>
  );

  return <AgentPicker choices={choices} setChoices={setChoices} busy={busy}
    join={() => setJoin(true)} continueSetup={(Agents) => { void save({ Agents }); }} />;
}
