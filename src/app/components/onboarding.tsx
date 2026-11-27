'use client';

import { Button } from './button';
import { Input } from './input';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Image from 'next/image';
import { ArrowLeftIcon, ArrowRightIcon } from '@heroicons/react/24/outline';
import { SlackConnectionForm, TelegramForm } from '../../settings';
import type { ChannelAgent } from '../../channel-agents';
import type { AgentChannel, WorkspaceAgent } from '../lib/workspace-agents';
import { api } from './api';
import { ManagedConnections, saveConnectionKey, type AgentGrants } from './managed-connections';
import { AgentPicker, agentCatalog, type AgentChoices } from './agent-picker';
import catalogStyles from './connection-catalog.module.css';
type Telegram = { Username: string; Destination: string };
type Setup = {
  workspace?: { Agents?: WorkspaceAgent[]; OnboardingStep?: 'tools' | 'channels' };
  LinkRequired?: boolean;
  Imported?: boolean;
  NewWorkspace?: boolean;
};

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
  const [channel, setChannel] = useState<AgentChannel>('cowork');
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState('');
  const [keySaved, setKeySaved] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [connectedSlack, setConnectedSlack] = useState<Record<string, boolean>>({});
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

  const channelReady = channel === 'cowork' || (channel === 'slack'
    ? agents.some(({ ID }) => connectedSlack[ID])
    : messagingAgents.some(({ slug }) => Boolean(telegram?.[slug]?.Username)));

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
      <Button variant="quiet" type="button" onClick={() => setAttempt((value) => value + 1)}>Try again</Button>
    </> : <p role="status">Loading workspace setup…</p>}
  </section>;

  if (!setup && entry?.LinkRequired) return (
    <section className="workspace-setup">
      <header><h1>Open your existing workspace</h1>
        <p>{entry.Imported ? 'Continue to link your Clerk sign-in to your Cowork account.' : 'Confirm your previous Cowork password to link your existing account.'}</p></header>
      <form className="stack" onSubmit={(event) => submit(event, (data) => { void save({ Password: data.get('Password') }); })}>
        {!entry.Imported && <label>Previous Cowork password<Input autoComplete="off" name="Password" type="password" maxLength={128} required /></label>}
        <div><Button type="submit" disabled={busy}>Open workspace</Button></div>
      </form>
    </section>
  );

  if (stage === 'tools') return (
    <section className={catalogStyles.setup}>
      <header className={catalogStyles.intro}>
        <h1 ref={heading} tabIndex={-1}>Connect tools</h1>
        <p>Connect the apps your agents need. You can add more in Settings.</p>
      </header>
      <div className={catalogStyles.layout}>
        <ManagedConnections enabled={managed} agents={agents} grants={grants} onGrants={saveGrants} savingGrants={busy}
          keySaved={configured || keySaved} saveKey={async (value) => { await saveConnectionKey(value); setKeySaved(true); }}
          onBusy={setToolBusy} onboarding />
        <aside className={catalogStyles.team} aria-label="Your agents">
          <header className={catalogStyles.teamHeader}><h2>Your agents</h2></header>
          <ul className={catalogStyles.teamList} role="list">
            {agents.map(({ ID, Name, Role }) => {
              const agent = agentCatalog.find(({ id }) => id === ID);
              return <li key={ID}>
                {agent && <Image src={agent.artwork} alt="" unoptimized />}
                <div><strong>{Name}</strong>{Name !== Role && <small>{Role}</small>}</div>
              </li>;
            })}
          </ul>
          <footer className={catalogStyles.teamFooter}>
            <Button type="button" disabled={busy || keyBusy || toolBusy}
              onClick={() => void save({ Step: 'channels' })}>
              Continue to channels <ArrowRightIcon className="size-4" aria-hidden="true" />
            </Button>
            {configured || keySaved ? <div><span className="status review" role="status">Agent Connections key saved</span></div>
              : keyOpen ? <form className="stack" onSubmit={(event) => submit(event, (data) => { void saveExistingKey(data); })}>
                <label>Agent Connections key
                  <Input name="Key" type="password" autoComplete="off" required placeholder="Paste your existing key" />
                </label>
                {keyError && <p role="alert">{keyError}</p>}
                <div><Button variant="quiet" type="submit" disabled={keyBusy}>Save key</Button></div>
              </form> : <Button variant="quiet" type="button" onClick={() => setKeyOpen(true)}>Use an existing key</Button>}
          </footer>
        </aside>
      </div>
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
        ] as const).filter(([id]) => id !== 'telegram' || messagingAgents.length > 0).map(([id, title, description]) => (
          <label key={id} className="onboarding-role">
            <span><strong>{title}</strong><small>{description}</small></span>
            <input type="radio" name="where-to-work" value={id} checked={channel === id} onChange={() => setChannel(id)} />
          </label>
        ))}
      </fieldset>
      {channel === 'slack' && <div className="setup-agents">
        {agents.map((agent) => <SlackConnectionForm key={agent.ID} owner workspaceAgent={agent} onConnected={(value) => {
          setConnectedSlack((current) => current[agent.ID] === value ? current : { ...current, [agent.ID]: value });
        }} />)}
      </div>}
      {channel === 'telegram' && <div className="setup-agents">
        {messagingAgents.map(({ slug, Name }) => <TelegramForm key={slug} owner agent={slug} name={Name}
          telegramBot={telegram?.[slug]?.Username} destination={telegram?.[slug]?.Destination} saveTelegram={saveTelegram} />)}
      </div>}
      <footer className="setup-controls">
        <Button disabled={busy || !channelReady} onClick={() => void save({ Step: 'complete', Channel: channel })}>
          {channel === 'cowork' ? 'Open conversations' : 'Finish setup'}
        </Button>
        {channel !== 'cowork' && <Button variant="quiet" disabled={busy} onClick={() => void save({ Step: 'complete', Channel: 'cowork' })}>Start in Cowork instead</Button>}
      </footer>
    </section>
  );

  if (join) return (
    <section className="workspace-setup">
      <header><h1>Join your workspace</h1><p>Enter the invite code your teammate shared.</p></header>
      <form className="stack" onSubmit={(event) => submit(event, (data) => { void save({ Invite: data.get('Invite') }); })}>
        <label>Workspace invite code<Input name="Invite" required autoComplete="off" /></label>
        <footer className="setup-controls">
          <Button type="submit" disabled={busy}>Join workspace</Button>
          <Button variant="quiet" type="button" onClick={() => setJoin(false)}><ArrowLeftIcon className="size-4" aria-hidden="true" /> Back</Button>
        </footer>
      </form>
    </section>
  );

  return <AgentPicker choices={choices} setChoices={setChoices} busy={busy}
    join={() => setJoin(true)} continueSetup={(Agents) => { void save({ Agents }); }} />;
}
