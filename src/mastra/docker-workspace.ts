import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { Agent as HTTPSAgent } from 'node:https';
import { join } from 'node:path';
import type { RequestContext } from '@mastra/core/request-context';
import { Workspace } from '@mastra/core/workspace';
import { DockerSandbox } from '@mastra/docker';
import { coworkStateDir } from '../state.ts';

const idleTimeout = 30 * 60 * 1000;
const maxSessions = 4;
const sandboxContextKey = 'coworkDockerSandbox';
const sessionIdPattern = /^cowork-[a-f0-9]{64}$/;

function dockerHost() {
  return process.env.MASTRA_DOCKER_HOST?.trim().toLowerCase();
}

function leaseDirectory(host: string) {
  return join(coworkStateDir, 'docker-sandboxes', createHash('sha256').update(host).digest('hex'));
}

export function createRemoteWorkspace(id: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$/.test(id)) throw new Error('Invalid sandbox ID.');

  const host = dockerHost();
  const certDir = process.env.MASTRA_DOCKER_CERT_DIR?.trim();
  if (!host || !certDir || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new Error('Set MASTRA_DOCKER_HOST to a hostname and MASTRA_DOCKER_CERT_DIR to the client bundle directory.');
  }

  const ca = readFileSync(join(certDir, 'ca.pem'));
  const cert = readFileSync(join(certDir, 'cert.pem'));
  const key = readFileSync(join(certDir, 'key.pem'));
  // Funnel can reset resumed TLS sessions. Keep certificate and hostname verification enabled.
  const agent = new HTTPSAgent({ maxCachedSessions: 0, rejectUnauthorized: true });
  const sandbox = new DockerSandbox({
    id,
    image: 'node:22-slim',
    workingDirectory: '/workspace',
    labels: { 'cowork.sandbox': 'true' },
    dockerOptions: { protocol: 'https', host, port: 443, ca, cert, key, agent, connectionTimeout: 10_000, timeout: 30_000 },
    memory: 1024 ** 3,
    memorySwap: 1024 ** 3,
    cpuPeriod: 100_000,
    cpuQuota: 100_000,
    pidsLimit: 256,
    capDrop: ['ALL'],
    securityOpt: ['no-new-privileges:true'],
    timeout: 30_000,
  });
  const workspace = new Workspace({ sandbox });

  return {
    workspace,
    sandbox,
    async destroy() {
      try {
        // An unstarted instance can still remove a container left by a previous worker.
        if (sandbox.status === 'pending') await sandbox.destroy();
        else await workspace.destroy();
      } finally {
        agent.destroy();
      }
    },
  };
}

type SandboxSession = ReturnType<typeof createRemoteWorkspace> & {
  activeTurns: number;
};

const sessions = new Map<string, SandboxSession>();
const cleanups = new Map<string, Promise<void>>();

function logSandboxError(message: string, id: string, error: unknown) {
  console.error(message, id, error instanceof Error ? error.message : error);
}

export function startDockerSandboxCleanup() {
  const host = dockerHost();
  if (!host || !process.env.MASTRA_DOCKER_CERT_DIR?.trim()) return;
  const directory = leaseDirectory(host);

  function sweep() {
    try {
      if (!existsSync(directory)) return;
      const cutoff = Date.now() - idleTimeout;
      for (const id of readdirSync(directory).filter((name) => sessionIdPattern.test(name))) {
        if (cleanups.has(id) || sessions.get(id)?.activeTurns) continue;
        const leasePath = join(directory, id);
        if (statSync(leasePath).mtimeMs > cutoff) continue;

        const session = sessions.get(id);
        sessions.delete(id);
        const cleanup = Promise.resolve().then(async () => {
          await (session ?? createRemoteWorkspace(id)).destroy();
          unlinkSync(leasePath);
        }).catch((error) => {
          logSandboxError('Cowork could not remove an idle Docker sandbox.', id, error);
        }).finally(() => {
          cleanups.delete(id);
        });
        cleanups.set(id, cleanup);
      }
    } catch (error) {
      logSandboxError('Cowork could not read Docker sandbox leases.', '', error);
    }
  }

  sweep();
  setInterval(sweep, 60_000).unref();
}

async function acquireSession(id: string, directory: string) {
  await cleanups.get(id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const leasePath = join(directory, id);
  if (!existsSync(leasePath) && readdirSync(directory).filter((name) => sessionIdPattern.test(name)).length >= maxSessions) {
    throw new Error('All Cowork Docker sandboxes are in use. Try again after one expires.');
  }
  try {
    const session = sessions.get(id) ?? { ...createRemoteWorkspace(id), activeTurns: 0 };
    // Record the lease before provisioning so the next worker can reap it after a crash.
    writeFileSync(leasePath, '', { mode: 0o600 });
    sessions.set(id, session);
    session.activeTurns++;
    return session;
  } catch (error) {
    logSandboxError('Cowork could not prepare a Docker sandbox.', id, error);
    throw new Error('Cowork could not prepare the Docker sandbox.');
  }
}

export function bindDockerSandbox(requestContext: Pick<RequestContext, 'setRaw'>, scope: readonly string[]) {
  const host = dockerHost();
  if (!host || !process.env.MASTRA_DOCKER_CERT_DIR?.trim()) return;

  const id = 'cowork-' + createHash('sha256').update(JSON.stringify(scope)).digest('hex');
  const directory = leaseDirectory(host);
  let lease: Promise<SandboxSession> | undefined;
  requestContext.setRaw(sandboxContextKey, async () => {
    lease ??= acquireSession(id, directory).catch((error) => {
      lease = undefined;
      throw error;
    });
    const session = await lease;
    try {
      await session.sandbox.start();
    } catch (error) {
      logSandboxError('Cowork could not start a Docker sandbox.', id, error);
      throw new Error('Cowork could not start the remote Docker sandbox.');
    }
    return session.sandbox;
  });

  return async () => {
    const session = await lease?.catch(() => undefined);
    if (!session) return;
    if (--session.activeTurns === 0) {
      try {
        writeFileSync(join(directory, id), '', { mode: 0o600 });
      } catch (error) {
        logSandboxError('Cowork could not renew a Docker sandbox lease.', id, error);
      }
    }
  };
}

const workspace = new Workspace({
  id: 'cowork-docker',
  sandbox: ({ requestContext }) => {
    const resolve = requestContext.getRaw(sandboxContextKey);
    if (typeof resolve !== 'function') throw new Error('This conversation has no Docker sandbox.');
    return (resolve as () => Promise<DockerSandbox>)();
  },
  instructions: {
    dynamicSandbox: () => 'Use the Docker sandbox for command or code execution requested by the latest participant. Keep working files under /workspace. Report failures using the actual tool output.',
  },
});

export function dockerAgentWorkspace({ requestContext }: { requestContext: RequestContext }) {
  if (typeof requestContext.getRaw(sandboxContextKey) === 'function') return workspace;
}
