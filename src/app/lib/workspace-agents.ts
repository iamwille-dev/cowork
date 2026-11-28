import { ChatBubbleLeftRightIcon, CodeBracketIcon, MegaphoneIcon, UserGroupIcon } from '@heroicons/react/24/outline';

export const agentCatalog = [
  { id: 'developer', role: 'Developer', description: 'Plan changes, work with your repositories, and build previews for review.', icon: CodeBracketIcon, messaging: 'ada' },
  { id: 'product-manager', role: 'Product Manager', description: 'Turn feedback into priorities, draft briefs, and plan releases.', icon: ChatBubbleLeftRightIcon },
  { id: 'sales-lead', role: 'Sales Lead', description: 'Research prospects, write follow-ups, and keep track of opportunities.', icon: UserGroupIcon, messaging: 'sam' },
  { id: 'social-media', role: 'Social Media', description: 'Plan posts, draft copy, and coordinate the publishing calendar.', icon: MegaphoneIcon },
] as const;

export type AgentChannel = 'cowork' | 'slack' | 'telegram';
export type WorkspaceAgent = { ID: string; Role: string; Name: string; Channel?: AgentChannel; ConnectionIDs?: string[] };
export type AgentSetup = { ID: (typeof agentCatalog)[number]['id']; Name: string; Channel: AgentChannel };
export type AgentUpdate = { ID: string; Name?: string; Channel?: AgentChannel };
export type AgentMemory = { Revision: string; Items: string[] };
export type AgentMemoryUpdate = AgentMemory & { ID: string };
