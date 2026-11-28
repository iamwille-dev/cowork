import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { implementStandalone } from '../../src/mastra/workflows/standalone.ts';

// Configure this trusted module as COWORK_RUNNER on the Cowork worker.
const workspace = process.env.COWORK_SANDBOX_WORKSPACE_ID;
const token = process.env.COWORK_SANDBOX_TOKEN;
const endpoint = new URL(process.env.COWORK_SANDBOX_URL);
if (!/^[a-f0-9]{48}$/.test(workspace ?? '') || !token || endpoint.username || endpoint.password ||
    !(endpoint.protocol === 'https:' || (endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1'))) {
  throw new Error('The sandbox runner requires a workspace, token, and HTTPS or loopback endpoint.');
}

function render(body, signal) {
  const request = endpoint.protocol === 'https:' ? httpsRequest : httpRequest;
  const ca = process.env.COWORK_SANDBOX_CA_PEM;
  return new Promise((resolve, reject) => {
    const outgoing = request(new URL('/render', endpoint), {
      method: 'POST',
      ...(ca && { ca }),
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      signal,
    }, async (response) => {
      try {
        if (response.statusCode !== 200) {
          response.resume();
          throw Object.assign(new Error(`Sandbox render failed (HTTP ${response.statusCode}).`), { statusCode: response.statusCode });
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of response) {
          length += chunk.length;
          if (length > 4 * 1024 * 1024) throw new Error('Sandbox result exceeded the limit.');
          chunks.push(chunk);
        }
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (error) {
        reject(error);
      }
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}

export default {
  standalone: true,
  supports(task) {
    return task.WorkspaceID === workspace && task.UI && !task.Repository;
  },
  async create(task) {
    if (task.WorkspaceID !== workspace) throw new Error('This workspace has no sandbox assigned.');
    if (!task.UI || task.Repository) throw new Error('The sandbox pilot supports standalone UI tasks.');
    return task.ID;
  },
  async checkout() {
    throw new Error('Repository checkout is unavailable in the sandbox pilot.');
  },
  async implement(sandbox, task, plan, requestContext) {
    const { html } = await implementStandalone(sandbox, task, plan, requestContext);
    const body = JSON.stringify({ html });
    const signal = AbortSignal.timeout(85_000);
    const { screenshot } = await render(body, signal).catch((error) => {
      if (error.statusCode === 502 || error.code === 'ECONNRESET') return render(body, signal);
      throw error;
    });
    if (typeof screenshot !== 'string') throw new Error('Invalid sandbox result.');
    const png = Buffer.from(screenshot, 'base64');
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid sandbox screenshot.');
    return { html, screenshot: png };
  },
  async openPullRequest() {
    return null;
  },
};
