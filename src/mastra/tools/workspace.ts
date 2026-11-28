import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { taskStatuses } from '../../task-status.ts';
import { taskPreviewUrl } from '../task-preview.ts';

type RecordResult = { id: string; status?: string; due?: string; error?: string; previewUrl?: string };
export type WorkspaceWrite = (route: 'task' | 'task/schedule' | 'task/update' | 'reminder', data: Record<string, unknown>) => Promise<RecordResult>;
type TaskMatch = { ID: string; Title: string; Status: string; Author: string; PreviewURL?: string };
export type WorkspaceFindTasks = (query: string) => Promise<{ tasks?: TaskMatch[]; more?: boolean; error?: string }>;

const outcome = z.object({
  id: z.string().optional(),
  status: z.string().optional(),
  due: z.string().optional(),
  error: z.string().optional(),
  previewUrl: z.string().optional(),
});
const unavailable = { error: 'Creating workspace items requires a signed-in Cowork conversation.' };
const boardUnavailable = { error: 'The task board requires a signed-in Cowork conversation.' };
const scheduleTimeZone = z.string().trim().min(1).max(100).optional().describe(
  'IANA time zone specified by the participant, such as America/Regina. It determines the local hour of recurring runs.',
);
const scheduledDate = z.object({
  due: z.iso.datetime({ offset: true }).describe('First future run as an RFC 3339 timestamp with the requested local UTC offset'),
  recurrence: z.enum(['daily', 'weekly']).optional().describe('Omit for a one-time run. Weekly repeats on the weekday of the first run.'),
});

export const findTasks = createTool({
  id: 'findTasks',
  description: 'Find tasks in the current workspace by title or exact ID. Results include the status and any sandbox preview URL. Use this to identify one task before updating it. Pass an empty query to list recent tasks.',
  inputSchema: z.object({ query: z.string().trim().max(120) }),
  outputSchema: z.object({
    tasks: z.array(z.object({ ID: z.string(), Title: z.string(), Status: z.string(), Author: z.string(), PreviewURL: z.string().optional() })).optional(),
    more: z.boolean().optional(),
    error: z.string().optional(),
  }),
  execute: async ({ query }, context) => {
    const find = context?.requestContext?.get('workspaceFindTasks');
    if (typeof find !== 'function') return boardUnavailable;
    const result = await (find as WorkspaceFindTasks)(query);
    if (!result.tasks) return result;
    return { ...result, tasks: result.tasks.map(({ PreviewURL, ...task }) => {
      const url = taskPreviewUrl(task, PreviewURL);
      return url ? { ...task, PreviewURL: url } : task;
    }) };
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
  description: 'Assign a task in the current Cowork workspace. The agent picks it up when available. Developer tasks use the workspace workflow. Other agents produce a written deliverable from the brief.',
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
  description: 'Schedule work once, daily, or weekly. For Developer implementation, identify any UI changes and the repository if supplied. Use scheduleGmailDigest for an explicitly requested future digest of unread Gmail when that tool is available.',
  inputSchema: z.object({
    title: z.string().trim().min(1).max(120),
    brief: z.string().trim().min(1).max(6000).describe('The full task and any user-provided material needed to perform it later'),
    repository: z.url({ protocol: /^https$/ }).max(500).optional().describe('Repository URL explicitly supplied by the user'),
    changesUI: z.boolean().optional().describe('Whether the task implements UI changes and needs a screenshot and sandbox preview'),
    timeZone: scheduleTimeZone,
    when: z.union([
      scheduledDate,
      z.object({ delaySeconds: z.number().int().min(1).max(31_536_000).describe('Number of seconds from scheduling until the agent should run') }),
    ]),
  }),
  outputSchema: outcome,
  execute: async (input, context) => {
    const write = context?.requestContext?.get('workspaceWrite');
    if (typeof write !== 'function') return unavailable;
    return (write as WorkspaceWrite)('task/schedule', {
      Title: input.title, Brief: input.brief,
      Repository: input.repository, UI: input.changesUI,
      ...(input.timeZone && { TimeZone: input.timeZone }),
      ...('due' in input.when ? { Due: input.when.due, Recurrence: input.when.recurrence } : { DelaySeconds: input.when.delaySeconds }),
    });
  },
});

export const scheduleGmailDigest = createTool({
  id: 'scheduleGmailDigest',
  description: 'Schedule a private digest of unread Gmail inbox messages once, daily, or weekly. Use only when the participant explicitly requests the schedule. Get the Gmail connection ID from list_connections. Ask which account to use if more than one Gmail account matches.',
  inputSchema: scheduledDate.extend({
    connectionId: z.string().min(1).max(80).describe('Gmail connection ID selected from list_connections'),
    timeZone: scheduleTimeZone,
  }),
  outputSchema: outcome,
  execute: async ({ connectionId, due, recurrence, timeZone }, context) => {
    const write = context?.requestContext?.get('workspaceWrite');
    if (typeof write !== 'function') return unavailable;
    return (write as WorkspaceWrite)('task/schedule', {
      Title: 'Unread Gmail digest', Brief: 'Summarize unread inbox messages, highlight actions, and flag any deadlines.',
      GmailConnectionID: connectionId, Due: due, Recurrence: recurrence, ...(timeZone && { TimeZone: timeZone }),
    });
  },
});

export const getCurrentDate = createTool({
  id: 'getCurrentDate',
  description: 'Get the current date and time.',
  outputSchema: z.object({
    currentDate: z.string().optional(),
    longDate: z.string().optional(),
  }),
  execute: async () => {
    const now = new Date();

    return {
      currentDate: now.toISOString(),
      longDate: new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      }).format(now),
    };
  },
});
