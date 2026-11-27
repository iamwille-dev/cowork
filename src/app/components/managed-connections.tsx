'use client';

import { Button } from './button';
import { Input, Textarea } from './input';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from './api';
import { Select } from './select';
import { ConnectionCatalog, connectionApps, type ConnectionAppId } from './connection-catalog';
import type { WorkspaceAgent } from '../lib/workspace-agents';

const prefix = '/integrations/agent-connections';
type Provider = 'github' | 'gmail';
type AgentIdentity = { id: string; name: string };
type Connection = { id: string; kind: string; login?: string; email?: string; host?: string; user?: string; agents?: AgentIdentity[]; clients?: string[] };
type Activity = { id: string; agentName: string; connectionLabel: string; operation: string; succeeded: boolean; occurredAt: string };
export type AgentGrants = Record<string, string[]>;
type GatewayKey = AgentIdentity & { credential?: string };

async function gateway<T>(path: string, method = 'GET', body?: object): Promise<T> {
  const result = await fetch(prefix + path, {
    method, cache: 'no-store',
    ...(method !== 'GET' && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
  });
  if (!result.ok) throw Object.assign(new Error((await result.text()).trim() || 'Could not reach Agent Connections.'), { status: result.status });
  return result.status === 204 ? undefined as T : result.json() as Promise<T>;
}

function label(connection: Connection) {
  return connection.login || connection.email || [connection.user, connection.host].filter(Boolean).join('@') || connection.kind;
}
function labelProvider(kind: string) {
  return kind === 'github' ? 'GitHub' : kind === 'gmail' ? 'Gmail' : 'SSH';
}
function formData(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget));
}

export function ManagedConnections({ enabled, agents, grants, onGrants, savingGrants, keySaved, saveKey, onboarding = false, onBusy }: {
  enabled: boolean;
  agents: WorkspaceAgent[];
  grants: AgentGrants;
  onGrants: (value: AgentGrants) => void;
  keySaved: boolean;
  savingGrants?: boolean;
  saveKey: (value: string) => Promise<void>;
  onboarding?: boolean;
  onBusy?: (value: boolean) => void;
}) {
  const [connections, setConnections] = useState<Connection[]>();
  const [providers, setProviders] = useState<Partial<Record<Provider, boolean>> | null>();
  const [loadError, setLoadError] = useState('');
  const [sshOpen, setSshOpen] = useState(false);
  const [workspaceKey, setWorkspaceKey] = useState<GatewayKey | null>();
  const [createdKey, setCreatedKey] = useState('');
  const [namedKey, setNamedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const refresh = useCallback(async () => {
    setLoadError('');
    const results = await Promise.allSettled([
      gateway<Partial<Record<Provider, boolean>>>('/providers').then(setProviders, (failure) => {
        setProviders(null);
        throw failure;
      }),
      gateway<Connection[]>('/connections').then(setConnections),
      gateway<GatewayKey | null>('/workspace/key').then(setWorkspaceKey),
    ]);
    const [providerResult, accountsResult, keyResult] = results;
    if (providerResult.status === 'rejected') {
      setLoadError('Couldn’t check app availability. Try again.');
    } else if (accountsResult.status === 'rejected' || keyResult.status === 'rejected') {
      setLoadError('Some connected account details couldn’t load.');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const url = new URL(window.location.href);
    const result = url.searchParams.get('github') ?? url.searchParams.get('google');
    if (result) {
      if (result === 'connected') setStatus('Connection saved.');
      else if (result === 'requested') setStatus('GitHub is waiting for installation approval. Authorize it here after approval.');
      else if (result === 'scope') setError('Gmail read access was declined. Reconnect and grant read access to continue.');
      else if (result === 'offline') setError('Google didn’t grant lasting access. Reconnect the Gmail account to try again.');
      else setError('The provider did not finish connecting. Start again when ready.');
      url.searchParams.delete('github');
      url.searchParams.delete('google');
      window.history.replaceState(window.history.state, '', url);
    }
  }, [enabled, refresh]);

  async function action(run: () => Promise<void>) {
    setBusy(true);
    onBusy?.(true);
    setError('');
    setStatus('');
    try {
      await run();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }

  function connect(provider: Provider, existing = false) {
    return action(async () => {
      const path = provider === 'github' ? '/github/start' + (existing ? '?mode=authorize' : '') : '/google/start';
      const { url } = await gateway<{ url: string }>(path, 'POST');
      window.location.assign(url);
    });
  }

  function connectApp(id: ConnectionAppId) {
    if (id === 'ssh') setSshOpen(true);
    else void connect(id);
  }

  async function createWorkspaceKey(reveal: boolean) {
    const key = await gateway<GatewayKey>('/workspace/key', 'POST');
    setWorkspaceKey(key);
    if (!key.credential) throw new Error('Agent Connections did not return the new key.');
    try {
      await saveKey(key.credential);
    } catch (error) {
      setCreatedKey(key.credential);
      throw error;
    }
    if (reveal) setCreatedKey(key.credential);
    setStatus('Workspace key saved in Cowork.');
  }

  if (!enabled && !onboarding) return null;
  return <div className="stack">
    <ConnectionCatalog busy={busy} serviceError={enabled ? loadError : 'Tool connections are unavailable on this deployment.'}
      retry={enabled && loadError ? () => void refresh() : undefined}
      apps={connectionApps.map((app) => ({
        ...app,
        connected: connections?.filter(({ kind }) => kind === app.id).length ?? 0,
        availability: !enabled || providers === null ? 'unavailable'
          : app.id === 'ssh' ? (onboarding ? 'settings' : 'ready')
          : providers === undefined ? 'loading' : providers[app.id] ? 'ready' : 'setup',
        connect: () => connectApp(app.id),
        alternate: app.id === 'github'
          ? { label: 'Use an existing installation', run: () => { void connect('github', true); } }
          : undefined,
      }))} />
    {!onboarding && sshOpen && <section className="setup-tool" aria-label="Connect an SSH host">
      <h3>Connect an SSH host</h3>
      <form className="stack w-full" onSubmit={(event) => {
        const values = formData(event);
        const form = event.currentTarget;
        void action(async () => {
          await gateway('/connections/ssh', 'POST', { ...values, port: Number(values.port || 22) });
          form.reset();
          setSshOpen(false);
          await refresh();
        });
      }}>
        <label>Host<Input name="host" required autoFocus /></label>
        <label>Port<Input name="port" type="number" min="1" max="65535" defaultValue="22" required /></label>
        <label>SSH user<Input name="user" required /></label>
        <label>Host key fingerprint<Input name="fingerprint" required placeholder="SHA256:…" /></label>
        <label>Private key<Textarea name="private_key" autoComplete="off" required rows={4} /></label>
        <div className="setup-controls">
          <Button variant="quiet" type="submit" disabled={busy}>Save SSH connection</Button>
          <Button variant="quiet" type="button" disabled={busy} onClick={() => setSshOpen(false)}>Cancel</Button>
        </div>
      </form>
    </section>}

    {Boolean(connections?.length) && <section className="setup-agents" aria-label="Connected accounts">
      <h2 className="font-semibold">Connected accounts</h2>
      {connections?.map((connection) => <div key={connection.id} className="stack">
        <div className="setup-controls">
          <strong>{label(connection)}</strong><span className="status review">{labelProvider(connection.kind)} connected</span>
        </div>
        {agents.length > 0 && <fieldset className="grant-options">
          <legend>Allow access for</legend>
          {agents.map((agent) => <label key={agent.ID}>
            <input type="checkbox" disabled={busy || savingGrants || (!keySaved && workspaceKey === undefined)}
              checked={grants[agent.ID]?.includes(connection.id) ?? false} onChange={(event) => {
              const selected = grants[agent.ID] ?? [];
              const checked = event.currentTarget.checked;
              const updated = { ...grants, [agent.ID]: checked
                ? [...selected, connection.id] : selected.filter((id) => id !== connection.id) };
              if (checked && !keySaved && workspaceKey === null) {
                void action(async () => {
                  await createWorkspaceKey(false);
                  onGrants(updated);
                });
              } else {
                onGrants(updated);
              }
            }} />
            {agent.Name}
          </label>)}
        </fieldset>}
        {!onboarding && <details>
          <summary className="cursor-pointer">External MCP clients</summary>
          <ul className="stack py-3">
            {[...(connection.agents ?? []), ...(connection.clients ?? []).map((id) => ({ id, name: id }))].map((client) => (
              <li key={client.id} className="setup-controls">
                <span className="break-all">{client.name}</span>
                <Button type="button" variant="quiet" disabled={busy} onClick={() => void action(async () => {
                  await gateway('/connections/' + encodeURIComponent(connection.id) + '/grants/' + encodeURIComponent(client.id), 'DELETE');
                  await refresh();
                })}>Revoke</Button>
              </li>))}
          </ul>
          <form className="stack pb-3" onSubmit={(event) => {
            const { client } = formData(event);
            const form = event.currentTarget;
            void action(async () => {
              await gateway('/connections/' + encodeURIComponent(connection.id) + '/grants/' + encodeURIComponent(String(client).trim()), 'PUT');
              form.reset();
              await refresh();
            });
          }}>
            <label>OAuth client ID<Input name="client" maxLength={500} required /></label>
            <div><Button variant="quiet" type="submit" disabled={busy}>Grant access</Button></div>
          </form>
          <form className="stack pb-3" onSubmit={(event) => {
            const { name } = formData(event);
            const form = event.currentTarget;
            void action(async () => {
              const { credential } = await gateway<GatewayKey>('/connections/' + encodeURIComponent(connection.id) + '/agents', 'POST', { Name: name });
              if (!credential) throw new Error('Agent Connections did not return the new key.');
              setNamedKey(credential);
              form.reset();
              await refresh();
            });
          }}>
            <label>Agent key name<Input name="name" maxLength={100} required /></label>
            <div><Button variant="quiet" type="submit" disabled={busy}>Create key for this connection</Button></div>
          </form>
          <div className="setup-controls">
            <Button type="button" variant="quiet" disabled={busy} onClick={() => {
              if (!window.confirm('Disconnect this account and revoke its grants?')) return;
              void action(async () => {
                const response = await gateway<{ warning?: string } | undefined>('/connections/' + encodeURIComponent(connection.id), 'DELETE');
                if (response?.warning) setStatus(response.warning);
                await refresh();
              });
            }}>Disconnect {labelProvider(connection.kind)}</Button>
          </div>
        </details>}
      </div>)}
    </section>}

    {namedKey && <div className="stack">
      <label>New connection key<Input value={namedKey} readOnly /></label>
      <div className="setup-controls">
        <Button variant="quiet" type="button" onClick={() => void action(async () => {
          await navigator.clipboard.writeText(namedKey);
          setStatus('Connection key copied.');
        })}>Copy connection key</Button>
        <Button variant="quiet" type="button" onClick={() => setNamedKey('')}>Hide key</Button>
      </div>
    </div>}
    {Boolean(connections?.length) && !keySaved && workspaceKey === null && <div>
      <Button variant="quiet" type="button" disabled={busy} onClick={() => void action(() => createWorkspaceKey(true))}>Generate and save a workspace key</Button>
    </div>}
    {createdKey && <div className="stack">
      <label>New workspace key<Input value={createdKey} readOnly /></label>
      <div className="setup-controls">
        <Button variant="quiet" type="button" onClick={() => void action(async () => {
          await navigator.clipboard.writeText(createdKey);
          setStatus('Workspace key copied.');
        })}>Copy key</Button>
        {!keySaved && <Button variant="quiet" type="button" disabled={busy} onClick={() => void action(async () => {
          await saveKey(createdKey);
          setStatus('Workspace key saved in Cowork.');
        })}>Save key in Cowork</Button>}
        <Button variant="quiet" type="button" onClick={() => setCreatedKey('')}>Hide key</Button>
      </div>
    </div>}
    {workspaceKey && !keySaved && !createdKey && <p>Paste your existing Agent Connections key to let Cowork use it.</p>}
    {!onboarding && workspaceKey && <div className="setup-controls">
      <Button variant="quiet" type="button" disabled={busy} onClick={() => {
        if (!window.confirm('Revoke this workspace key? Clients using it will lose access.')) return;
        void action(async () => {
          await gateway('/workspace/key?id=' + encodeURIComponent(workspaceKey.id), 'DELETE');
          setCreatedKey('');
          await refresh();
        });
      }}>Revoke workspace key</Button>
      <Button variant="quiet" type="button" onClick={() => void action(async () => {
        await navigator.clipboard.writeText(new URL('/mcp', window.location.origin).href);
        setStatus('MCP URL copied.');
      })}>Copy MCP URL</Button>
    </div>}

    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

type ActivityPage = { entries: Activity[]; next?: string };

export function ConnectionActivity() {
  const [options, setOptions] = useState<{ connections: Connection[]; credentials: Map<string, string> }>();
  const [optionsError, setOptionsError] = useState('');
  const [optionAttempt, setOptionAttempt] = useState(0);
  const [filters, setFilters] = useState({ connection: '', client: '' });
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [page, setPage] = useState<ActivityPage>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const top = useRef<HTMLDivElement>(null);
  const before = cursors.at(-1);
  const loading = !page && !error;

  useEffect(() => {
    let current = true;
    void Promise.all([gateway<Connection[]>('/connections'), gateway<GatewayKey | null>('/workspace/key')])
      .then(([connections, key]) => {
        if (!current) return;
        const credentials = new Map<string, string>();
        if (key) credentials.set(key.id, key.name);
        for (const connection of connections) {
          for (const id of connection.clients ?? []) {
            if (!credentials.has(id)) credentials.set(id, id);
          }
          for (const agent of connection.agents ?? []) credentials.set(agent.id, agent.name);
        }
        setOptions({ connections, credentials });
      })
      .catch(() => { if (current) setOptionsError('Could not load activity filters.'); });
    return () => { current = false; };
  }, [optionAttempt]);

  useEffect(() => {
    let current = true;
    const query = new URLSearchParams();
    if (filters.connection) query.set('connection', filters.connection);
    if (filters.client) query.set('client', filters.client);
    if (before) query.set('before', before);
    void gateway<ActivityPage>('/activity?' + query)
      .then((result) => { if (current) setPage(result); })
      .catch((failure: Error) => { if (current) setError(failure.message); });
    return () => { current = false; };
  }, [filters, before, attempt]);

  function changeFilter(name: keyof typeof filters, value: string) {
    setPage(undefined);
    setError('');
    setFilters({ ...filters, [name]: value });
    setCursors([undefined]);
  }

  function goToPage(nextCursors: typeof cursors, fromBottom: boolean) {
    if (fromBottom) {
      top.current?.focus({ preventScroll: true });
      top.current?.scrollIntoView({ block: 'start' });
    }
    setPage(undefined);
    setError('');
    setCursors(nextCursors);
  }

  function pagination(fromBottom = false) {
    const next = page?.next;
    return <div className="flex flex-wrap items-center gap-2" role="group" aria-label={fromBottom ? 'Activity pages at end of log' : 'Activity pages'}>
      <Button variant="quiet" type="button" disabled={loading || cursors.length === 1}
        onClick={() => goToPage(cursors.slice(0, -1), fromBottom)}>Newer</Button>
      <span className="px-1 text-sm text-[var(--muted)]" aria-live={fromBottom ? undefined : 'polite'}>Page {cursors.length}</span>
      <Button variant="quiet" type="button" disabled={!next}
        onClick={() => { if (next) goToPage([...cursors, next], fromBottom); }}>Older</Button>
    </div>;
  }

  return <div className="stack">
    <div ref={top} tabIndex={-1} className="flex scroll-mt-20 flex-wrap items-end justify-between gap-4">
      <div className="grid w-full min-w-0 grid-cols-1 gap-3 min-[360px]:grid-cols-2 sm:max-w-md sm:flex-1">
        <div className="grid min-w-0 gap-1">
          <label htmlFor="activity-connection">Connection</label>
          <Select id="activity-connection" value={filters.connection} disabled={!options} onChange={(event) => changeFilter('connection', event.target.value)}>
            <option value="">All connections</option>
            {options?.connections.map((item) => <option value={item.id} key={item.id}>{label(item)}</option>)}
          </Select>
        </div>
        <div className="grid min-w-0 gap-1">
          <label htmlFor="activity-credential">Credential</label>
          <Select id="activity-credential" value={filters.client} disabled={!options} onChange={(event) => changeFilter('client', event.target.value)}>
            <option value="">All credentials</option>
            {options && [...options.credentials].map(([id, name]) => <option value={id} key={id}>{name}</option>)}
          </Select>
        </div>
      </div>
      {pagination()}
    </div>
    {optionsError && <div className="flex flex-wrap items-center gap-2">
      <p role="alert">{optionsError}</p>
      <Button variant="quiet" type="button" onClick={() => { setOptionsError(''); setOptionAttempt((value) => value + 1); }}>Retry filters</Button>
    </div>}
    <div className="panel">
      {loading && <p className="p-4" role="status">Loading activity…</p>}
      {error && <div className="flex flex-wrap items-center gap-2 p-4">
        <p role="alert">{error}</p>
        <Button variant="quiet" type="button" onClick={() => { setError(''); setAttempt((value) => value + 1); }}>Try again</Button>
      </div>}
      {page && (page.entries.length ? <ul className="divide-y divide-[var(--line)]" role="list" aria-label="Activity log">
        {page.entries.map((event) => <li key={event.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto_5.5rem] sm:items-center">
          <div className="min-w-0 wrap-anywhere">
            <strong>{event.operation.replaceAll('_', ' ')}</strong>
            <p className="text-sm text-[var(--muted)]">{[event.agentName, event.connectionLabel].filter(Boolean).join(' · ')}</p>
          </div>
          <time className="col-span-2 text-sm text-[var(--muted)] tabular-nums sm:col-span-1 sm:col-start-2 sm:row-start-1"
            dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time>
          <span className={`status col-start-2 row-start-1 self-start justify-self-end sm:col-start-3 sm:self-center ${event.succeeded ? 'review' : 'attention'}`}>
            {event.succeeded ? 'Succeeded' : 'Failed'}
          </span>
        </li>)}
      </ul> : <p className="p-4">{filters.connection || filters.client ? 'No activity matches these filters.' : 'No activity recorded.'}</p>)}
    </div>
    {page && (page.next || cursors.length > 1) && <div className="flex justify-end">{pagination(true)}</div>}
  </div>;
}

export async function saveConnectionKey(key: string) {
  await api('agent-connection', { Enabled: true, Key: key });
}
