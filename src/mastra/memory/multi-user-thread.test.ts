import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inChannelThread, sharedChannelMemory } from './multi-user-thread.ts';

test('channel thread turns stay ordered without sharing memory across conversations or installations', async () => {
  const binding = { Channel: 'slack' as const, WorkspaceID: 'workspace', Installation: 'first-bot', Agent: 'ada', Conversation: 'slack:GPRIVATE:1.0' };
  const { thread, resource } = sharedChannelMemory(binding);
  const otherThread = sharedChannelMemory({ ...binding, Conversation: 'slack:GPRIVATE:2.0' });
  assert.notEqual(otherThread.resource, resource);
  assert.notEqual(sharedChannelMemory({ ...binding, Installation: 'other-bot' }).resource, resource);
  assert.notEqual(sharedChannelMemory({ ...binding, WorkspaceID: 'other-workspace' }).resource, resource);

  const finished = Promise.withResolvers<void>();
  const order: string[] = [];
  const first = inChannelThread(thread, async () => {
    order.push('Alice starts');
    await finished.promise;
    order.push('Alice ends');
    throw new Error('first turn failed');
  });
  const failed = assert.rejects(first, /first turn failed/);
  const second = inChannelThread(thread, async () => { order.push('Bob starts'); });
  await inChannelThread(otherThread.thread, async () => { order.push('Another conversation'); });
  assert.deepEqual(order, ['Alice starts', 'Another conversation']);
  finished.resolve();
  await Promise.all([failed, second]);
  assert.deepEqual(order, ['Alice starts', 'Another conversation', 'Alice ends', 'Bob starts']);
});
