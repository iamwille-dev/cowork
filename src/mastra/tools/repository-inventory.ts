import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { agentConnection } from './agent-connection.ts';
import type { GitTokens } from './repositories.ts';

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
type Connection = ReturnType<typeof agentConnection>;

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

async function connectedGithub(client: Client, result: Inventory) {
  const signal = AbortSignal.timeout(30_000);
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 8_000, signal });
    if (response.isError) throw new Error('Agent Connections declined the repository query.');
    return response.structuredContent;
  };

  const { connections } = connectionList.parse(await call('list_connections', {}));
  const github = (connections ?? []).filter(({ kind }) => kind === 'github');
  if (!github.length) return false;
  let scannedInstallation = false;
  for (const { id } of github) {
    try {
      const ids: number[] = [];
      const listed = await mcpPages(async (page) => {
        const { data } = installations.parse(await call('github_list_installations', { connection_id: id, page }));
        return { total: data.total_count, rows: data.installations };
      }, (rows) => ids.push(...rows.map((row) => row.id)));
      if (!listed) result.complete = false;
      for (const installationId of new Set(ids)) {
        try {
          const complete = await mcpPages(async (page) => {
            const { data } = installationRepos.parse(await call('github_list_repositories', {
              connection_id: id, installation_id: installationId, page,
            }));
            return { total: data.total_count, rows: data.repositories };
          }, (rows) => addRepositories(result, rows.map(({ full_name, html_url }) => ({ name: full_name, url: html_url }))));
          scannedInstallation = true;
          if (!complete) result.complete = false;
        } catch {
          result.complete = false;
          if (signal.aborted) return scannedInstallation;
        }
      }
    } catch {
      result.complete = false;
      if (signal.aborted) break;
    }
  }
  return scannedInstallation;
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

export function repositoryInventory(connection: Connection, tokens: GitTokens = {}) {
  return createTool({
    id: 'list_repositories',
    description: 'List or count repositories visible to the workspace credentials. Checks Agent Connections first, then Cowork’s saved GitHub or GitLab tokens if needed. Use for account-wide requests without a repository URL.',
    inputSchema: z.object({ provider: z.enum(['github', 'gitlab']).optional().describe('Specify only if the participant requests a provider.') }),
    execute: async ({ provider }) => {
      const results: Inventory[] = [];
      if (connection && provider !== 'gitlab') {
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
