import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { RequestContext } from '@mastra/core/request-context';

test('publishes a stable preview and restores the saved changes when the sandbox stops', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'cowork-developer-test-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  const runnerPath = join(state, 'runner.mjs');
  const previous = { ...process.env };
  t.after(() => {
    for (const name of ['OPENROUTER_API_KEY', 'COWORK_STATE_DIR', 'COWORK_RUNNER']) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  });
  delete process.env.OPENROUTER_API_KEY;
  process.env.COWORK_STATE_DIR = state;
  process.env.COWORK_RUNNER = runnerPath;
  await writeFile(runnerPath, `
    import assert from 'node:assert/strict';
    import { readFile, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';

    export const sandboxes = new Map();
    export let builds = 0;
    export let replacements = 0;
    export let healthy = true;
    export function stop() { sandboxes.clear(); }
    export function failToStart() { healthy = false; }
    export default {
      async create(task, directory, options) {
        const sandbox = options?.replacement ? ++replacements : 0;
        sandboxes.set(task.ID, sandbox);
        return sandbox;
      },
      async checkout() {},
      async implement(sandbox, task) {
        builds++;
        await writeFile(join(${JSON.stringify(state)}, 'artifacts', task.ID, 'changes'), task.Brief);
        stop();
        return {};
      },
      async stagePreview(sandbox, task, directory) {
        if (!healthy || !sandboxes.has(task.ID)) return null;
        const running = sandboxes.get(task.ID);
        assert.equal(sandbox ?? running, running);
        await writeFile(join(directory, 'staged'), await readFile(join(directory, 'changes')));
        return 'https://sandbox.example/' + running;
      },
      async openPullRequest(sandbox) {
        assert.equal(sandbox, 1);
        return 'https://repository.example/pull/1';
      },
    };
  `);

  const { developerWorkflow, dataRoot, openSandboxPreview } = await import('./developer.ts');
  const runner = await import(runnerPath);
  const task = { ID: 'a'.repeat(48), Title: 'Update API', Brief: 'Changed source', Repository: 'https://repository.example/main', UI: false };
  const run = async (ID: string) => (await developerWorkflow.createRun()).start({ inputData: { ...task, ID }, requestContext: new RequestContext() });
  const result = await run(task.ID);
  assert.equal(result.status, 'success');
  if (result.status !== 'success') assert.fail('Workflow returned no result.');
  assert.equal(result.result.Error, '');
  assert.ok(result.result.Steps.includes('Restored changes in a replacement sandbox'));
  assert.ok(result.result.Artifacts.some(({ URL }) => URL === `/api/artifact/${task.ID}/preview`));
  assert.equal(runner.builds, 1);
  assert.equal(await openSandboxPreview(task.ID), 'https://sandbox.example/1');

  runner.stop();
  assert.deepEqual(await Promise.all([openSandboxPreview(task.ID), openSandboxPreview(task.ID)]),
    ['https://sandbox.example/2', 'https://sandbox.example/2']);
  assert.equal(runner.replacements, 2);
  assert.equal(runner.builds, 1);
  assert.equal(await readFile(join(dataRoot, task.ID, 'staged'), 'utf8'), task.Brief);

  runner.failToStart();
  await assert.rejects(openSandboxPreview(task.ID), /did not return a ready HTTPS preview URL/);
});
