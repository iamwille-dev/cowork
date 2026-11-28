import { PlusIcon, SparklesIcon } from '@heroicons/react/24/outline';
import { useEffect, useId, useRef, useState } from 'react';
import { agentCatalog, type AgentChannel, type AgentMemory, type AgentMemoryUpdate, type AgentSetup, type AgentUpdate, type WorkspaceAgent } from '../lib/workspace-agents';
import { Button } from './button';
import { Modal } from './forms';
import { Input, Textarea } from './input';
import { Select } from './select';

const channelNames = { cowork: 'Cowork', slack: 'Slack', telegram: 'Telegram' } satisfies Record<AgentChannel, string>;
type AgentDetails = { name: string; channel: AgentChannel };
const defaultDetails: AgentDetails = { name: '', channel: 'cowork' };
type UpdateAgent = (input: AgentUpdate, onError: (message: string) => void) => Promise<boolean>;
type RemoveAgent = (id: string, onError: (message: string) => void) => Promise<boolean>;
type SaveMemory = (input: AgentMemoryUpdate, onError: (message: string) => void) => Promise<boolean>;

const emptyMemory: AgentMemory = { Revision: '', Items: [] };

function AgentMemorySummary({ agent, memory, busy, save }: {
  agent: WorkspaceAgent; memory: AgentMemory; busy: boolean; save: SaveMemory;
}) {
  const [revision, setRevision] = useState<string>();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const summary = useRef<HTMLElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const labelId = useId();
  const editing = revision !== undefined;
  useEffect(() => { if (editing) editor.current?.focus(); }, [editing]);

  function closeEditor() {
    setRevision(undefined);
    setError('');
    summary.current?.focus();
  }

  return <details className="mt-2 text-sm">
    <summary ref={summary} className="w-fit cursor-pointer rounded py-2 font-medium" aria-label={`Memory for ${agent.Name}`}>
      Memory{memory.Items.length > 0 && <span className="ml-2 font-normal">({memory.Items.length})</span>}
    </summary>
    <div className="grid gap-3 border-t border-[var(--line)] pt-3">
      <p className="text-[var(--muted)]">This agent uses your saved facts and preferences in Cowork.</p>
      {editing ? <form className="grid gap-3" onSubmit={async (event) => {
        event.preventDefault();
        if (busy) return;
        setError('');
        const Items = [...new Set(draft.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
        if (await save({ ID: agent.ID, Revision: revision, Items }, setError)) {
          closeEditor();
          setStatus('Memory saved.');
        }
      }}>
        <label className="grid gap-1.5">
          Memory items
          <Textarea ref={editor} rows={5} value={draft} disabled={busy} aria-describedby={labelId}
            onChange={(event) => setDraft(event.target.value)} />
        </label>
        <p id={labelId} className="text-[var(--muted)]">Enter one item per line. To clear the list, delete all the lines and save.</p>
        {error && <p role="alert">{error}</p>}
        <div className="setup-controls">
          <Button type="submit" disabled={busy}>Save memory</Button>
          <Button variant="quiet" disabled={busy} onClick={closeEditor}>Cancel</Button>
        </div>
      </form> : <>
        {memory.Items.length ? <ul className="grid list-disc gap-1.5 pl-5" aria-label={`Saved memory for ${agent.Name}`}>
          {memory.Items.map((item) => <li className="wrap-anywhere" key={item}>{item}</li>)}
        </ul> : <p className="text-[var(--muted)]">No saved items yet. Tell the agent what to remember in chat or add an item here.</p>}
        <Button variant="quiet" className="justify-self-start" disabled={busy} onClick={() => {
          setDraft(memory.Items.join('\n'));
          setRevision(memory.Revision);
          setStatus('');
        }}>{memory.Items.length ? 'Edit memory' : 'Add memory'}</Button>
      </>}
      <p role="status" className={status ? 'text-[var(--muted)]' : 'sr-only'}>{status}</p>
    </div>
  </details>;
}

function AgentFields({ role, details, setDetails, busy, channelHelp }: {
  role: string; details: AgentDetails; setDetails: (details: AgentDetails) => void; busy: boolean;
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
          {Object.entries(channelNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </Select>
      </label>
      {channelHelp && <small id={helpId}>{channelHelp}</small>}
    </div>
  </>;
}

function EditAgentForm({ agent, busy, updateAgent, canRemove, removeAgent, close, saved, removed }: {
  agent: WorkspaceAgent; busy: boolean; updateAgent: UpdateAgent; close: () => void; saved: () => void;
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
    <AgentFields role={agent.Role} details={details} setDetails={setDetails} busy={busy}
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

export function SettingsAgents({ agents, owner, busy, addAgent, updateAgent, removeAgent, memories, saveMemory, openTools, openChannels }: {
  agents: WorkspaceAgent[];
  owner: boolean;
  busy: boolean;
  addAgent: (input: AgentSetup, onError: (message: string) => void) => Promise<boolean>;
  updateAgent: UpdateAgent;
  removeAgent: RemoveAgent;
  memories: Record<string, AgentMemory>;
  saveMemory: SaveMemory;
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
          {!isEditing && <AgentMemorySummary agent={agent} memory={memories[agent.ID] ?? emptyMemory} busy={busy} save={saveMemory} />}
          {owner && isEditing && <EditAgentForm agent={agent} busy={busy} updateAgent={updateAgent}
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
      {selected && <AgentFields role={selected.role} details={details} setDetails={setDetails} busy={busy}
        channelHelp={details.channel === 'cowork' ? undefined : `Finish connecting ${channelNames[details.channel]} in Messaging channels.`} />}
      {error && <p role="alert">{error}</p>}
      <Button className="justify-self-start" type="submit" disabled={busy || !selected}>{busy ? 'Adding agent…' : 'Add to workspace'}</Button>
    </form>}
  </div>;
}
