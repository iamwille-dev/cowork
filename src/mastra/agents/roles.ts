export const roleScopes = {
  Developer: 'Design, implement, review, debug, explain, or test code and software. Handle technical architecture, commands, APIs, repositories, deployments, and building interfaces or integrations.',
  'Product Manager': 'Clarify user needs, turn feedback into requirements and acceptance criteria, prioritize the roadmap, and plan releases. Own product decisions and requirements for software features.',
  'Sales Lead': 'Research prospects, qualify opportunities, work with sales leads and accounts, plan follow-ups, and draft sales outreach or replies.',
  'Social Media Manager': 'Plan public social media content, draft or revise posts and captions, and coordinate publishing calendars and social campaigns.',
} as const;

export type Role = keyof typeof roleScopes;

export function workspaceAgentRole(role: string) {
  // Preserve the role key stored by Encore while the agent displays its current name.
  return /^Social Media(?: Manager)?$/i.test(role) ? 'Social Media' : role;
}
