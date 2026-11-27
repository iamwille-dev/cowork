import { channelAgents } from '../../channel-agents';
import developer from '../assets/agents/developer.webp';
import productManager from '../assets/agents/product-manager.webp';
import salesLead from '../assets/agents/sales-lead.webp';
import socialMedia from '../assets/agents/social-media.webp';

export const agentProfiles = [
  {
    ...channelAgents.ada,
    tone: 'blue',
    portrait: developer,
    personality: 'Methodical',
    description: 'Plan and implement software changes. For a UI build, review the implementation plan, preview, and screenshot in Tasks.',
    example: 'Build a preview from this UI brief.',
  },
  {
    name: 'Ravi',
    role: 'Product Manager',
    tone: 'stone',
    portrait: productManager,
    personality: 'Organized',
    description: 'Turn customer feedback into priorities, draft product briefs, and define what a release needs to accomplish.',
    example: 'Turn this feedback into release priorities.',
  },
  {
    ...channelAgents.sam,
    tone: 'green',
    portrait: salesLead,
    personality: 'Curious',
    description: 'Research prospects, qualify opportunities, and draft follow-ups that reflect the conversation so far.',
    example: 'Research this prospect and draft a follow-up.',
  },
  {
    name: 'Sofia',
    role: 'Social Media',
    tone: 'amber',
    portrait: socialMedia,
    personality: 'Creative',
    description: 'Plan a content calendar and draft posts tailored to the platforms where your team publishes.',
    example: 'Draft a week of posts for our launch.',
  },
] as const;
