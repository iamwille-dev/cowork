import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRemoteWorkspace } from '../../src/mastra/docker-workspace.ts';

const sessions = ['a', 'b'].map((suffix) => createRemoteWorkspace(`cowork-smoke-${randomUUID()}-${suffix}`));
const [first, second] = sessions;

try {
  await first.workspace.init();
  await second.workspace.init();
  assert.notEqual(first.sandbox.container.id, second.sandbox.container.id);

  await first.sandbox.writeFiles([{ path: 'hello.cjs', content: 'console.log("remote-sandbox-ok");\n' }]);
  const result = await first.sandbox.executeCommand('node', ['hello.cjs']);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'remote-sandbox-ok');

  const isolated = await second.sandbox.executeCommand('node', ['-e', 'console.log(require("node:fs").existsSync("hello.cjs"))']);
  assert.equal(isolated.exitCode, 0, isolated.stderr);
  assert.equal(isolated.stdout.trim(), 'false');
} finally {
  const cleanup = await Promise.allSettled(sessions.map((session) => session.destroy()));
  for (const result of cleanup) {
    if (result.status === 'rejected') throw result.reason;
  }
}

console.log('remote-sandbox-ok');
