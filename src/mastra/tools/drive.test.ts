import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestContext } from '@mastra/core/request-context';
import { bindDrive, driveTools } from './drive.ts';

test('agents expose drive tools only for a scoped worker turn', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'cowork-drive-tools-'));
  const oldState = process.env.COWORK_STATE_DIR;
  process.env.COWORK_STATE_DIR = state;
  t.after(async () => {
    if (oldState === undefined) delete process.env.COWORK_STATE_DIR;
    else process.env.COWORK_STATE_DIR = oldState;
    await rm(state, { recursive: true, force: true });
  });

  const { developer } = await import('../agents/index.ts');
  const context = new RequestContext();
  assert.equal(Object.hasOwn(await developer.listTools({ requestContext: context }), 'searchDrive'), false);
  bindDrive(context, 'opaque-worker-grant');
  const scoped = await developer.listTools({ requestContext: context });
  const tools = scoped as typeof scoped & Partial<typeof driveTools>;
  assert.ok(tools.listDrive && tools.searchDrive && tools.readDriveFile && tools.editDriveFile);
  const requests: { url: string; fields: unknown }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).get('X-Cowork-Drive'), 'opaque-worker-grant');
    requests.push({ url, fields: JSON.parse(String(options.body)) });
    return Response.json({ item: { ID: 'file', Revision: 2 } });
  });
  const folderId = '7'.repeat(48);
  await tools.listDrive.execute!({ area: 'artifacts', folderId }, { requestContext: context });
  await tools.searchDrive.execute!({ query: 'Rollout', page: 2 }, { requestContext: context });
  await tools.editDriveFile.execute!({ id: 'file', revision: 1, text: 'New text' }, { requestContext: context });
  assert.deepEqual(requests, [
    { url: 'http://127.0.0.1:4000/internal/drive/list', fields: { Area: 'artifacts', ParentID: folderId } },
    { url: 'http://127.0.0.1:4000/internal/drive/list', fields: { Area: 'all', Query: 'Rollout', Page: 2 } },
    { url: 'http://127.0.0.1:4000/internal/drive/edit', fields: { ID: 'file', Revision: 1, Text: 'New text' } },
  ]);
});
