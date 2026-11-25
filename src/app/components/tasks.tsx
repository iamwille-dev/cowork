'use client';

import { useState } from 'react';
import { ClipboardDocumentListIcon } from '@heroicons/react/24/outline';
import { WorkspaceOverview } from './overview';

export type Task = { ID: string; Title: string; Author: string; Status: string; Brief: string; Error?: string; ThreadID?: string; Repository?: string; Steps?: string[]; Artifacts?: { Name: string; URL: string }[]; ScheduledFor?: string; ScheduledTimeZone?: string; Recurrence?: 'daily' | 'weekly'; Result?: string };

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
        {task.Result && <p className="whitespace-pre-wrap break-words">{task.Result}</p>}
        <TaskArtifacts task={task} inline />
      </div>
    </details>)}
  </section>;
}

const filters = [
  ['all', 'All tasks'], ['scheduled', 'Scheduled'], ['open', 'In progress'], ['review', 'Ready for review'], ['attention', 'Needs attention'],
];

function taskGroup(status: string) {
  if (status === 'Scheduled' || status === 'Paused' || status === 'Canceled') return 'scheduled';
  if (status === 'Ready for review') return 'review';
  if (status === 'Blocked' || status === 'Failed') return 'attention';
  return 'open';
}

export type ScheduleAction = 'pause' | 'resume' | 'edit' | 'cancel';

export function TaskList({ tasks, busy, manageSchedule }: {
  tasks: Task[]; busy: boolean; manageSchedule: (action: ScheduleAction, task: Task) => void;
}) {
  const [filter, setFilter] = useState('all');
  const visible = [...tasks].reverse().filter((task) => filter === 'all' || taskGroup(task.Status) === filter);
  return <>
    <WorkspaceOverview metrics={[
      { label: 'Total tasks', value: tasks.length },
      { label: 'In progress', value: tasks.filter((task) => taskGroup(task.Status) === 'open').length, tone: 'blue' },
      { label: 'Ready for review', value: tasks.filter((task) => taskGroup(task.Status) === 'review').length, tone: 'green' },
      { label: 'Needs attention', value: tasks.filter((task) => taskGroup(task.Status) === 'attention').length, tone: 'amber' },
    ]} />
    <section className="panel task-list" aria-labelledby="task-list-heading">
      <div className="conversation-inbox-caption"><h2 id="task-list-heading" className="flex items-center gap-2"><span className="section-icon"><ClipboardDocumentListIcon aria-hidden="true" /></span> Assigned work</h2></div>
      <div className="task-toolbar"><div className="segmented" role="group" aria-label="Filter tasks">
        {filters.map(([id, text]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{text}</button>)}
      </div><span>{visible.length} {visible.length === 1 ? 'task' : 'tasks'}</span></div>
      <div>
        {visible.map((task) => <article className="task-card" key={task.ID}>
          <div className="task-header"><div className="task-title"><h3>{task.Title}</h3><p>Assigned by {task.Author}</p></div><span className={'status ' + taskGroup(task.Status)}>{task.Status}</span></div>
          {task.Recurrence && <p>Repeats {task.Recurrence}{task.ScheduledTimeZone && ` (${task.ScheduledTimeZone})`}</p>}
          {task.ScheduledFor && (!task.Recurrence || task.Status === 'Scheduled') && <p>{task.Recurrence ? 'Next run ' : 'Scheduled for '}
            <time dateTime={task.ScheduledFor}>{new Date(task.ScheduledFor).toLocaleString(undefined, { timeZone: task.ScheduledTimeZone })}</time>
          </p>}
          {task.Recurrence && (task.Status === 'Scheduled' || task.Status === 'Paused') && <div className="flex flex-wrap gap-2" role="group" aria-label={`Schedule controls for ${task.Title}`}>
            <button type="button" className="quiet" disabled={busy} onClick={() => manageSchedule(task.Status === 'Paused' ? 'resume' : 'pause', task)}>{task.Status === 'Paused' ? 'Resume' : 'Pause'}</button>
            <button type="button" className="quiet" disabled={busy} onClick={() => manageSchedule('edit', task)}>Edit schedule</button>
            <button type="button" className="quiet" disabled={busy} onClick={() => manageSchedule('cancel', task)}>Cancel schedule</button>
          </div>}
          {task.Error && <p className="task-error">{task.Error}</p>}
          {task.Result && <details className="task-details" open><summary>Agent result</summary><p className="whitespace-pre-wrap break-words">{task.Result}</p></details>}
          <TaskArtifacts task={task} />
          <details className="task-details"><summary>Task details</summary><p>{task.Brief}</p>{task.Repository && <p>{task.Repository}</p>}
            {Boolean(task.Steps?.length) && <ol>{task.Steps?.map((step) => <li key={step}>{step}</li>)}</ol>}
          </details>
        </article>)}
        {!visible.length && <div className="empty-state"><h2>{tasks.length ? 'No matching tasks' : 'No tasks yet'}</h2><p>{tasks.length ? 'Choose a different status to see more tasks.' : 'Assign a task here or ask your agent in a conversation.'}</p></div>}
      </div>
    </section>
  </>;
}
