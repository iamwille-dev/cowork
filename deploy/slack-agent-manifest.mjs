import { readFile } from 'node:fs/promises';
import { channelAgents, roleAgentId } from '../src/mastra/channels/agents.ts';

const agent = process.argv[2];
const origin = URL.parse(process.argv[3] ?? 'https://cowork.iamwille.xyz');
if (!agent || !Object.hasOwn(channelAgents, agent) || origin?.protocol !== 'https:' || origin.username || origin.password) {
  console.error('Usage: node deploy/slack-agent-manifest.mjs ada|sam [https://your-cowork-origin]');
  process.exit(1);
}

const { name, role } = channelAgents[agent];
const manifest = JSON.parse(await readFile(new URL('./slack-app-manifest.json', import.meta.url), 'utf8'));
const base = origin.origin + '/integrations/slack/' + agent;
manifest.display_information = { name, description: `Chat with ${name}, your Cowork ${role} agent.` };
manifest.features.bot_user.display_name = name;
manifest.oauth_config.redirect_urls = [base + '/oauth/callback'];
manifest.settings.event_subscriptions.request_url = `${origin.origin}/api/agents/${roleAgentId(role)}/channels/slack/webhook`;
console.log(JSON.stringify(manifest, null, 2));
