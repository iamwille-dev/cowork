import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { json } from 'node:stream/consumers';
import { test } from 'node:test';
import { Agent } from '@mastra/core/agent';
import { MockLanguageModelV4 } from 'ai/test';
import { agentConnection } from './agent-connection.ts';

const connectionSchema = { type: 'object', properties: { connection_id: { type: 'string' } }, required: ['connection_id'] };
const commitsSchema = {
  ...connectionSchema,
  properties: {
    ...connectionSchema.properties,
    owner: { type: 'string' },
    repo: { type: 'string' },
    ref: { type: 'string' },
    limit: { type: 'integer' },
  },
  required: ['connection_id', 'owner', 'repo'],
};

test('discovers MCP tools and permits calls only for the selected agent’s granted accounts', async (t) => {
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const commitArgs = { connection_id: 'granted', owner: 'example', repo: 'demo', ref: 'main', limit: 1 };
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer test-key') {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await json(req) as {
      id?: number;
      method: string;
      params: { name: string; arguments: Record<string, unknown>; cursor?: string; protocolVersion: string };
    };
    if (body.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result;
    if (body.method === 'initialize') {
      result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
    } else if (body.method === 'tools/list') {
      result = body.params?.cursor ? { tools: [
        { name: 'github_list_commits', inputSchema: commitsSchema, annotations: { readOnlyHint: true } },
        { name: 'github_publish_release', inputSchema: connectionSchema, annotations: { readOnlyHint: false } },
      ] } : { tools: [{ name: 'gmail_search', inputSchema: connectionSchema }], nextCursor: 'next' };
    } else if (body.method === 'tools/call') {
      calls.push(body.params);
      const structuredContent = body.params.name === 'list_connections'
        ? { connections: [{ id: 'granted', kind: 'github' }, { id: 'other', kind: 'github' }, { id: 'mail', kind: 'gmail' }] }
        : { data: [{ sha: 'abc123', commit: { message: 'Fix latest deployment' } }] };
      result = { content: [], structuredContent };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const previous = process.env.AGENT_CONNECTIONS_MCP_URL;
  process.env.AGENT_CONNECTIONS_MCP_URL = `http://127.0.0.1:${address.port}/mcp`;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_CONNECTIONS_MCP_URL;
    else process.env.AGENT_CONNECTIONS_MCP_URL = previous;
  });
  const context = { AgentConnectionWorkspace: 'test', AgentConnectionKey: 'test-key', AgentConnectionIDs: ['granted'] };
  const { connection, tools } = await agentConnection(context);
  assert.deepEqual(Object.keys(tools.agentConnection).sort(), ['github_list_commits', 'github_publish_release', 'list_connections']);
  assert.deepEqual(await tools.agentConnection.list_connections.execute?.({}), {
    connections: [{ id: 'granted', kind: 'github', tools: ['github_list_commits', 'github_publish_release'] }],
  });
  assert.ok(connection);
  await connection.connect(async (client) => {
    for (const [name, id] of [['github_list_commits', 'other'], ['gmail_search', 'granted']]) {
      await assert.rejects(client.callTool({ name, arguments: { connection_id: id } }), /not enabled/);
    }
  });
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({ doGenerate: async ({ tools: modelTools, prompt }) => {
    const tool = modelTools?.find((candidate) => candidate.name === 'github_list_commits');
    assert.ok(tool?.type === 'function');
    assert.deepEqual(tool.inputSchema.properties, commitsSchema.properties);
    if (prompt.some(({ role }) => role === 'tool')) {
      assert.match(JSON.stringify(prompt), /Fix latest deployment/);
      return { content: [{ type: 'text', text: 'Latest commit is abc123.' }], finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] };
    }
    return {
      content: [{ type: 'tool-call', toolCallId: 'commit-check', toolName: tool.name, input: JSON.stringify(commitArgs) }],
      finishReason: { unified: 'tool-calls', raw: undefined },
      usage, warnings: [],
    };
  } });
  const agent = new Agent({ id: 'test', name: 'Test', model, instructions: 'Help with commit history.' });
  const reply = await agent.generate('Fetch the latest commit on main.', { toolsets: tools, maxSteps: 2 });
  assert.equal(reply.text, 'Latest commit is abc123.');
  assert.deepEqual(calls.map(({ name }) => name), ['list_connections', 'github_list_commits']);
  assert.deepEqual(calls[1]?.arguments, commitArgs);

  const withMail = await agentConnection({ ...context, AgentConnectionIDs: ['granted', 'mail'] });
  assert.deepEqual(Object.keys(withMail.tools.agentConnection).sort(), ['github_list_commits', 'github_publish_release', 'gmail_search', 'list_connections']);
  const denied = await agentConnection({ ...context, AgentConnectionIDs: [] });
  assert.deepEqual(Object.keys(denied.tools.agentConnection), ['list_connections']);
  assert.equal(calls.length, 3);
  const unconfigured = await agentConnection({});
  assert.deepEqual(Object.keys(unconfigured.tools.agentConnection), ['list_connections']);
  const paused = await agentConnection({ ...context, AgentConnectionPaused: true });
  assert.deepEqual(Object.keys(paused.tools.agentConnection), ['list_connections']);
  assert.deepEqual(await paused.tools.agentConnection.list_connections.execute?.({}), {
    connections: [],
    detail: 'Agent Connections tools are paused for this workspace. The workspace owner can enable connected tools in Settings.',
  });
  assert.equal(calls.length, 3);
});
