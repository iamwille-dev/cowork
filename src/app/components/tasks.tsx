'use client';

import { useState } from 'react';

export type Task = { ID: string; Title: string; Author: string; Status: string; Brief: string; Error?: string; ThreadID?: string; Repository?: string; Steps?: string[]; Artifacts?: { Name: string; URL: string }[] };

const filters = [
  ['all', 'All tasks'], ['open', 'In progress'], ['review', 'Ready for review'], ['attention', 'Needs attention'],
];

function taskGroup(status: string) {
  if (status === 'Ready for review') return 'review';
  if (status === 'Blocked' || status === 'Failed') return 'attention';
  return 'open';
}

export function TaskList({ tasks }: { tasks: Task[] }) {
  const [filter, setFilter] = useState('all');
  const visible = [...tasks].reverse().filter((task) => filter === 'all' || taskGroup(task.Status) === filter);
  return <>
    <div className="task-toolbar"><div className="segmented" role="group" aria-label="Filter tasks">
      {filters.map(([id, text]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{text}</button>)}
    </div><span>{visible.length} {visible.length === 1 ? 'task' : 'tasks'}</span></div>
    <div className="task-list">
      {visible.map((task) => <article className="task-card panel" key={task.ID}>
        <div className="task-header"><div className="task-title"><h2>{task.Title}</h2><p>Assigned by {task.Author}</p></div><span className={'status ' + taskGroup(task.Status)}>{task.Status}</span></div>
        {task.Error && <p className="task-error">{task.Error}</p>}
        {Boolean(task.Artifacts?.length) && <div className="artifact-list">{task.Artifacts?.filter((file) => /^https:\/\/|^\/api\/artifact\//.test(file.URL)).map((file) => <a key={file.URL} href={file.URL} target="_blank" rel="noopener">{file.Name}</a>)}</div>}
        <details className="task-details"><summary>Task details</summary><p>{task.Brief}</p>{task.Repository && <p>{task.Repository}</p>}
          {Boolean(task.Steps?.length) && <ol>{task.Steps?.map((step) => <li key={step}>{step}</li>)}</ol>}
        </details>
      </article>)}
      {!visible.length && <div className="panel empty-state"><h2>{tasks.length ? 'No matching tasks' : 'No tasks yet'}</h2><p>{tasks.length ? 'Choose a different status to see more tasks.' : 'Assign a task here or ask your agent in a conversation.'}</p></div>}
    </div>
  </>;
}
