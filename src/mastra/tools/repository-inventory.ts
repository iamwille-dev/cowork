import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { AgentConnection, ConnectionClient } from './agent-connection.ts';
import { repositoryTools, repositoryURL, type GitTokens } from './repositories.ts';

export function workspaceRepositoryTools(connection: AgentConnection | undefined, tokens?: GitTokens) {
  const checkout = tokens && repositoryTools(tokens);
  return {
    tools: {
      ...checkout?.tools,
      ...((checkout || connection?.hasTools('github_list_installations', 'github_list_repositories')) && {
        list_repositories: repositoryInventory(connection, tokens),
      }),
      ...((checkout || connection?.hasTools('github_get_repository')) && {
        get_repository: repositoryMetadata(connection, tokens),
      }),
    },
    close: checkout?.close,
  };
}

const githubRepo = z.object({ full_name: z.string(), html_url: z.string() });
const gitlabRepo = z.object({ path_with_namespace: z.string(), web_url: z.string() });
const connectionList = z.object({ connections: z.array(z.object({ id: z.string(), kind: z.string() })).nullable() });
const installations = z.object({ data: z.object({
  total_count: z.number(),
  installations: z.array(z.object({ id: z.number() })),
}) });
const installationRepos = z.object({ data: z.object({
  total_count: z.number(),
  repositories: z.array(githubRepo),
}) });

type Provider = keyof GitTokens;
type Repo = { name: string; url: string };
type Inventory = { source: string; provider: Provider; repositories: Map<string, Repo>; complete: boolean };

function mcpReader(client: ConnectionClient) {
  const signal = AbortSignal.timeout(30_000);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 8_000, signal });
    if (response.isError) throw new Error('Agent Connections declined the repository query.');
    return response.structuredContent;
  };
  return { call, signal };
}

async function githubConnections(call: ReturnType<typeof mcpReader>['call']) {
  const { connections } = connectionList.parse(await call('list_connections', {}));
  return (connections ?? []).filter(({ kind }) => kind === 'github');
}

function inventory(source: string, provider: Provider): Inventory {
  return { source, provider, repositories: new Map(), complete: true };
}

function addRepositories(result: Inventory, rows: Repo[]) {
  for (const repo of rows) result.repositories.set(repo.name.toLowerCase(), repo);
}

async function mcpPages<T>(read: (page: number) => Promise<{ total: number; rows: T[] }>, consume: (rows: T[]) => void) {
  let seen = 0;
  for (let page = 1; page <= 100; page++) {
    const { total, rows } = await read(page);
    consume(rows);
    seen += rows.length;
    if (seen >= total) return true;
    if (!rows.length) break;
  }
  return false;
}

async function connectedGithub(client: ConnectionClient, result: Inventory) {
  const { call, signal } = mcpReader(client);
  const github = await githubConnections(call);
  if (!github.length) return false;
  let hasInventory = false;
  for (const { id } of github) {
    try {
      const ids: number[] = [];
      const listed = await mcpPages(async (page) => {
        const { data } = installations.parse(await call('github_list_installations', { connection_id: id, page }));
        return { total: data.total_count, rows: data.installations };
      }, (rows) => ids.push(...rows.map((row) => row.id)));
      if (!listed) result.complete = false;
      if (listed && ids.length === 0) hasInventory = true;
      for (const installationId of new Set(ids)) {
        try {
          const complete = await mcpPages(async (page) => {
            const { data } = installationRepos.parse(await call('github_list_repositories', {
              connection_id: id, installation_id: installationId, page,
            }));
            return { total: data.total_count, rows: data.repositories };
          }, (rows) => addRepositories(result, rows.map(({ full_name, html_url }) => ({ name: full_name, url: html_url }))));
          hasInventory = true;
          if (!complete) result.complete = false;
        } catch {
          result.complete = false;
          if (signal.aborted) return hasInventory;
        }
      }
    } catch {
      result.complete = false;
      if (signal.aborted) break;
    }
  }
  return hasInventory;
}

async function builtInInventory(provider: Provider, token: string) {
  const result = inventory('Cowork workspace token', provider);
  const github = provider === 'github';
  const endpoint = github
    ? 'https://api.github.com/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member'
    : 'https://gitlab.com/api/v4/projects?membership=true';
  const signal = AbortSignal.timeout(25_000);
  for (let page = 1; page <= 100; page++) {
    try {
      const response = await fetch(`${endpoint}&per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error',
        signal,
      });
      if (!response.ok) throw new Error(String(response.status));
      const data: unknown = await response.json();
      const rows = github
        ? z.array(githubRepo).parse(data).map(({ full_name, html_url }) => ({ name: full_name, url: html_url }))
        : z.array(gitlabRepo).parse(data).map(({ path_with_namespace, web_url }) => ({ name: path_with_namespace, url: web_url }));
      addRepositories(result, rows);
      if (rows.length < 100) return result;
    } catch {
      result.complete = false;
      return result;
    }
  }
  result.complete = false;
  return result;
}

export function repositoryInventory(connection: AgentConnection | undefined, tokens: GitTokens = {}) {
  return createTool({
    id: 'list_repositories',
    description: 'List or count repositories visible to the workspace credentials. Checks Agent Connections first, then Cowork’s saved GitHub or GitLab tokens if needed. Use for account-wide requests without a repository URL.',
    inputSchema: z.object({ provider: z.enum(['github', 'gitlab']).optional().describe('Specify only if the participant requests a provider.') }),
    execute: async ({ provider }) => {
      const results: Inventory[] = [];
      if (connection?.hasTools('github_list_installations', 'github_list_repositories') && provider !== 'gitlab') {
        const result = inventory('Agent Connections GitHub App', 'github');
        const available = await connection.connect((client) => connectedGithub(client, result)).catch(() => false);
        if (result.repositories.size || (available && !tokens.github)) results.push(result);
      }
      if (!results.some(({ provider }) => provider === 'github') && provider !== 'gitlab' && tokens.github) {
        results.push(await builtInInventory('github', tokens.github));
      }
      if (provider !== 'github' && tokens.gitlab && (provider === 'gitlab' || !results.some((result) => result.source === 'Agent Connections GitHub App' && result.repositories.size))) {
        results.push(await builtInInventory('gitlab', tokens.gitlab));
      }
      if (!results.length) return { error: 'No usable repository access was found. Check the Agent Connections GitHub grant or the workspace GitHub or GitLab token.' };
      return { sources: results.map(({ source, provider, repositories, complete }) => ({
        source, provider, count: repositories.size, complete,
        truncated: repositories.size > 200,
        repositories: [...repositories.values()].slice(0, 200),
      })) };
    },
  });
}

const githubMetadata = githubRepo.extend({
  description: z.string().nullable().optional(),
  default_branch: z.string().optional(),
  private: z.boolean().optional(),
});
const gitlabMetadata = gitlabRepo.extend({
  description: z.string().nullable().optional(),
  default_branch: z.string().nullable().optional(),
  visibility: z.string().optional(),
});

export function repositoryMetadata(connection: AgentConnection | undefined, tokens: GitTokens = {}) {
  return createTool({
    id: 'get_repository',
    description: 'Look up repository metadata such as default branch, description, or visibility. Checks the Agent Connections GitHub grant first, then Cowork’s saved token for the same provider. Use pull_repository when you need file contents.',
    inputSchema: z.object({ url: z.string().max(500).describe('GitHub.com or GitLab.com repository URL.') }),
    execute: async ({ url }) => {
      const repository = repositoryURL(url);
      if (!repository) return { error: 'Use a GitHub.com or GitLab.com HTTPS repository URL.' };
      const { provider, parts } = repository;
      if (provider === 'github' && connection?.hasTools('github_get_repository')) {
        const metadata = await connection.connect(async (client) => {
          const { call, signal } = mcpReader(client);
          const [owner, repo] = parts;
          for (const { id } of await githubConnections(call)) {
            try {
              const { data } = z.object({ data: githubMetadata }).parse(await call('github_get_repository', {
                connection_id: id, owner, repo,
              }));
              return data;
            } catch {
              if (signal.aborted) break;
            }
          }
        }).catch(() => undefined);
        if (metadata) return { source: 'Agent Connections GitHub App', repository: metadata };
      }

      const token = tokens[provider];
      if (!token) return { error: 'No usable connection or saved workspace token could read this repository.' };
      const path = parts.join('/');
      const endpoint = provider === 'github'
        ? `https://api.github.com/repos/${path}`
        : `https://gitlab.com/api/v4/projects/${encodeURIComponent(path)}`;
      try {
        const response = await fetch(endpoint, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) {
          const schema = provider === 'github' ? githubMetadata : gitlabMetadata;
          return { source: 'Cowork workspace token', repository: schema.parse(await response.json()) };
        }
      } catch { /* Report connection and permission failures without disclosing credentials. */ }
      return { error: 'The saved workspace token could not read this repository. Check its repository permissions.' };
    },
  });
}
