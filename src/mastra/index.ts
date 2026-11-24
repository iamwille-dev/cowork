import { Mastra } from '@mastra/core';
import { agents } from './agents/index.ts';
import { developerWorkflow } from './workflows/developer.ts';

export const mastra = new Mastra({
  agents,
  server: { host: "127.0.0.1" },
  workflows: { developerTask: developerWorkflow },
});
