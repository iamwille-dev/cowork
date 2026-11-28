'use client';

import { Button } from './button';
import { Input, Textarea } from './input';
import { useState, type DragEvent } from 'react';
import {
  ArrowPathRoundedSquareIcon, CalendarDaysIcon, CheckCircleIcon, ClockIcon, EllipsisVerticalIcon,
  ExclamationCircleIcon, EyeIcon, LockClosedIcon, RectangleStackIcon, SparklesIcon, UserIcon,
} from '@heroicons/react/24/outline';
import { taskStatuses, type TaskStatus } from '../../task-status';
import { initials } from './api';
import { Modal } from './forms';
import { Select } from './select';
import styles from './task-board.module.css';

type Cadence = 'daily' | 'weekly';
type TaskNote = { Author: string; Text: string; At: string };
export type Task = {
  ID: string; Title: string; Author: string; Status: string; Brief: string; Error?: string; ThreadID?: string;
  AgentID?: string; AgentRole?: string; AssigneeMemberID?: string; Repository?: string; Steps?: string[];
  Artifacts?: { Name: string; URL: string }[]; ScheduledFor?: string; ScheduledTimeZone?: string;
  ScheduledStarted?: string; WorkflowStarted?: string; Recurrence?: Cadence; RunRecurrence?: Cadence; Result?: string;
  Notes?: TaskNote[]; PrivateMemberID?: string;
};

export function TaskArtifacts({ task, inline = false }: { task: Task; inline?: boolean }) {
  const prefix = `/api/artifact/${task.ID}/`;
  const artifacts = (task.Artifacts ?? []).filter(({ URL }) =>
    URL.startsWith('https://') || (URL.startsWith(prefix) && /^[-\w]+\.(md|png|html)$/.test(URL.slice(prefix.length))),
  );
  const screenshot = artifacts.find(({ URL }) => URL === prefix + 'screenshot.png');
  const preview = artifacts.find(({ URL }) => URL === prefix + 'preview.html');
  const [showPreview, setShowPreview] = useState(false);

  if (!artifacts.length) return null;
  return <>
    {inline && screenshot && <a className="task-review-image" href={screenshot.URL} target="_blank" rel="noopener">
      {/* Authenticated artifact URLs are served directly by Cowork. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={screenshot.URL} alt={`Screenshot of ${task.Title}`} loading="lazy" />
    </a>}
    {inline && showPreview && preview && <iframe className="task-review-preview" src={preview.URL} sandbox="" title={`Preview of ${task.Title}`} />}
    <div className="artifact-list">
      {artifacts.map(({ URL, Name }) => inline && URL === preview?.URL
        ? <button key={URL} type="button" aria-expanded={showPreview} onClick={() => setShowPreview(!showPreview)}>{showPreview ? 'Hide preview' : 'View preview'}</button>
        : <a key={URL} href={URL} target="_blank" rel="noopener">{Name}</a>)}
    </div>
  </>;
}

export function ConversationTaskReview({ tasks }: { tasks: Task[] }) {
  if (!tasks.length) return null;
  return <section className="chat-task-reviews" aria-label="Task reviews">
    {[...tasks].reverse().map((task, index) => <details className="chat-task-review panel" key={task.ID} open={index === 0}>
      <summary><strong>{task.Title}</strong><span className={'status ' + taskGroup(task.Status)}>{task.Status}</span></summary>
      <div className="chat-task-review-body">
        {task.Error && <p className="task-error">{task.Error}</p>}
        <AgentTaskNotes task={task} />
        {task.Result && <p className="whitespace-pre-wrap break-words">{task.Result}</p>}
        <TaskArtifacts task={task} inline />
      </div>
    </details>)}
  </section>;
}

function AgentTaskNotes({ task, className }: { task: Task; className?: string }) {
  if (!task.Notes?.length) return null;
  return <section className={className} aria-label="Agent notes">
    <h3>Agent notes</h3>
    <ul className="mt-2 grid gap-3">
      {[...task.Notes].reverse().map((note, index) => <li key={note.At + index}>
        <small>{note.Author} · <time dateTime={note.At}>{new Date(note.At).toLocaleString()}</time></small>
        <p className="whitespace-pre-wrap break-words">{note.Text}</p>
      </li>)}
    </ul>
  </section>;
}

function taskGroup(status: string) {
  if (status === 'Scheduled' || status === 'Paused' || status === 'Canceled') return 'scheduled';
  if (status === 'Ready for review') return 'review';
  if (status === 'Blocked' || status === 'Failed') return 'attention';
  return 'open';
}

export type ScheduleAction = 'pause' | 'resume' | 'edit' | 'cancel';
export type TaskChanges = { Status?: TaskStatus; Assignee?: string; Title?: string; Brief?: string };
export type TaskAssignee = { value: string; name: string; kind: 'agent' | 'member'; role?: string };

const laneDetails = {
  Assigned: { label: 'Planned', icon: RectangleStackIcon, tone: 'planned', empty: 'No planned tasks' },
  'In progress': { label: 'In progress', icon: ClockIcon, tone: 'progress', empty: 'Nothing in progress' },
  'Ready for review': { label: 'In review', icon: EyeIcon, tone: 'review', empty: 'Nothing to review' },
  Blocked: { label: 'Blocked', icon: ExclamationCircleIcon, tone: 'blocked', empty: 'No blockers' },
  Completed: { label: 'Done', icon: CheckCircleIcon, tone: 'done', empty: 'No completed tasks' },
} satisfies Record<TaskStatus, { label: string; icon: typeof ClockIcon; tone: string; empty: string }>;

const dragType = 'application/x-cowork-task';

function laneFor(status: string): TaskStatus {
  switch (status) {
    case 'Running':
    case 'In progress': return 'In progress';
    case 'Ready for review': return 'Ready for review';
    case 'Blocked':
    case 'Failed': return 'Blocked';
    case 'Completed':
    case 'Canceled': return 'Completed';
    default: return 'Assigned';
  }
}

function isRunning(task: Task) {
  return task.Status === 'Running' && Boolean(task.ScheduledStarted ||
    (task.WorkflowStarted && Date.now() < Date.parse(task.WorkflowStarted) + 180_000));
}

function isScheduled(task: Task) {
  return task.Status === 'Scheduled' || task.Status === 'Paused';
}

function canMove(task: Task) {
  return !isScheduled(task) && task.Status !== 'Canceled' && !isRunning(task);
}

function assigneeFor(task: Task, assignees: TaskAssignee[]): TaskAssignee {
  if (task.AssigneeMemberID) {
    const value = 'member:' + task.AssigneeMemberID;
    return assignees.find((person) => person.value === value) ?? { value, name: 'Former team member', kind: 'member' };
  }
  if (task.AgentID) {
    const value = 'agent:' + task.AgentID;
    return assignees.find((person) => person.value === value) ??
      { value, name: task.AgentRole ? `Former ${task.AgentRole} agent` : 'Former agent', kind: 'agent', role: task.AgentRole };
  }
  const agent = assignees.find((person) => person.kind === 'agent' && (!task.AgentRole || person.role === task.AgentRole));
  return agent ?? { value: '', name: (task.AgentRole || 'Workspace') + ' agent', kind: 'agent', role: task.AgentRole };
}

export function AssigneeOptions({ assignees, agentsOnly = false }: { assignees: TaskAssignee[]; agentsOnly?: boolean }) {
  const members = assignees.filter(({ kind }) => kind === 'member');
  return <>
    <optgroup label="Agents">{assignees.filter(({ kind }) => kind === 'agent').map(({ value, name, role }) =>
      <option key={value} value={value}>{role && name !== role + ' agent' ? `${name} · ${role}` : name}</option>,
    )}</optgroup>
    {!agentsOnly && members.length > 0 && <optgroup label="Team members">{members.map(({ value, name }) =>
      <option key={value} value={value}>{name}</option>,
    )}</optgroup>}
  </>;
}

function TaskTiming({ task, full = false }: { task: Task; full?: boolean }) {
  const cadence = task.Recurrence ?? task.RunRecurrence;
  const scheduledFor = task.Status !== 'Canceled' && task.Status !== 'Paused' ? task.ScheduledFor : undefined;
  const dateLabel = isScheduled(task) ? (task.Recurrence ? 'Next run' : 'Runs') : 'Scheduled run';
  return <>
    {cadence && <span className={styles.cadence}><ArrowPathRoundedSquareIcon aria-hidden="true" />
      {cadence === 'daily' ? 'Daily' : 'Weekly'}{task.RunRecurrence && ' run'}
    </span>}
    {scheduledFor && <div className={styles.date}>
      <CalendarDaysIcon aria-hidden="true" />
      <span>{dateLabel} <time dateTime={scheduledFor}>{new Date(scheduledFor).toLocaleString(undefined, {
        timeZone: task.ScheduledTimeZone, ...(full ? { dateStyle: 'medium', timeStyle: 'short' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
      })}</time>{full && task.ScheduledTimeZone && ` (${task.ScheduledTimeZone})`}</span>
    </div>}
  </>;
}

function TaskCard({ task, person, busy, dragging, start, end, open }: {
  task: Task; person: TaskAssignee; busy: boolean; dragging: boolean;
  start: (event: DragEvent<HTMLElement>) => void; end: () => void; open: () => void;
}) {
  const movable = canMove(task);
  const status = ['Scheduled', 'Paused', 'Canceled', 'Failed'].includes(task.Status) || isRunning(task) ? task.Status : '';
  return <article className={styles.card} draggable={movable && !busy} data-dragging={dragging || undefined}
    onDragStart={start} onDragEnd={end}>
    <div className={styles.cardHeading}>
      <h3><button type="button" className={styles.cardTitle} onClick={open}>{task.Title}</button></h3>
      {movable
        ? <span className={styles.grip} aria-hidden="true"><EllipsisVerticalIcon /><EllipsisVerticalIcon /></span>
        : <LockClosedIcon className={styles.lock} aria-hidden="true" />}
    </div>
    {task.Brief && <p className={styles.brief}>{task.Brief}</p>}
    {(status || task.Recurrence || task.RunRecurrence || task.ScheduledFor) && <div className={styles.cardTiming}>
      {status && <span className={styles.state} data-state={status}>{status}</span>}
      <TaskTiming task={task} />
    </div>}
    <div className={styles.cardFooter}>
      <span className={styles.avatar} data-kind={person.kind} aria-hidden="true">
        {person.kind === 'agent' ? <SparklesIcon /> : initials(person.name) || <UserIcon />}
      </span>
      <span className={styles.person} title={person.name}>{person.name}</span>
      <small>{person.kind === 'agent' ? 'Agent' : 'Team'}</small>
    </div>
  </article>;
}

function TaskDetail({ task, person, assignees, busy, notice, close, update, manageSchedule }: {
  task: Task; person: TaskAssignee; assignees: TaskAssignee[]; busy: boolean; notice: string;
  close: () => void; update: (task: Task, changes: TaskChanges) => Promise<boolean>;
  manageSchedule: (action: ScheduleAction, task: Task) => void;
}) {
  const [title, setTitle] = useState(task.Title);
  const [brief, setBrief] = useState(task.Brief);
  const [assignee, setAssignee] = useState(person.value);
  const [status, setStatus] = useState(laneFor(task.Status));
  const scheduled = isScheduled(task);
  const running = isRunning(task);
  const movable = canMove(task);
  const initialStatus = laneFor(task.Status);
  const changes: TaskChanges = {
    ...(!scheduled && title !== task.Title && { Title: title }),
    ...(!scheduled && brief !== task.Brief && { Brief: brief }),
    ...(assignee !== person.value && { Assignee: assignee }),
    ...(movable && status !== initialStatus && { Status: status }),
  };

  return <Modal title={task.Title} close={close}>
    <div className={styles.detailMeta}>
      <span className={'status ' + taskGroup(task.Status)}>{task.Status}</span>
      <TaskTiming task={task} full />
      {task.PrivateMemberID && <small>Private to you</small>}
      <small>Assigned by {task.Author}</small>
    </div>
    {running && <p className={styles.detailNote}>The agent is running this task. You can edit it when the run finishes.</p>}
    {(scheduled || running) && <p className={styles.detailBrief}>{task.Brief}</p>}
    {!running && <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      if (Object.keys(changes).length) void update(task, changes).then((saved) => { if (saved) close(); });
    }}>
      {!scheduled && <>
        <label>Task title<Input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <label>Task brief<Textarea required maxLength={6000} rows={4} value={brief} onChange={(event) => setBrief(event.target.value)} /></label>
      </>}
      <div className={styles.detailFields}>
        <label>Assignee<Select value={assignee} required disabled={Boolean(task.PrivateMemberID)} onChange={(event) => setAssignee(event.target.value)}>
          {!assignees.some(({ value }) => value === person.value) && <option value={person.value}>{person.name}</option>}
          <AssigneeOptions assignees={assignees} agentsOnly={scheduled} />
        </Select></label>
        {movable && <label>Status<Select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>
          {taskStatuses.map((value) => <option key={value} value={value}>{laneDetails[value].label}</option>)}
        </Select></label>}
      </div>
      <Button type="submit" className="justify-self-start" disabled={busy || !Object.keys(changes).length}>{busy ? 'Saving…' : 'Save changes'}</Button>
    </form>}
    {notice && <p className={styles.detailNote} role="status">{notice}</p>}
    {scheduled && <div className={styles.scheduleActions} role="group" aria-label="Schedule controls">
      {task.Recurrence && <Button type="button" variant="quiet" disabled={busy} onClick={() => manageSchedule(task.Status === 'Paused' ? 'resume' : 'pause', task)}>
        {task.Status === 'Paused' ? 'Resume' : 'Pause'}
      </Button>}
      <Button type="button" variant="quiet" disabled={busy} onClick={() => manageSchedule('edit', task)}>Edit schedule</Button>
      <Button type="button" variant="quiet" disabled={busy} onClick={() => manageSchedule('cancel', task)}>Cancel schedule</Button>
    </div>}
    {task.Error && <p className={`task-error ${styles.detailNote}`}>{task.Error}</p>}
    <AgentTaskNotes task={task} className={styles.detailResult} />
    {task.Result && <div className={styles.detailResult}><h3>Agent result</h3><p>{task.Result}</p></div>}
    {(task.Repository || Boolean(task.Steps?.length)) && <details className={styles.detailResult}><summary>Run details</summary>
      {task.Repository && <p>{task.Repository}</p>}
      {Boolean(task.Steps?.length) && <ol>{task.Steps?.map((step, index) => <li key={index}>{step}</li>)}</ol>}
    </details>}
    {Boolean(task.Artifacts?.length) && <div className={styles.detailResult}><TaskArtifacts task={task} /></div>}
  </Modal>;
}

export function TaskBoard({ tasks, assignees, busy, notice, clearNotice, update, manageSchedule }: {
  tasks: Task[]; assignees: TaskAssignee[]; busy: boolean; notice: string; clearNotice: () => void;
  update: (task: Task, changes: TaskChanges) => Promise<boolean>;
  manageSchedule: (action: ScheduleAction, task: Task) => void;
}) {
  const [recurringOnly, setRecurringOnly] = useState(false);
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [draggedId, setDraggedId] = useState('');
  const [dropLane, setDropLane] = useState<TaskStatus>();
  const selected = tasks.find(({ ID }) => ID === selectedId);
  const dragged = tasks.find(({ ID }) => ID === draggedId);
  const visible = [...tasks].reverse().map((task) => ({ task, person: assigneeFor(task, assignees) }))
    .filter(({ task, person }) => (!recurringOnly || task.Recurrence || task.RunRecurrence) && (!assigneeFilter || person.value === assigneeFilter));

  function endDrag() {
    setDraggedId('');
    setDropLane(undefined);
  }

  function allowDrop(status: TaskStatus) {
    return !busy && dragged && canMove(dragged) && laneFor(dragged.Status) !== status;
  }

  return <section className={styles.board} aria-label="Task board">
    <div className={styles.toolbar}>
      <div className="segmented" role="group" aria-label="Filter by recurrence">
        <button type="button" aria-pressed={!recurringOnly} onClick={() => setRecurringOnly(false)}>All tasks</button>
        <button type="button" aria-pressed={recurringOnly} onClick={() => setRecurringOnly(true)}>
          <ArrowPathRoundedSquareIcon className="size-4" aria-hidden="true" /> Recurring
        </button>
      </div>
      <label className={styles.filter}>
        <span className="sr-only">Filter by assignee</span>
        <Select variant="filter" value={assigneeFilter} onChange={(event) => setAssigneeFilter(event.target.value)}>
          <option value="">All assignees</option>
          <AssigneeOptions assignees={assignees} />
        </Select>
      </label>
    </div>
    <div className={styles.scroll} tabIndex={0} role="region" aria-label="Task columns">
      <div className={styles.lanes}>
        {taskStatuses.map((status) => {
          const { label, icon: Icon, tone, empty } = laneDetails[status];
          const cards = visible.filter(({ task }) => laneFor(task.Status) === status);
          return <section className={styles.lane} key={status} data-tone={tone} data-target={dropLane === status || undefined}
            aria-labelledby={`task-lane-${tone}`}
            onDragOver={(event) => {
              if (!allowDrop(status) || !event.dataTransfer.types.includes(dragType)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDropLane(status);
            }}
            onDragLeave={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              if (dropLane === status) setDropLane(undefined);
            }}
            onDrop={(event) => {
              if (allowDrop(status) && dragged && event.dataTransfer.getData(dragType) === dragged.ID) {
                event.preventDefault();
                void update(dragged, { Status: status });
              }
              endDrag();
            }}>
            <header className={styles.laneHeader}>
              <span className={styles.laneIcon}><Icon aria-hidden="true" /></span>
              <h2 id={`task-lane-${tone}`}>{label}</h2>
              <span className={styles.count} aria-label={`${cards.length} tasks`}>{cards.length}</span>
            </header>
            <div className={styles.laneCards}>
              {cards.map(({ task, person }) => <TaskCard key={task.ID} task={task} person={person} busy={busy}
                dragging={task.ID === draggedId} end={endDrag}
                open={() => { clearNotice(); setSelectedId(task.ID); }}
                start={(event) => {
                  if (!canMove(task) || busy) { event.preventDefault(); return; }
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(dragType, task.ID);
                  setDraggedId(task.ID);
                }} />)}
              {cards.length === 0 && <p className={styles.empty}>{empty}</p>}
            </div>
          </section>;
        })}
      </div>
    </div>
    {selected && <TaskDetail key={JSON.stringify([selected.ID, selected.Status, selected.Title, selected.Brief, selected.AgentID, selected.AssigneeMemberID])}
      task={selected} person={assigneeFor(selected, assignees)} assignees={assignees}
      busy={busy} notice={notice} update={update} close={() => setSelectedId('')}
      manageSchedule={(action, task) => {
        if (action === 'edit' || action === 'cancel') setSelectedId('');
        manageSchedule(action, task);
      }} />}
  </section>;
}
