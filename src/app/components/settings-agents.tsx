import { PlusIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { useEffect, useId, useRef, useState } from 'react';
import { agentCatalog, type AgentChannel, type AgentSetup, type AgentUpdate, type WorkspaceAgent } from '../lib/workspace-agents';
import { Button } from './button';
import { Modal } from './forms';
import { Input } from './input';
import { Select } from './select';

const channelNames = { cowork: 'Cowork', slack: 'Slack', telegram: 'Telegram' } satisfies Record<AgentChannel, string>;
type AgentDetails = { name: string; channel: AgentChannel };
const defaultDetails: AgentDetails = { name: '', channel: 'cowork' };
type UpdateAgent = (input: AgentUpdate, onError: (message: string) => void) => Promise<boolean>;
type RemoveAgent = (id: string, onError: (message: string) => void) => Promise<boolean>;

function AgentFields({ role, telegram, details, setDetails, busy, channelHelp }: {
  role: string; telegram: boolean; details: AgentDetails; setDetails: (details: AgentDetails) => void; busy: boolean;
  channelHelp?: string;
}) {
  const helpId = useId();
  return <>
    <label>Agent name (optional)
      <Input value={details.name} placeholder={role} maxLength={48} disabled={busy}
        onChange={(event) => setDetails({ ...details, name: event.target.value })} />
    </label>
    <div className="grid gap-1.5">
      <label>Preferred channel
        <Select value={details.channel} disabled={busy} aria-describedby={channelHelp ? helpId : undefined}
          onChange={(event) => setDetails({ ...details, channel: event.target.value as AgentChannel })}>
          {Object.entries(channelNames).filter(([id]) => telegram || id !== 'telegram').map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
      </label>
      {channelHelp && <small id={helpId}>{channelHelp}</small>}
    </div>
  </>;
}

function EditAgentForm({ agent, telegram, busy, updateAgent, canRemove, removeAgent, close, saved, removed }: {
  agent: WorkspaceAgent; telegram: boolean; busy: boolean; updateAgent: UpdateAgent; close: () => void; saved: () => void;
  canRemove: boolean; removeAgent: RemoveAgent; removed: () => void;
}) {
  const [initial] = useState<AgentDetails>(() => ({ name: agent.Name, channel: agent.Channel ?? 'cowork' }));
  const [details, setDetails] = useState(initial);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removeError, setRemoveError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const nameChanged = details.name !== initial.name;
  const channelChanged = details.channel !== initial.channel;
  useEffect(() => { heading.current?.focus(); }, []);

  return <><form id="edit-agent-form" className="stack mt-4" aria-labelledby="edit-agent-heading" onSubmit={async (event) => {
    event.preventDefault();
    if (busy || (!nameChanged && !channelChanged)) return;
    setError('');
    const changes: AgentUpdate = { ID: agent.ID };
    if (nameChanged) changes.Name = details.name;
    if (channelChanged) changes.Channel = details.channel;
    if (await updateAgent(changes, setError)) saved();
  }}>
    <h3 id="edit-agent-heading" ref={heading} tabIndex={-1}>Edit agent</h3>
    <AgentFields role={agent.Role} telegram={telegram} details={details} setDetails={setDetails} busy={busy}
      channelHelp="Connect or disconnect Slack and Telegram in Messaging channels." />
    {error && <p role="alert">{error}</p>}
    <div className="setup-controls">
      <Button type="submit" disabled={busy || (!nameChanged && !channelChanged)}>{busy ? 'Saving…' : 'Save changes'}</Button>
      <Button variant="quiet" type="button" onClick={close} disabled={busy}>Cancel</Button>
      {canRemove && <Button variant="quiet" className="ml-auto text-[var(--warning)]" disabled={busy} onClick={() => {
        setRemoveError('');
        setConfirmRemove(true);
      }}>Remove agent</Button>}
    </div>
    {!canRemove && <p className="text-sm">Keep at least one agent in the workspace.</p>}
  </form>
  {confirmRemove && <Modal title="Remove agent?" close={() => { if (!busy) setConfirmRemove(false); }}>
    <div className="stack">
      <p className="wrap-anywhere">Remove <strong>{agent.Name}</strong> from this workspace?</p>
      <p>Conversations assigned to this agent become read-only, and upcoming schedules are canceled. You can still view and reassign their tasks.</p>
      <p>The agent stops responding in connected messaging channels. You can remove the app from Slack in your Slack workspace.</p>
      {removeError && <p role="alert">{removeError}</p>}
      <div className="setup-controls">
        <Button variant="quiet" disabled={busy} onClick={() => setConfirmRemove(false)}>Cancel</Button>
        <Button className="[--button-primary:var(--warning)] [--button-primary-hover:var(--warning)] [--button-on-primary:var(--warning-bg)]"
          disabled={busy} onClick={async () => {
            setRemoveError('');
            if (await removeAgent(agent.ID, setRemoveError)) removed();
          }}>{busy ? 'Removing…' : 'Remove agent'}</Button>
      </div>
    </div>
  </Modal>}
  </>;
}

export function SettingsAgents({ agents, owner, busy, addAgent, updateAgent, removeAgent, openTools, openChannels }: {
  agents: WorkspaceAgent[];
  owner: boolean;
  busy: boolean;
  addAgent: (input: AgentSetup, onError: (message: string) => void) => Promise<boolean>;
  updateAgent: UpdateAgent;
  removeAgent: RemoveAgent;
  openTools?: () => void;
  openChannels: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string>();
  const [role, setRole] = useState<AgentSetup['ID']>();
  const [details, setDetails] = useState(defaultDetails);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const formHeading = useRef<HTMLHeadingElement>(null);
  const feedback = useRef<HTMLParagraphElement>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);
  const available = agentCatalog.filter((option) => !agents.some((agent) => agent.Role === option.role));
  const selected = available.find(({ id }) => id === role);
  const canAdd = owner && available.length > 0;
  const showForm = canAdd && adding;
  const hasMessaging = agents.some(({ ID }) => ID);

  useEffect(() => { if (showForm) formHeading.current?.focus(); }, [showForm]);
  useEffect(() => { if (message) feedback.current?.focus(); }, [message]);

  function toggleForm() {
    setAdding(!adding);
    setRole(undefined);
    setDetails(defaultDetails);
    setError('');
    setMessage('');
  }

  return <div className="stack">
    <ul role="list" className="setup-agents" aria-label="Enabled agents">
      {agents.map((agent) => {
        const option = agentCatalog.find(({ role }) => role === agent.Role);
        const Icon = option?.icon ?? SparklesIcon;
        const messaging = Boolean(option && 'messaging' in option);
        const isEditing = editing === agent.ID;
        const roleLabel = agent.Name !== agent.Role ? agent.Role : '';
        const channelLabel = agent.Channel && agent.Channel !== 'cowork' ? `Prefers ${channelNames[agent.Channel]}` : '';
        const subtitle = [roleLabel, channelLabel].filter(Boolean).join(' · ');
        return <li key={agent.ID}>
          <div className="flex items-start gap-3">
            <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-[var(--accent-text)]" />
            <div className="min-w-0 flex-1 wrap-anywhere">
              <strong>{agent.Name}</strong>
              {subtitle && <p className="text-sm">{subtitle}</p>}
            </div>
            {owner && agent.ID && <Button variant="quiet" className="shrink-0" type="button" aria-label={`Edit ${agent.Name} (${agent.Role})`}
              aria-expanded={isEditing} aria-controls={isEditing ? 'edit-agent-form' : undefined}
              disabled={busy || showForm || (editing !== undefined && !isEditing)} onClick={(event) => {
                editTrigger.current = event.currentTarget;
                setEditing(isEditing ? undefined : agent.ID);
                setMessage('');
              }}>Edit</Button>}
          </div>
          {owner && isEditing && <EditAgentForm agent={agent} telegram={messaging} busy={busy} updateAgent={updateAgent}
            canRemove={agents.length > 1} removeAgent={removeAgent}
            close={() => { setEditing(undefined); editTrigger.current?.focus(); }}
            saved={() => { setEditing(undefined); setMessage('Agent settings saved.'); }}
            removed={() => { setEditing(undefined); setMessage(`${agent.Name} was removed.`); }} />}
        </li>;
      })}
    </ul>
    {message && <p ref={feedback} tabIndex={-1} className="status review justify-self-start">{message}</p>}
    {owner && editing === undefined && <div className="setup-controls">
      {canAdd && <Button variant={showForm ? 'quiet' : 'primary'} type="button" disabled={busy}
        aria-expanded={showForm} aria-controls={showForm ? 'add-agent-form' : undefined} onClick={toggleForm}>
        {!showForm && <PlusIcon aria-hidden="true" className="size-4" />}{showForm ? 'Cancel setup' : 'Add agent'}
      </Button>}
      {!showForm && openTools && <Button variant="quiet" type="button" onClick={openTools}>Connect tools</Button>}
      {!showForm && hasMessaging && <Button variant="quiet" type="button" onClick={openChannels}>Manage messaging</Button>}
    </div>}
    {owner && !canAdd && editing === undefined && <p className="text-sm">Every available role is already in this workspace.</p>}
    {showForm && <form id="add-agent-form" className="stack" aria-labelledby="add-agent-heading" onSubmit={async (event) => {
      event.preventDefault();
      if (!selected || busy) return;
      setError('');
      const saved = await addAgent({ ID: selected.id, Name: details.name, Channel: details.channel }, setError);
      if (saved) {
        toggleForm();
        setMessage(`${details.name.trim() || selected.role} is ready in Cowork.`);
      }
    }}>
      <h3 id="add-agent-heading" ref={formHeading} tabIndex={-1}>Add an agent</h3>
      <fieldset className="onboarding-roles settings-agent-roles" disabled={busy}>
        <legend className="mb-2 text-sm font-semibold">Role</legend>
        {available.map(({ id, role: label, description, icon: Icon }) => <label className="onboarding-role" key={id}>
          <Icon aria-hidden="true" className="size-5" />
          <span><strong>{label}</strong><small>{description}</small></span>
          <input type="radio" name="agent-role" checked={role === id} required onChange={() => {
            setRole(id);
            setDetails({ ...details, channel: 'cowork' });
          }} />
        </label>)}
      </fieldset>
      {selected && <AgentFields role={selected.role} telegram={'messaging' in selected} details={details} setDetails={setDetails} busy={busy}
        channelHelp={details.channel === 'cowork' ? undefined : `Finish connecting ${channelNames[details.channel]} in Messaging channels.`} />}
      {error && <p role="alert">{error}</p>}
      <Button className="justify-self-start" type="submit" disabled={busy || !selected}>{busy ? 'Adding agent…' : 'Add to workspace'}</Button>
    </form>}
  </div>;
}
