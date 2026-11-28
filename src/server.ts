import { getRequestListener } from '@hono/node-server';
import { respondFromChannel } from './mastra/channels/tools.ts';
import { createSlackHandler } from './mastra/channels/slack.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataRoot, openSandboxPreview } from './mastra/workflows/developer.ts';
import { staticPreviewPolicy } from './mastra/workflows/standalone.ts';
import { respond, runBackgroundTask, runGmailDigest, runTask } from './mastra/cowork.ts';
import { gmailDigestConnection, gmailDigestUnavailable } from './mastra/gmail-digest.ts';
import { checkTaskScope } from './mastra/classifiers/agent-request.ts';
import { startDockerSandboxCleanup } from './mastra/docker-workspace.ts';
import { mastra } from './mastra/index.ts';
import { liveModel } from './mastra/agents/index.ts';
import { createTelegramHandler, startTelegram } from './mastra/channels/telegram.ts';
import { handleWebChat } from './mastra/channels/web.ts';

const types: Record<string, string> = {
  'plan.md': 'text/markdown; charset=utf-8',
  'preview.html': 'text/html; charset=utf-8',
  'screenshot.png': 'image/png',
};

async function worker(request: IncomingMessage, response: ServerResponse) {
  try {
    const url = request.url ?? "";
    const artifact = /^\/artifact\/([a-f0-9]{48})\/(plan\.md|preview\.html|preview|screenshot\.png)$/.exec(url);
    if (request.method === 'GET' && artifact) {
      const [, task, file] = artifact;
      if (file === 'preview') {
        try {
          response.writeHead(307, { Location: await openSandboxPreview(task) }).end();
        } catch (error) {
          console.error('Cowork preview restoration failed:', error instanceof Error ? error.name : 'Unknown error');
          response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('The sandbox preview is temporarily unavailable. Reopen this link to retry.');
        }
        return;
      }
      const bytes = await readFile(resolve(dataRoot, task, file));
      response.writeHead(200, {
        'Content-Type': types[file],
        'Content-Security-Policy': staticPreviewPolicy,
        ...(file === 'plan.md' && { 'Content-Disposition': 'inline; filename="plan.md"' }),
      });
      response.end(bytes);
      return;
    }
    if (request.method !== 'POST' || !['/task', '/chat', '/scheduled-task', '/task-scope', '/gmail-digest-check', '/gmail-digest'].includes(url)) {
      response.writeHead(404).end();
      return;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of request) {
      length += chunk.length;
      if (length > 512 * 1024) {
        response.writeHead(413).end();
        return;
      }
      chunks.push(chunk);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString());
    const session = request.headers['x-cowork-session'];
    let result;
    if (url === '/task-scope') {
      const scope = await checkTaskScope(payload.Role, payload.Task);
      result = scope.allowed ? { ScopeAllowed: true } : { Error: scope.message, ScopeUnavailable: scope.unavailable };
    } else if (url === '/gmail-digest-check') {
      result = await gmailDigestConnection(payload, payload.Task.GmailConnectionID)
        ? { ScopeAllowed: true } : { Error: gmailDigestUnavailable };
    } else if (url === '/gmail-digest') result = await runGmailDigest(payload);
    else if (url === '/task') result = await runTask({ ...payload.Task, WorkspaceID: payload.WorkspaceID }, payload.AgentMemory, payload.DriveGrant);
    else if (url === '/scheduled-task') result = await runBackgroundTask(payload);
    else if (payload.ChannelActor?.Channel === 'telegram') {
      const reply = liveModel && await respondFromChannel(mastra, payload.ChannelActor, payload.Messages, { telegramThreadId: payload.ThreadID });
      result = { Reply: reply || '' };
    } else result = await respond(payload, typeof session === 'string' && /^[a-f0-9]{48}(?:\.\d+\.[a-f0-9]{64})?$/.test(session) ? session : undefined);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    console.error('Cowork worker request failed:', error instanceof Error ? error.name : 'Unknown error');
    response.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).end();
  }
}

createServer(worker).listen(4401, '127.0.0.1');

const slackListener = getRequestListener(createSlackHandler(mastra, liveModel));
const telegramListener = getRequestListener(createTelegramHandler(mastra));
createServer(async (request, response) => {
  const path = request.url?.split('?', 1)[0];
  if (path && /^\/api\/agents\/[^/]+\/channels\/telegram\/webhook$/.test(path)) {
    await telegramListener(request, response);
    return;
  }
  if (path === '/api/slack' || path?.startsWith('/api/slack/') || path?.startsWith('/integrations/slack/') ||
      (path && /^\/api\/agents\/[^/]+\/channels\/slack\/webhook$/.test(path))) {
    await slackListener(request, response);
    return;
  }
  if (request.url !== '/api/web-chat') {
    response.writeHead(404).end();
    return;
  }
  try {
    await handleWebChat(request, response);
  } catch {
    if (!response.headersSent) response.writeHead(502).end('Cowork chat is unavailable.');
    else if (!response.writableEnded) response.end();
  }
}).listen(4402, '127.0.0.1');

startDockerSandboxCleanup();
startTelegram(mastra);
