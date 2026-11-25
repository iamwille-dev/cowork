import { useState } from 'react';
import { WorkspaceOverview } from './app/components/overview';
import { ChatBubbleLeftIcon, PaperClipIcon, MagnifyingGlassIcon, CheckCircleIcon, ChevronRightIcon } from '@heroicons/react/24/outline';

export type Message = { Author: string; Text: string; At: string; SenderID?: string };
export type Thread = { ID: string; Title: string; Author: string; CreatedAt?: string; TelegramTopic?: string; Messages?: Message[] };
type Artifact = { Name: string; URL: string };
type Task = { ID: string; Title: string; Status: string; ThreadID?: string; Artifacts?: Artifact[] };
type ConversationData = { threads: Thread[]; tasks: Task[]; role: string; open: (id: string) => void };

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

export function ConversationIndex({ threads, tasks, role, open }: ConversationData) {
  const [filter, setFilter] = useState<Status>('All conversations');
  const [query, setQuery] = useState('');
  const entries = threads.map((thread) => {
    const linked = tasks.filter((task) => (task.ThreadID ?? '') === thread.ID);
    const messages = thread.Messages ?? [];
    const latest = messages.at(-1);
    return { thread, linked, messages, latest, updated: latest?.At || thread.CreatedAt, status: statusOf(linked) };
  }).sort((a, b) => (Date.parse(b.updated || '') || 0) - (Date.parse(a.updated || '') || 0));
  const search = query.trim().toLocaleLowerCase();
  const visible = entries.filter(({ status, thread, latest }) => (
    (filter === 'All conversations' || filter === status)
      && (!search || `${thread.Title} ${latest?.Text ?? ''}`.toLocaleLowerCase().includes(search))
  ));
  const ready = entries.filter(({ status }) => status === 'Ready for review');
  const fresh = threads.length === 1 && !entries[0]?.messages.length && tasks.length === 0;
  return <>
    <WorkspaceOverview metrics={[
      { label: 'Conversations', value: entries.length },
      { label: 'In progress', value: entries.filter(({ status }) => status === 'In progress').length, tone: 'blue' },
      { label: 'Ready for review', value: ready.length, tone: 'green' },
      { label: 'Needs attention', value: entries.filter(({ status }) => status === 'Needs attention').length, tone: 'amber' },
    ]} />
    <div className={fresh || ready.length ? 'inbox-layout' : undefined}>
      <section className="conversation-inbox" aria-label="Conversation inbox">
        <div className="conversation-inbox-caption">
          <h2 className="flex items-center gap-2"><span className="section-icon"><ChatBubbleLeftIcon aria-hidden="true" /></span> Recent conversations</h2>
          <span aria-live="polite">{visible.length} {visible.length === 1 ? 'conversation' : 'conversations'}</span>
        </div>
        <div className="conversation-inbox-tools">
          <label className="conversation-search">
            <span className="sr-only">Search this inbox</span>
            <MagnifyingGlassIcon aria-hidden="true" className="size-5" />
            <input type="search" placeholder="Search this inbox" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <label className="conversation-filter">Status
            <select value={filter} onChange={(event) => setFilter(event.target.value as Status)}>
              {statuses.map((status) => <option key={status} value={status}>{status === 'All conversations' ? 'All statuses' : status}</option>)}
            </select>
          </label>
        </div>
        <ul role="list" className="conversation-inbox-list">
          {visible.map(({ thread, linked, messages, latest, updated, status }) => {
            const people = [...new Set(messages.map((message) => message.Author))];
            if (!people.length && thread.Author) people.push(thread.Author);
            const style = status === 'Needs attention' ? 'attention' : status === 'Ready for review' ? 'review' : 'open';
            return <li key={thread.ID} className="inbox-thread">
              <div className="inbox-thread-main">
                <span className="inbox-thread-icon" aria-hidden="true"><ChatBubbleLeftIcon className="size-5" /></span>
                <div className="inbox-thread-text">
                  <button type="button" className="discussion-title" onClick={() => open(thread.ID)}>{thread.Title}</button>
                  <p>{latest ? <><strong>{latest.Author}:</strong> {latest.Text}</> : 'No messages yet'}</p>
                </div>
                <div className="inbox-thread-meta">
                  <span className={'status ' + style}>{status}</span>
                  {updated && <time dateTime={updated}>{timestamp.format(new Date(updated))}</time>}
                </div>
              </div>
              <div className="inbox-thread-footer">
                <div className="flex items-center gap-2.5">
                  {!!people.length && <div className="flex -space-x-1" aria-label="Participants">
                    {people.slice(0, 4).map((name) => <span key={name} className="discussion-avatar" title={name} aria-label={name}>{Array.from(name.trim())[0]?.toUpperCase()}</span>)}
                    {people.length > 4 && <span className="discussion-avatar">+{people.length - 4}</span>}
                  </div>}
                  <span>{messages.length} {messages.length === 1 ? 'message' : 'messages'}</span>
                </div>
                <ArtifactList tasks={linked} />
              </div>
            </li>;
          })}
          {!visible.length && <li className="empty-state"><p>No conversations match your search or status.</p></li>}
        </ul>
      </section>
      {ready.length > 0 && <section className="panel" aria-labelledby="conversation-review-heading">
        <div className="conversation-inbox-caption">
          <h2 id="conversation-review-heading" className="flex items-center gap-2">
            <span className="section-icon"><CheckCircleIcon aria-hidden="true" /></span> Ready for review
          </h2>
        </div>
        <ul className="review-queue">
          {ready.slice(0, 5).map(({ thread, linked }) => {
            const count = linked.filter((task) => task.Status === 'Ready for review').length;
            return <li key={thread.ID}>
              <button type="button" onClick={() => open(thread.ID)}>
                <div className="min-w-0">
                  <span className="block truncate font-medium">{thread.Title}</span>
                  <small>{count} {count === 1 ? 'task' : 'tasks'} ready</small>
                </div>
                <ChevronRightIcon className="size-4 shrink-0" aria-hidden="true" />
              </button>
            </li>;
          })}
        </ul>
      </section>}
      {fresh && <section className="conversation-starter">
        <span className="conversation-starter-mark" aria-hidden="true"><ChatBubbleLeftIcon className="size-6" /></span>
        <div><h2>Say hello to your {role} agent.</h2><p>Ask a question, assign your first task, or set a reminder.</p></div>
        <button type="button" className="quiet" onClick={() => open('')}>Open workspace conversation</button>
      </section>}
    </div>
  </>;
}
