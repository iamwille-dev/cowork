'use client';

import { useState } from 'react';

export type Task = { ID: string; Title: string; Author: string; Status: string; Brief: string; Error?: string; ThreadID?: string; Repository?: string; Steps?: string[]; Artifacts?: { Name: string; URL: string }[]; ScheduledFor?: string; ScheduledTimeZone?: string; Recurrence?: 'daily' | 'weekly'; Result?: string };

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
    <div className="task-toolbar"><div className="segmented" role="group" aria-label="Filter tasks">
      {filters.map(([id, text]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{text}</button>)}
    </div><span>{visible.length} {visible.length === 1 ? 'task' : 'tasks'}</span></div>
    <div className="task-list">
      {visible.map((task) => <article className="task-card panel" key={task.ID}>
        <div className="task-header"><div className="task-title"><h2>{task.Title}</h2><p>Assigned by {task.Author}</p></div><span className={'status ' + taskGroup(task.Status)}>{task.Status}</span></div>
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
        {Boolean(task.Artifacts?.length) && <div className="artifact-list">{task.Artifacts?.filter((file) => /^https:\/\/|^\/api\/artifact\//.test(file.URL)).map((file) => <a key={file.URL} href={file.URL} target="_blank" rel="noopener">{file.Name}</a>)}</div>}
        <details className="task-details"><summary>Task details</summary><p>{task.Brief}</p>{task.Repository && <p>{task.Repository}</p>}
          {Boolean(task.Steps?.length) && <ol>{task.Steps?.map((step) => <li key={step}>{step}</li>)}</ol>}
        </details>
      </article>)}
      {!visible.length && <div className="panel empty-state"><h2>{tasks.length ? 'No matching tasks' : 'No tasks yet'}</h2><p>{tasks.length ? 'Choose a different status to see more tasks.' : 'Assign a task here or ask your agent in a conversation.'}</p></div>}
    </div>
  </>;
}
