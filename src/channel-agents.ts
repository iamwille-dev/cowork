export const channelAgents = {
  ada: { name: 'Ada', role: 'Developer' },
  sam: { name: 'Sam', role: 'Sales Lead' },
} as const;

export type ChannelAgent = keyof typeof channelAgents;
export const channelAgentIds = Object.keys(channelAgents) as ChannelAgent[];

export function roleAgentId(role: string) {
  return role.toLowerCase().replaceAll(' ', '-');
}
