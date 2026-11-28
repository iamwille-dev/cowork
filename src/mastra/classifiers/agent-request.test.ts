import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentRequestClassifier, checkChatScope, checkTaskScope } from './agent-request.ts';

test('chat scope uses the latest message with conversation context and redirects mismatches', async (t) => {
  const decide = t.mock.method(agentRequestClassifier, 'decide', async ({ state }: { state: unknown }) => {
    assert.deepEqual(state, {
      message: 'Please implement it now.',
      history: [
        { speaker: 'current participant', text: 'We need a settings page.' },
        { speaker: 'agent', text: 'Should I draft requirements or implement the page?' },
      ],
    });
    return { answers: { role: { type: 'choice', choice: 'Developer' } } };
  });
  const messages = [
    { Text: 'We need a settings page.', SenderID: 'member' },
    { Text: 'Should I draft requirements or implement the page?', Agent: true },
    { Text: 'Please implement it now.', SenderID: 'member' },
  ];
  assert.deepEqual(await checkChatScope('Product Manager', messages), {
    allowed: false, message: 'Send this request to a Developer agent.',
  });
  assert.deepEqual(await checkChatScope('Developer', messages), { allowed: true });
  assert.equal(decide.mock.callCount(), 2);
});

test('task scope allows shared requests, blocks split-scope work, and fails closed on refusal', async (t) => {
  const task = { Title: 'Follow up', Brief: 'Draft a follow-up for the prospect.' };
  let response: { type: 'choice'; choice: string } | { type: 'refusal' } = { type: 'choice', choice: 'shared' };
  const decide = t.mock.method(agentRequestClassifier, 'decide', async () => ({ answers: { role: response } }));
  assert.deepEqual(await checkTaskScope('Sales Lead', task), { allowed: true });
  response = { type: 'choice', choice: 'mixed' };
  assert.equal((await checkTaskScope('Sales Lead', task)).allowed, false);
  response = { type: 'refusal' };
  const refused = await checkTaskScope('Sales Lead', task);
  assert.equal(refused.allowed, false);
  if (!refused.allowed) assert.equal(refused.unavailable, true);
  assert.deepEqual(await checkTaskScope('Sales Lead', { ...task, Repository: 'example/repo' }), {
    allowed: false, message: 'Assign this task to a Developer agent.',
  });
  assert.equal(decide.mock.callCount(), 3);
});
