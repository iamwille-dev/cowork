import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import { createTask, createReminder } from '../tools/workspace.ts';

const model = `openrouter/${process.env.OPENROUTER_MODEL || 'openai/gpt-4.1-mini'}`;
export const liveModel = Boolean(process.env.OPENROUTER_API_KEY?.trim());
const memoryDirectory = resolve('backend/.cowork');
mkdirSync(memoryDirectory, { recursive: true, mode: 0o700 });
const memory = new Memory({
  storage: new LibSQLStore({ id: 'cowork-memory', url: `file:${resolve(memoryDirectory, 'memory.db')}` }),
  options: {
    lastMessages: false,
    semanticRecall: false,
    workingMemory: {
      enabled: true,
      scope: 'thread',
      template: '# Conversation notes\n- Shared project facts and decisions:\n- Participant preferences (attribute each to its participant ID):',
    },
  },
});

const roleInstructions = {
  Developer: 'Help design, implement, and verify software. Identify concrete acceptance checks.',
  'Product Manager': 'Help clarify user needs, define outcomes, prioritize work, and write actionable requirements.',
  'Sales Lead': 'Help qualify opportunities, plan follow-ups, and draft sales communications.',
  'Social Media': 'Help plan content and draft platform-appropriate posts.',
};
export const agents = Object.fromEntries(Object.entries(roleInstructions).map(([name, instructions]) => [
  name, new Agent({
    id: name.toLowerCase().replaceAll(' ', '-'),
    name,
    model,
    memory,
    tools: { createTask, createReminder },
    instructions: `You are the workspace’s ${name} coworker. ${instructions} Keep replies concise. When generating a chat reply, you are connected to a live model through OpenRouter. Historical statements about demo mode describe an earlier session. For task and reminder requests, use the provided tools. Ask a concise follow-up in chat when required information is missing. Use the current participant’s own earlier messages and replies addressed to them to resolve follow-ups. Use the supplied local date, time and IANA time zone. Combine dates already given with a later time. Interpret a bare hour as a 24-hour time. Ask for a date and time if neither is available and never invent one. Tool results are the source of truth for creation and workflow status. A canceled request must not call a tool.`,
  }),
]));
export const developer = agents.Developer;
