import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import {
  ArrowRightIcon, ChatBubbleLeftRightIcon, CodeBracketIcon, CommandLineIcon,
  EnvelopeIcon, LinkIcon, UserGroupIcon,
} from '@heroicons/react/24/outline';
import { LandingFooter, LandingHeader } from '../components/landing-navigation';
import { agentProfiles } from '../lib/agent-profiles';
import styles from './how-it-works.module.css';

export const metadata: Metadata = {
  title: 'How it works | Cowork',
  description: 'See how to set up a Cowork workspace, connect your tools, and choose the AI agents that fit your team’s work.',
};

const setupSteps = [
  {
    title: 'Choose your agents',
    description: 'After signing up, pick one or more roles and give each agent a name. Joining a teammate’s workspace? Use their invite code.',
    icon: UserGroupIcon,
  },
  {
    title: 'Connect tools',
    description: 'Connect the accounts your agents need and choose which agents can use each one. You can finish setup and connect tools later.',
    icon: LinkIcon,
  },
  {
    title: 'Choose where to chat',
    description: 'Start in Cowork with any role. For Developer and Sales Lead, you can also install the Slack app or connect a Telegram bot to a group.',
    icon: ChatBubbleLeftRightIcon,
  },
];

const connections = [
  {
    name: 'GitHub',
    description: 'Choose which repositories the GitHub App can access so agents can look up issues and repository details.',
    icon: CodeBracketIcon,
  },
  {
    name: 'Gmail',
    description: 'Give selected agents read access to a mailbox so they can search for and read relevant messages.',
    icon: EnvelopeIcon,
  },
  {
    name: 'SSH',
    description: 'Add a host in Settings and grant access to the agents that need to work in that environment.',
    icon: CommandLineIcon,
  },
];

export default function HowItWorksPage() {
  return <div className="landing">
    <LandingHeader currentPage="how-it-works" />

    <main>
      <section className="landing-hero landing-wrap" aria-labelledby="how-it-works-heading">
        <div>
          <h1 id="how-it-works-heading">How Cowork works.</h1>
          <div className="landing-hero-intro">
            <p>Pick the AI coworkers your team needs, give them access to the right tools, and start a conversation.</p>
            <div className="landing-actions">
              <Link href="/conversations?signup=1" className="landing-cta">Get started <ArrowRightIcon aria-hidden="true" /></Link>
              <a href="#agents" className="landing-text-link">Compare agent roles</a>
            </div>
          </div>
        </div>

        <section className={styles.setup} aria-labelledby="setup-heading">
          <h2 id="setup-heading">Set up your workspace</h2>
          <ol className={styles.steps} role="list">
            {setupSteps.map(({ title, description, icon: Icon }) => <li key={title}>
              <Icon aria-hidden="true" />
              <div><h3>{title}</h3><p>{description}</p></div>
            </li>)}
          </ol>
        </section>
      </section>

      <section className="landing-section landing-wrap" aria-labelledby="connections-heading">
        <div className="landing-workflow">
          <div>
            <h2 id="connections-heading">Agent Connections</h2>
            <p>The workspace owner can connect accounts and grant access to individual agents. You can update access or use an existing connection key under <strong>Settings → Agent Connections</strong>.</p>
            <p>Use connected apps in Cowork conversations without guest access. Eligible Slack and Telegram chats can use read-only GitHub tools with a GitHub grant.</p>
          </div>
          <dl className={styles.connections}>
            {connections.map(({ name, description, icon: Icon }) => <div key={name}>
              <dt><Icon aria-hidden="true" />{name}</dt>
              <dd>{description}</dd>
            </div>)}
          </dl>
        </div>
      </section>

      <section className={`landing-section landing-wrap ${styles.agents}`} id="agents" aria-labelledby="agents-heading">
        <h2 id="agents-heading">Meet the agents</h2>
        <p>Every role can chat in Cowork. Pick a specialist based on what you want help with.</p>
        <ul className={styles.profiles} role="list">
          {agentProfiles.map(({ name, role, portrait, description, example }) => <li key={role}>
            <Image src={portrait} alt="" width={64} height={64} unoptimized />
            <div>
              <h3>{role}</h3>
              <p className={styles.agentName}>{name}</p>
              <p>{description}</p>
              <p className={styles.example}><q>{example}</q></p>
            </div>
          </li>)}
        </ul>
      </section>
    </main>

    <LandingFooter currentPage="how-it-works" />
  </div>;
}
