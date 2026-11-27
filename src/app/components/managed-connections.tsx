'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from './api';
import { Select } from './select';
import { ConnectionCatalog, connectionApps, type ConnectionAppId } from './connection-catalog';
import type { WorkspaceAgent } from './onboarding';

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
  const [activity, setActivity] = useState<Activity[]>();
  const [next, setNext] = useState<string>();
  const [filter, setFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
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

  async function loadActivity(connection: string, client: string, before?: string) {
    const query = new URLSearchParams();
    if (connection) query.set('connection', connection);
    if (client) query.set('client', client);
    if (before) query.set('before', before);
    const result = await gateway<{ entries: Activity[]; next?: string }>('/activity?' + query);
    setActivity((current) => before ? [...(current ?? []), ...result.entries] : result.entries);
    setNext(result.next);
  }

  if (!enabled && !onboarding) return null;
  const clients = new Map<string, string>();
  if (workspaceKey) clients.set(workspaceKey.id, workspaceKey.name);
  for (const connection of connections ?? []) {
    for (const agent of connection.agents ?? []) clients.set(agent.id, agent.name);
    for (const id of connection.clients ?? []) clients.set(id, id);
  }

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
        <label>Host<input name="host" required autoFocus /></label>
        <label>Port<input name="port" type="number" min="1" max="65535" defaultValue="22" required /></label>
        <label>SSH user<input name="user" required /></label>
        <label>Host key fingerprint<input name="fingerprint" required placeholder="SHA256:…" /></label>
        <label>Private key<textarea name="private_key" autoComplete="off" required rows={4} /></label>
        <div className="setup-controls">
          <button className="quiet" disabled={busy}>Save SSH connection</button>
          <button className="quiet" type="button" disabled={busy} onClick={() => setSshOpen(false)}>Cancel</button>
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
                <button type="button" className="quiet" disabled={busy} onClick={() => void action(async () => {
                  await gateway('/connections/' + encodeURIComponent(connection.id) + '/grants/' + encodeURIComponent(client.id), 'DELETE');
                  await refresh();
                })}>Revoke</button>
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
            <label>OAuth client ID<input name="client" maxLength={500} required /></label>
            <div><button className="quiet" disabled={busy}>Grant access</button></div>
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
            <label>Agent key name<input name="name" maxLength={100} required /></label>
            <div><button className="quiet" disabled={busy}>Create key for this connection</button></div>
          </form>
          <div className="setup-controls">
            <button type="button" className="quiet" disabled={busy} onClick={() => {
              if (!window.confirm('Disconnect this account and revoke its grants?')) return;
              void action(async () => {
                const response = await gateway<{ warning?: string } | undefined>('/connections/' + encodeURIComponent(connection.id), 'DELETE');
                if (response?.warning) setStatus(response.warning);
                await refresh();
              });
            }}>Disconnect {labelProvider(connection.kind)}</button>
          </div>
        </details>}
      </div>)}
    </section>}

    {namedKey && <div className="stack">
      <label>New connection key<input value={namedKey} readOnly /></label>
      <div className="setup-controls">
        <button className="quiet" type="button" onClick={() => void action(async () => {
          await navigator.clipboard.writeText(namedKey);
          setStatus('Connection key copied.');
        })}>Copy connection key</button>
        <button className="quiet" type="button" onClick={() => setNamedKey('')}>Hide key</button>
      </div>
    </div>}
    {Boolean(connections?.length) && !keySaved && workspaceKey === null && <div>
      <button className="quiet" type="button" disabled={busy} onClick={() => void action(() => createWorkspaceKey(true))}>Generate and save a workspace key</button>
    </div>}
    {createdKey && <div className="stack">
      <label>New workspace key<input value={createdKey} readOnly /></label>
      <div className="setup-controls">
        <button className="quiet" type="button" onClick={() => void action(async () => {
          await navigator.clipboard.writeText(createdKey);
          setStatus('Workspace key copied.');
        })}>Copy key</button>
        {!keySaved && <button className="quiet" type="button" disabled={busy} onClick={() => void action(async () => {
          await saveKey(createdKey);
          setStatus('Workspace key saved in Cowork.');
        })}>Save key in Cowork</button>}
        <button className="quiet" type="button" onClick={() => setCreatedKey('')}>Hide key</button>
      </div>
    </div>}
    {workspaceKey && !keySaved && !createdKey && <p>Paste your existing Agent Connections key to let Cowork use it.</p>}
    {!onboarding && workspaceKey && <div className="setup-controls">
      <button className="quiet" type="button" disabled={busy} onClick={() => {
        if (!window.confirm('Revoke this workspace key? Clients using it will lose access.')) return;
        void action(async () => {
          await gateway('/workspace/key?id=' + encodeURIComponent(workspaceKey.id), 'DELETE');
          setCreatedKey('');
          await refresh();
        });
      }}>Revoke workspace key</button>
      <button className="quiet" type="button" onClick={() => void action(async () => {
        await navigator.clipboard.writeText(new URL('/mcp', window.location.origin).href);
        setStatus('MCP URL copied.');
      })}>Copy MCP URL</button>
    </div>}

    {!onboarding && <details className="setup-tool" onToggle={(event) => {
      if (event.currentTarget.open && !activity) void action(() => loadActivity(filter, clientFilter));
    }}>
      <summary>Activity</summary>
      <label>Connection
        <Select value={filter} onChange={(event) => {
          const value = event.target.value;
          setFilter(value);
          void action(() => loadActivity(value, clientFilter));
        }}>
          <option value="">All connections</option>
          {connections?.map((item) => <option value={item.id} key={item.id}>{label(item)}</option>)}
        </Select>
      </label>
      <label>Credential
        <Select value={clientFilter} onChange={(event) => {
          const value = event.target.value;
          setClientFilter(value);
          void action(() => loadActivity(filter, value));
        }}>
          <option value="">All credentials</option>
          {[...clients].map(([id, name]) => <option value={id} key={id}>{name}</option>)}
        </Select>
      </label>
      {activity?.length ? <ul className="setup-agents w-full">{activity.map((event) => (
        <li key={event.id}>
          <strong>{event.operation.replaceAll('_', ' ')}</strong>
          <span className={'status ml-2 ' + (event.succeeded ? 'review' : 'attention')}>{event.succeeded ? 'Succeeded' : 'Failed'}</span>
          <p>{[event.agentName, event.connectionLabel, new Date(event.occurredAt).toLocaleString()].filter(Boolean).join(' · ')}</p>
        </li>))}</ul> : activity && <p>No activity recorded.</p>}
      {next && <button className="quiet" type="button" disabled={busy} onClick={() => void action(() => loadActivity(filter, clientFilter, next))}>Load more</button>}
    </details>}
    {status && <p role="status">{status}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export async function saveConnectionKey(key: string) {
  await api('agent-connection', { Enabled: true, Key: key });
}
