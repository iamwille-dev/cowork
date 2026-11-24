import { useState } from 'react';
import { ChatBubbleLeftIcon, CheckCircleIcon, PaperClipIcon } from '@heroicons/react/24/outline';

export type Message = { Author: string; Text: string; At: string; SenderID?: string };
export type Thread = { ID: string; Title: string; Author: string; CreatedAt?: string; Messages?: Message[] };
type Artifact = { Name: string; URL: string };
type Task = { ID: string; Title: string; Status: string; ThreadID?: string; Artifacts?: Artifact[] };
type ConversationData = { threads: Thread[]; tasks: Task[]; open: (id: string) => void };

const statuses = ['All conversations', 'Open', 'In progress', 'Ready for review', 'Needs attention'] as const;
type Status = typeof statuses[number];
const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function statusOf(tasks: Task[]): Status {
  if (tasks.some((task) => task.Status === 'Blocked' || task.Status === 'Failed')) return 'Needs attention';
  if (tasks.some((task) => task.Status === 'Assigned' || task.Status === 'Running')) return 'In progress';
  if (tasks.some((task) => task.Status === 'Ready for review')) return 'Ready for review';
  return 'Open';
}

function safeLink(path: string) {
  try {
    const url = new URL(path, location.origin);
    return url.protocol === 'https:' || url.origin === location.origin ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function ArtifactList({ tasks }: { tasks: Task[] }) {
  const withArtifacts = tasks.filter((task) => task.Artifacts?.some((artifact) => safeLink(artifact.URL)));
  if (!withArtifacts.length) return null;
  const count = withArtifacts.reduce((total, task) => total + (task.Artifacts?.filter((artifact) => safeLink(artifact.URL)).length ?? 0), 0);
  return (
    <details className="discussion-artifacts">
      <summary><PaperClipIcon aria-hidden="true" className="inline size-4" /> {count} {count === 1 ? 'artifact' : 'artifacts'}</summary>
      {withArtifacts.map((task) => (
        <div key={task.ID} className="mt-2">
          <p className="text-sm font-semibold">{task.Title}</p>
          <div className="artifact-list mt-1">
            {task.Artifacts?.map((artifact, index) => {
              const href = safeLink(artifact.URL);
              return href ? <a key={index} href={href} target="_blank" rel="noopener">{artifact.Name}</a> : null;
            })}
          </div>
        </div>
      ))}
    </details>
  );
}

export function ConversationIndex({ threads, tasks, open }: ConversationData) {
  const [filter, setFilter] = useState<Status>('All conversations');
  const entries = threads.map((thread) => {
    const linked = tasks.filter((task) => (task.ThreadID ?? '') === thread.ID);
    const messages = thread.Messages ?? [];
    const updated = messages.at(-1)?.At || thread.CreatedAt;
    return { thread, linked, messages, updated, status: statusOf(linked) };
  }).sort((a, b) => (Date.parse(b.updated || '') || 0) - (Date.parse(a.updated || '') || 0));
  const visible = entries.filter(({ status }) => filter === 'All conversations' || filter === status);
  return (
    <>
      <div className="task-toolbar">
        <div className="segmented" role="group" aria-label="Filter conversations">
          {statuses.map((status) => (
            <button type="button" key={status} aria-pressed={status === filter} onClick={() => setFilter(status)}>{status}</button>
          ))}
        </div>
        <span>{visible.length} {visible.length === 1 ? 'conversation' : 'conversations'}</span>
      </div>
      <ul role="list" className="panel discussion-list">
        {visible.map(({ thread, linked, messages, updated, status }) => {
          const people = [...new Set(messages.map((message) => message.Author))];
          if (!people.length && thread.Author) people.push(thread.Author);
          const Icon = status === 'Ready for review' ? CheckCircleIcon : ChatBubbleLeftIcon;
          const style = status === 'Needs attention' ? 'attention' : status === 'Ready for review' ? 'review' : 'open';
          return (
            <li key={thread.ID} className="discussion-row">
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 sm:flex-nowrap">
                <div className="min-w-0">
                  <button type="button" className="discussion-title text-left text-sm/6 font-semibold hover:underline" onClick={() => open(thread.ID)}>
                    {thread.Title}
                  </button>
                  <div className="discussion-meta mt-1 flex flex-wrap items-center gap-x-2 text-xs/5">
                    {thread.Author && <span>{thread.Author}</span>}
                    {thread.Author && updated && <span aria-hidden="true">·</span>}
                    {updated && <time dateTime={updated}>{timestamp.format(new Date(updated))}</time>}
                  </div>
                </div>
                <dl className="flex w-full flex-none items-center justify-between gap-x-4 sm:w-auto">
                  <div className="flex -space-x-1">
                    <dt className="sr-only">Participants</dt>
                    {people.slice(0, 4).map((name) => (
                      <dd key={name} className="discussion-avatar" title={name}>
                        <span className="sr-only">{name}</span>
                        <span aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase()}</span>
                      </dd>
                    ))}
                    {people.length > 4 && <dd className="discussion-avatar">+{people.length - 4}</dd>}
                  </div>
                  <div className="flex items-center gap-1.5" title="Messages">
                    <dt><span className="sr-only">Messages</span><Icon aria-hidden="true" className="size-5 discussion-meta" /></dt>
                    <dd className="text-sm">{messages.length}</dd>
                  </div>
                  <div><dt className="sr-only">Status</dt><dd><span className={'status ' + style}>{status}</span></dd></div>
                </dl>
              </div>
              <ArtifactList tasks={linked} />
            </li>
          );
        })}
        {!visible.length && <li className="empty-state"><p>No conversations match this status.</p></li>}
      </ul>
    </>
  );
}
