import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataRoot } from './mastra/workflows/developer.ts';
import { respond, runScheduledTask, runTask } from './mastra/cowork.ts';
import { mastra } from './mastra/index.ts';
import { startTelegram } from './mastra/telegram.ts';
import { handleWebChat } from './chat-web.ts';

const types: Record<string, string> = {
  'plan.md': 'text/markdown; charset=utf-8',
  'preview.html': 'text/html; charset=utf-8',
  'screenshot.png': 'image/png',
};

async function worker(request: IncomingMessage, response: ServerResponse) {
  try {
    const url = request.url ?? "";
    const artifact = /^\/artifact\/([a-f0-9]{48})\/(plan\.md|preview\.html|screenshot\.png)$/.exec(url);
    if (request.method === 'GET' && artifact) {
      const [, task, file] = artifact;
      const bytes = await readFile(resolve(dataRoot, task, file));
      response.writeHead(200, {
        'Content-Type': types[file],
        'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        ...(file === 'plan.md' && { 'Content-Disposition': 'inline; filename="plan.md"' }),
      });
      response.end(bytes);
      return;
    }
    if (request.method !== 'POST' || !['/task', '/chat', '/scheduled-task'].includes(url)) {
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
    if (url === '/task') result = await runTask({ ...payload.Task, WorkspaceID: payload.WorkspaceID });
    else if (url === '/scheduled-task') result = await runScheduledTask(payload);
    else result = await respond(payload, typeof session === 'string' && /^[a-f0-9]{48}$/.test(session) ? session : undefined);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    console.error('Cowork worker request failed:', error instanceof Error ? error.name : 'Unknown error');
    response.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).end();
  }
}

createServer(worker).listen(4401, '127.0.0.1');

createServer(async (request, response) => {
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

startTelegram(mastra);
