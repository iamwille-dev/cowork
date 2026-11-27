'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth, useClerk } from '@clerk/nextjs';
import { PlusIcon, UserPlusIcon } from '@heroicons/react/24/outline';
import { WorkspaceShell } from '../../sidebar';
import { Conversation } from '../../chat';
import { ConversationIndex, type Message, type Thread } from '../../conversations';
import { ReminderCalendar } from '../../reminders';
import type { ChannelAgent } from '../../channel-agents';
import { Settings, type GitProvider } from '../../settings';
import { api, initials, localDay } from './api';
import { AuthForm, Modal } from './forms';
import { ClerkSignIn, useClerkMode } from './clerk-auth';
import { WorkspaceOnboarding, type WorkspaceAgent } from './onboarding';
import { TaskList, type ScheduleAction, type Task } from './tasks';

type Reminder = { ID: string; Text: string; Due: string; Author: string; Done: boolean };
type WorkspaceData = {
  name: string;
  admin: boolean;
  agentConnectionHasKey?: boolean;
  managedConnections?: boolean;
  telegramBot?: string;
  telegramAgents?: Partial<Record<ChannelAgent, { Username: string; Destination: string }>>;
  gitTokenStatus?: Partial<Record<GitProvider, boolean>>;
  viewerId: string;
  members: string[];
  directory: { ID: string; Name: string; Email: string; Role: string }[];
  threadInvitations: { ID: string; ThreadID: string; From: string }[];
  workspace: {
    AgentConnectionEnabled?: boolean;
    Agents?: WorkspaceAgent[];
    OnboardingStep?: 'tools' | 'channels';
    Role: string; Invite?: string; Messages?: Message[]; Threads?: Thread[];
    Tasks?: Task[]; Reminders?: Reminder[]; Channels?: Record<string, string>;
  };
};
type View = 'conversations' | 'tasks' | 'reminders' | 'settings';
type ModalName = 'thread' | 'invite' | 'task' | 'reminder' | 'edit-schedule' | 'cancel-schedule';

const titles: Record<View, string> = { conversations: 'Conversations', tasks: 'Tasks', reminders: 'Reminders', settings: 'Workspace settings' };
const descriptions: Record<View, string> = {
  conversations: 'Chat with your agent and keep your team in the loop.',
  tasks: 'Track assigned work, scheduled runs, and results ready to review.',
  reminders: 'See what’s coming up and keep track of follow-ups.',
  settings: 'Manage your workspace, teammates, and integrations.',
};
const shellPages: Record<View, string> = { conversations: 'chat', settings: 'admin', tasks: 'tasks', reminders: 'reminders' };
const shellRoutes: Record<string, View> = { chat: 'conversations', admin: 'settings', tasks: 'tasks', reminders: 'reminders' };
const threadRoute = (id: string) => '/conversations/' + (id || 'workspace');
const dataOf = (event: FormEvent<HTMLFormElement>) => {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget));
};

function scheduleLocalDue(task: Task) {
  if (!task.ScheduledFor) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: task.ScheduledTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(task.ScheduledFor));
  const fields = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
}

type WorkspaceProps = { view: View; threadId?: string; initialMode?: 'signup' | 'login' };

export function Workspace(props: WorkspaceProps) {
  const mode = useClerkMode();
  if (mode === 'clerk') return <ClerkWorkspace {...props} />;
  if (mode === 'unavailable') return <main className="workspace-setup"><p role="alert">Cowork sign-in is unavailable on this deployment.</p></main>;
  return <WorkspaceContent {...props} />;
}

function ClerkWorkspace(props: WorkspaceProps) {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { signOut } = useClerk();
  if (!isLoaded) return <main className="workspace-setup"><p role="status">Loading Cowork…</p></main>;
  if (!isSignedIn) return <ClerkSignIn initialMode={props.initialMode} />;
  return <WorkspaceContent key={userId} {...props} clerkSignOut={() => signOut({ redirectUrl: '/conversations' })} />;
}

function WorkspaceContent({ view, threadId, initialMode, clerkSignOut }: WorkspaceProps & { clerkSignOut?: () => Promise<void> }) {
  const router = useRouter();
  const [state, setState] = useState<WorkspaceData | null>();
  const [needsSetup, setNeedsSetup] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [notice, setNotice] = useState('');
  const [modal, setModal] = useState<ModalName | null>(null);
  const [schedule, setSchedule] = useState<Task | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteMode, setInviteMode] = useState<'email' | 'teammate'>('email');
  const [selectedDay, setSelectedDay] = useState(() => new Date());
  const pending = useRef(false);

  async function refresh() {
    try {
      const data = await api<WorkspaceData>('workspace');
      if (!pending.current) {
        setState(data);
        setNeedsSetup(false);
      }
    } catch (error) {
      if (pending.current) return;
      const status = (error as { status?: number }).status;
      setState(null);
      setNeedsSetup(status === 428);
      if (status !== 401 && status !== 428) setNotice((error as Error).message);
    }
  }

  useEffect(() => {
    if (document.documentElement.dataset.theme === 'dark') setTheme('dark');
    void refresh();
    const timer = window.setInterval(() => { if (!pending.current) void refresh(); }, 4000);
    return () => window.clearInterval(timer);
  }, []);

  async function run(action: () => Promise<void>) {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setNotice('');
    try { await action(); return true; }
    catch (error) { setNotice((error as Error).message); return false; }
    finally { pending.current = false; setBusy(false); }
  }

  const write = async (path: string, data: object) => {
    const result = await api<WorkspaceData>(path, data);
    setState(result);
    return result;
  };

  function changeTheme(value: 'light' | 'dark') {
    document.documentElement.dataset.theme = value;
    setTheme(value);
    try { localStorage.setItem('cowork-theme', value); } catch { /* Storage may be disabled. */ }
  }

  const workspace = state?.workspace;
  const tasks = workspace?.Tasks ?? [];
  const threads: Thread[] = [{
    ID: '', Title: 'Workspace conversation', Author: workspace?.Messages?.[0]?.Author ?? '',
    Messages: workspace?.Messages ?? [],
  }, ...(workspace?.Threads ?? [])];
  const current = threadId === undefined ? undefined : threads.find(({ ID }) => ID === threadId);
  const agents = workspace?.Agents ?? [];
  const grants = Object.fromEntries(agents.map(({ ID, ConnectionIDs }) => [ID, ConnectionIDs ?? []]));
  const saveGrants = (value: typeof grants) => {
    void run(async () => { await write('agent-grants', { Grants: value }); });
  };
  const selectedAgent = agents.find(({ ID }) => ID === current?.AgentID) ?? agents[0];
  const invitations = state?.threadInvitations ?? [];
  const teammates = state?.directory.filter(({ ID }) => ID !== state.viewerId) ?? [];
  const developer = workspace?.Role === 'Developer';
  const route = (id: string) => router.push(threadRoute(id));
  const close = () => { setModal(null); setSchedule(null); setNotice(''); };
  const scheduleDue = schedule ? scheduleLocalDue(schedule) : '';
  const contentMode = current ? 'chat' : view === 'conversations' ? 'chat-list' : view;

  function changeSchedule(action: ScheduleAction, task: Task, changes = {}) {
    return run(async () => {
      await write('task/schedule/update', { ...changes, ID: task.ID, Action: action });
      close();
      setNotice({ pause: 'Schedule paused.', resume: 'Schedule resumed.', edit: 'Schedule updated.', cancel: 'Schedule canceled.' }[action]);
    });
  }

  if (clerkSignOut && (needsSetup || (state?.admin && workspace?.OnboardingStep))) return (
    <main>
      <header className="setup-session">
        <button className="quiet" type="button" disabled={busy} onClick={() => void run(clerkSignOut)}>Sign out</button>
      </header>
      {notice && <div id="notice" role="alert">{notice}</div>}
      <WorkspaceOnboarding setup={state ?? undefined} busy={busy} configured={Boolean(state?.agentConnectionHasKey)}
        telegram={state?.telegramAgents} managed={Boolean(state?.managedConnections)} grants={grants} saveGrants={saveGrants}
        save={(settings) => run(async () => {
          const data = await write('onboarding', settings);
          setNeedsSetup(false);
          if (!data.workspace.OnboardingStep) router.replace('/conversations');
        })}
        saveTelegram={(settings) => run(async () => { await write('telegram', settings); })}
      />
    </main>
  );

  return <WorkspaceShell
    page={shellPages[view]} invitationCount={invitations.length} theme={theme}
    account={state ? { name: state.name, initials: initials(state.name), role: state.workspace.Role } : undefined}
    navigate={(page) => router.push('/' + shellRoutes[page])}
    toggleTheme={() => changeTheme(theme === 'dark' ? 'light' : 'dark')}
    signOut={() => void run(clerkSignOut ?? (async () => { await api('logout', {}); setState(null); router.push('/conversations'); }))}
    search={(query) => {
      const text = query.trim().toLowerCase();
      if (!text) return [];
      return [
        ...threads.filter((thread) => thread.Title.toLowerCase().includes(text)).map((thread) => ({ label: thread.Title, open: () => route(thread.ID) })),
        ...tasks.filter((task) => task.Title.toLowerCase().includes(text)).map((task) => ({ label: task.Title, open: () => router.push('/tasks') })),
      ].slice(0, 6);
    }}>
    <main data-view={contentMode}>
      {notice && !modal && <div id="notice" role="status">{notice}</div>}
      {state === undefined && <p className="p-6" role="status">Loading workspace…</p>}
      {state === null && (clerkSignOut ? <div className="workspace-setup">
        {!notice && <p role="alert">Cowork couldn’t verify your sign-in.</p>}
        <div className="setup-controls">
          <button className="quiet" type="button" onClick={() => void refresh()}>Try again</button>
          <button className="quiet" type="button" onClick={() => void run(clerkSignOut)}>Sign out</button>
        </div>
      </div> : <AuthForm initialMode={initialMode} busy={busy} submit={(mode, data) => void run(async () => { await write(mode, data); })} />)}
      {state && workspace && <section id="workspace">
        <header className="workspace-header">
          <div><h1>{current?.Title || titles[view]}</h1>{threadId === undefined && <p className="workspace-page-description">{descriptions[view]}</p>}{current && state.members.length > 1 && <span id="chat-members-count">{state.members.length} workspace members</span>}</div>
          <div className="flex flex-wrap justify-end gap-2">
            {view === 'conversations' && threadId === undefined && <button className="primary" onClick={() => setModal('thread')}><PlusIcon className="size-4" aria-hidden="true" /> New conversation</button>}
            {view === 'conversations' && threadId !== undefined && <button className="quiet" onClick={() => router.push('/conversations')}>All conversations</button>}
            {current && !current.TelegramTopic && !current.Slack && <button className="primary" onClick={() => { setInviteMode('email'); setModal('invite'); }}><UserPlusIcon className="size-4" aria-hidden="true" /> Invite people</button>}
            {view === 'tasks' && <button className="primary" onClick={() => setModal('task')}><PlusIcon className="size-4" aria-hidden="true" /> Assign task</button>}
          </div>
        </header>
        {view === 'conversations' && <section id="chat" className="page">
          {current ? <div id="conversation-root">
            <Conversation key={current.ID} role={selectedAgent?.Role ?? workspace.Role} agentName={selectedAgent?.Name} viewer={state.name} threadId={current.ID}
              readOnly={Boolean(current.TelegramTopic || current.Slack)} channel={current.Slack ? 'Slack' : current.TelegramTopic ? 'Telegram' : undefined}
              messages={current.Messages ?? []}
              tasks={tasks.filter((task) => (task.ThreadID ?? '') === current.ID && (task.Status === 'Ready for review' || task.Status === 'Failed' || task.Status === 'Blocked'))}
              send={async (transport) => {
                await run(async () => {
                  try { await transport(); } finally { setState(await api<WorkspaceData>('workspace')); }
                });
              }} />
          </div> : threadId !== undefined ? <p className="p-6">Conversation not found.</p> : <>
            {invitations.length > 0 && <section className="panel thread-invitations">
              <h2>Conversation invitations</h2>
              <ul role="list">{invitations.map((invitation) => <li key={invitation.ID}>
                <div><strong>{threads.find(({ ID }) => ID === invitation.ThreadID)?.Title || 'Conversation'}</strong><p>Invited by {invitation.From}</p></div>
                <button className="quiet" disabled={busy} onClick={() => void run(async () => {
                  await write('thread/invite/accept', { ID: invitation.ID }); route(invitation.ThreadID);
                })}>Join conversation</button>
              </li>)}</ul>
            </section>}
            <ConversationIndex threads={threads} tasks={tasks} role={workspace.Role} open={route} />
          </>}
        </section>}
        {view === 'tasks' && <section className="page"><TaskList tasks={tasks} busy={busy} manageSchedule={(action, task) => {
          if (action === 'edit' || action === 'cancel') {
            setNotice('');
            setSchedule(task);
            setModal(action === 'edit' ? 'edit-schedule' : 'cancel-schedule');
          } else {
            void changeSchedule(action, task);
          }
        }} /></section>}
        {view === 'reminders' && <section className="page"><ReminderCalendar selected={selectedDay} reminders={workspace.Reminders ?? []}
          select={setSelectedDay} add={() => setModal('reminder')}
          complete={(id) => void run(async () => { await write('reminder/done', { ID: id }); })} /></section>}
        {view === 'settings' && <section className="page"><Settings theme={theme} members={state.directory} owner={state.admin}
          invite={workspace.Invite || ''} channels={workspace.Channels ?? {}} changeTheme={changeTheme} announce={setNotice}
          managedConnections={state.managedConnections ? { agents, grants, busy, saveGrants } : undefined}
          agentConnection={{ enabled: Boolean(workspace.AgentConnectionEnabled), hasKey: Boolean(state.agentConnectionHasKey) }}
          saveAgentConnection={(settings) => run(async () => {
            await write('agent-connection', settings);
            setNotice('Agent Connection settings saved.');
          })}
          gitTokenStatus={state.gitTokenStatus ?? {}}
          saveGitToken={(settings) => run(async () => {
            await write('git-token', settings);
            setNotice(settings.Remove ? 'Git token removed.' : 'Git token saved.');
          })}
          telegramBot={state.telegramBot} telegramAgents={state.telegramAgents}
          saveTelegram={(settings) => run(async () => {
            await write('telegram', settings);
            setNotice(settings.Remove ? 'Telegram bot disconnected.' : 'Telegram settings saved.');
          })}
          saveChannel={(channel, destination, button) => {
            button.disabled = true;
            void run(async () => {
              await write('integration', { Channel: channel, Destination: destination });
              setNotice(channel + ' destination saved.');
            }).finally(() => { button.disabled = false; });
          }} /></section>}
      </section>}

      {modal === 'thread' && <Modal title="New conversation" close={close}><form className="stack" onSubmit={(event) => {
        const data = dataOf(event);
        void run(async () => { const result = await write('thread', data); close(); route(result.workspace.Threads!.at(-1)!.ID); });
      }}><label>Conversation title<input name="Text" required maxLength={200} /></label>
        {agents.length > 1 && <label>Agent<select name="AgentID">
          {agents.map(({ ID, Name, Role }) => <option key={ID} value={ID}>{Name === Role ? Name : `${Name} · ${Role}`}</option>)}
        </select></label>}
        <button className="primary" disabled={busy}>Create conversation</button></form>
      {notice && <p role="status">{notice}</p>}</Modal>}

      {modal === 'invite' && <Modal title="Invite people" close={close}>
        <div className="segmented mb-4" role="group" aria-label="Invitation type">
          <button aria-pressed={inviteMode === 'email'} onClick={() => { setInviteMode('email'); setNotice(''); }}>By email</button>
          <button aria-pressed={inviteMode === 'teammate'} onClick={() => { setInviteMode('teammate'); setNotice(''); }}>Workspace teammate</button>
        </div>
        {inviteMode === 'email' && <form className="stack" onSubmit={(event) => {
          const data = dataOf(event);
          void run(async () => {
            const result = await api<{ email: string }>('thread/invite/email', { ...data, ThreadID: current?.ID });
            close();
            setNotice('Invitation emailed to ' + result.email + '.');
          });
        }}>
          <p>Email a single-use invitation. Your guest can join this conversation without creating an account.</p>
          <label>Email address<input name="Email" type="email" required maxLength={254} /></label>
          <button className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send invitation email'}</button>
        </form>}
        {inviteMode === 'teammate' && (teammates.length ? <form className="stack" onSubmit={(event) => {
          const data = dataOf(event);
          void run(async () => { await write('thread/invite', { ...data, ThreadID: current?.ID }); close(); setNotice('Conversation invitation sent.'); });
        }}>
          <label>Workspace teammate<select name="MemberID">
            {teammates.map((person) => <option key={person.ID} value={person.ID}>{person.Name} ({person.Email})</option>)}
          </select></label>
          <button className="primary" disabled={busy}>Send invitation</button>
        </form> : <p>There are no other members in this workspace.</p>)}
        {notice && <p className="mt-3" role="status">{notice}</p>}
      </Modal>}

      {modal === 'task' && <Modal title="Assign a task" close={close}><form className="stack" onSubmit={(event) => {
        const data = dataOf(event);
        void run(async () => { await write('task', { ...data, UI: developer && data.UI === 'on' }); close(); });
      }}>
        <label>Task title<input name="Title" required maxLength={120} placeholder="Build a launch page" /></label>
        <label>Task brief<textarea name="Brief" required maxLength={6000} rows={5} /></label>
        {developer && <><label>Repository URL (optional)<input name="Repository" type="url" maxLength={500} /></label>
          <label className="checkbox"><input name="UI" type="checkbox" defaultChecked /> Include a UI screenshot</label></>}
        <button className="primary" disabled={busy}>{busy ? 'Assigning task…' : developer ? 'Run Developer workflow' : 'Assign task'}</button>
      </form>{notice && <p role="status">{notice}</p>}</Modal>}

      {modal === 'edit-schedule' && schedule && <Modal title="Edit schedule" close={close}>
        <form className="stack" onSubmit={(event) => {
          const data = dataOf(event);
          void changeSchedule('edit', schedule, { ...data, LocalDue: data.LocalDue === scheduleDue ? undefined : data.LocalDue });
        }}>
          <label>Task title<input name="Title" required maxLength={120} defaultValue={schedule.Title} /></label>
          <label>Task brief<textarea name="Brief" required maxLength={6000} rows={5} defaultValue={schedule.Brief} /></label>
          <label>Frequency<select name="Recurrence" defaultValue={schedule.Recurrence}>
            <option value="daily">Daily</option><option value="weekly">Weekly</option>
          </select></label>
          <label>Next run ({schedule.ScheduledTimeZone || 'UTC'})<input name="LocalDue" type="datetime-local" required defaultValue={scheduleDue} /></label>
          <button className="primary" disabled={busy}>Save schedule</button>
        </form>
        {notice && <p className="mt-3" role="status">{notice}</p>}
      </Modal>}

      {modal === 'cancel-schedule' && schedule && <Modal title="Cancel schedule" close={close}>
        <div className="stack">
          <p>Cancel future runs of <strong>{schedule.Title}</strong>? Any run already in progress will finish.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="quiet" onClick={close} disabled={busy}>Keep schedule</button>
            <button type="button" className="primary" onClick={() => void changeSchedule('cancel', schedule)} disabled={busy}>Cancel schedule</button>
          </div>
          {notice && <p role="status">{notice}</p>}
        </div>
      </Modal>}

      {modal === 'reminder' && <Modal title="Add a reminder" close={close}><form className="stack" onSubmit={(event) => {
        const data = dataOf(event);
        const due = new Date(String(data.Due));
        void run(async () => { await write('reminder', { Text: data.Text, Due: due.toISOString() }); setSelectedDay(due); close(); });
      }}>
        <label>Reminder<input name="Text" required maxLength={4000} /></label>
        <label>Due<input name="Due" type="datetime-local" defaultValue={localDay(selectedDay) + 'T09:00'} required /></label>
        <button className="primary" disabled={busy}>Add reminder</button>
      </form>{notice && <p role="status">{notice}</p>}</Modal>}
    </main>
  </WorkspaceShell>;
}
