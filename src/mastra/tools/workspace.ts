import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { taskStatuses } from '../../task-status.ts';

type RecordResult = { id: string; status?: string; due?: string; error?: string };
export type WorkspaceWrite = (route: 'task' | 'task/schedule' | 'task/update' | 'reminder', data: Record<string, unknown>) => Promise<RecordResult>;
type TaskMatch = { ID: string; Title: string; Status: string; Author: string };
export type WorkspaceFindTasks = (query: string) => Promise<{ tasks?: TaskMatch[]; more?: boolean; error?: string }>;

const outcome = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  due: z.string().optional(),
  error: z.string().optional(),
});
const unavailable = { error: 'Creating workspace items requires a signed-in Cowork conversation.' };
const boardUnavailable = { error: 'The task board requires a signed-in Cowork conversation.' };

export const findTasks = createTool({
  id: 'findTasks',
  description: 'Find tasks in the current workspace by title or exact ID. Use this to identify one task and read its current status before updating it. Pass an empty query to list recent tasks.',
  inputSchema: z.object({ query: z.string().trim().max(120) }),
  outputSchema: z.object({
    tasks: z.array(z.object({ ID: z.string(), Title: z.string(), Status: z.string(), Author: z.string() })).optional(),
    more: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ query }, context) => {
    const find = context?.requestContext?.get('workspaceFindTasks');
    return typeof find === 'function' ? (find as WorkspaceFindTasks)(query) : boardUnavailable;
  },
});

export const updateTask = createTool({
  id: 'updateTask',
  description: 'Edit a Cowork task’s title or brief, or move it to a board column. Only call on explicit participant request after finding one matching task with findTasks. Assigned means Planned and Completed means Done.',
  inputSchema: z.object({
    id: z.string().min(1),
    expectedStatus: z.string().min(1).describe('The current status returned by findTasks'),
    status: z.enum(taskStatuses).optional(),
    title: z.string().trim().min(1).max(120).optional(),
    brief: z.string().trim().min(1).max(6000).optional(),
  }),
  outputSchema: outcome,
  execute: async (input, context) => {
    const write = context?.requestContext?.get('workspaceWrite');
    if (typeof write !== 'function') return boardUnavailable;
    return (write as WorkspaceWrite)('task/update', {
      ID: input.id, ExpectedStatus: input.expectedStatus, Status: input.status, Title: input.title, Brief: input.brief,
    });
  },
});

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

export const scheduleTask = createTool({
  id: 'scheduleTask',
  description: 'Wake the workspace agent once or on a daily or weekly schedule to complete a self-contained task and save each written result. Use this for delayed work such as drafting or summarizing supplied material. Scheduled runs have no connected apps or workspace tools.',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(120),
    brief: z.string().trim().min(1).max(6000).describe('The full task and any user-provided material needed to perform it later'),
    timeZone: z.string().trim().min(1).max(100).optional().describe('IANA time zone specified by the participant for a schedule, such as America/Regina. It determines the local hour of recurring runs.'),
    when: z.union([
      z.object({
        due: z.iso.datetime({ offset: true }).describe('First future run as an RFC 3339 timestamp with the requested local UTC offset'),
        recurrence: z.enum(['daily', 'weekly']).optional().describe('Omit for a one-time run. Weekly repeats on the weekday of the first run.'),
      }),
      z.object({ delaySeconds: z.number().int().min(1).max(31_536_000).describe('Number of seconds from scheduling until the agent should run') }),
    ]),
  }),
  outputSchema: outcome,
  execute: async (input, context) => {
    const write = context?.requestContext?.get('workspaceWrite');
    if (typeof write !== 'function') return unavailable;
    return (write as WorkspaceWrite)('task/schedule', {
      Title: input.title, Brief: input.brief,
      ...(input.timeZone && { TimeZone: input.timeZone }),
      ...('due' in input.when ? { Due: input.when.due, Recurrence: input.when.recurrence } : { DelaySeconds: input.when.delaySeconds }),
    });
  },
});
