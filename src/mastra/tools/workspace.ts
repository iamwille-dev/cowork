import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

type RecordResult = { id: string; status?: string; due?: string; error?: string };
export type WorkspaceWrite = (route: 'task' | 'reminder', data: Record<string, unknown>) => Promise<RecordResult>;

const outcome = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  due: z.string().optional(),
  error: z.string().optional(),
});
const unavailable = { error: 'Creating workspace items requires a signed-in Cowork conversation.' };

export const createTask = createTool({
  id: 'createTask',
  description: 'Create an assigned task in the current Cowork workspace. The workflow runs only in Developer workspaces. Other roles receive an assigned task for tracking.',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(120),
    brief: z.string().trim().min(1).max(6000),
    repository: z.url({ protocol: /^https$/ }).max(500).optional().describe('Repository URL explicitly supplied by the user'),
    changesUI: z.boolean().describe('Whether the task changes a user interface and needs a screenshot'),
  }),
  outputSchema: outcome,
  execute: async (input, context) => {
    const write = context?.requestContext?.get('workspaceWrite');
    if (typeof write !== 'function') return unavailable;
    return (write as WorkspaceWrite)('task', {
      Title: input.title, Brief: input.brief, Repository: input.repository, UI: input.changesUI,
    });
  },
});

export const createReminder = createTool({
  id: 'createReminder',
  description: 'Save a reminder with the explicitly requested date and time in the current Cowork workspace.',
  inputSchema: z.object({
    text: z.string().trim().min(1).max(4000),
    due: z.iso.datetime({ offset: true }).describe('Future RFC 3339 timestamp including seconds and the UTC offset for the requested local time'),
  }),
  outputSchema: outcome,
  execute: async (input, context) => {
    if (Date.parse(input.due) <= Date.now()) return { error: 'Choose a future date and time.' };
    const write = context?.requestContext?.get('workspaceWrite');
    if (typeof write !== 'function') return unavailable;
    return (write as WorkspaceWrite)('reminder', { Text: input.text, Due: input.due });
  },
});
