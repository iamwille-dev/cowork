import { Mastra } from '@mastra/core';
import { agents } from './agents/index.ts';
import { agentRequestClassifier } from './classifiers/agent-request.ts';
import { developerWorkflow } from './workflows/developer.ts';

export const mastra = new Mastra({
  agents,
  classifiers: { agentRequest: agentRequestClassifier },
  server: { host: "127.0.0.1" },
  workflows: { developerTask: developerWorkflow },
});
