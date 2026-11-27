import Link from 'next/link';
import { AgentBadges } from './components/agent-badges';
import { LandingFooter, LandingHeader } from './components/landing-navigation';
import {
  ArrowRightIcon, BellIcon, CalendarIcon, CheckCircleIcon, ChatBubbleLeftRightIcon,
  DocumentTextIcon, FolderIcon, PhotoIcon, RectangleGroupIcon, SparklesIcon, Cog6ToothIcon,
} from '@heroicons/react/24/outline';

const previewNavigation = [
  { name: 'Conversations', icon: ChatBubbleLeftRightIcon },
  { name: 'Tasks', icon: FolderIcon },
  { name: 'Reminders', icon: CalendarIcon },
  { name: 'Settings', icon: Cog6ToothIcon },
];

const artifacts = [
  { name: 'Implementation plan', icon: DocumentTextIcon },
  { name: 'Sandbox preview', icon: RectangleGroupIcon },
  { name: 'UI screenshot', icon: PhotoIcon },
];

function WorkspacePreview() {
  return <div className="landing-stage" role="group" aria-labelledby="preview-title">
    <div className="landing-preview">
      <div className="preview-sidebar">
        <div className="preview-brand"><span className="brand-mark"><SparklesIcon aria-hidden="true" /></span> Cowork</div>
        <ul>
          {previewNavigation.map(({ name, icon: Icon }) => <li key={name}><Icon aria-hidden="true" />{name}</li>)}
        </ul>
      </div>
      <div className="preview-workspace">
        <div className="preview-heading">
          <div><h3 id="preview-title">Launch page</h3><p>Example workspace</p></div>
          <span className="preview-ready"><CheckCircleIcon className="size-3.5" aria-hidden="true" /> Ready for review</span>
        </div>
        <div className="preview-panels">
          <section className="preview-panel">
            <h4><ChatBubbleLeftRightIcon aria-hidden="true" /> Conversation</h4>
            <div className="preview-messages">
              <p className="preview-request">Create a task to build a launch page.</p>
              <div className="preview-reply">
                <span className="brand-mark"><SparklesIcon aria-hidden="true" /></span>
                <div><strong>Developer agent</strong><p>The launch page is ready for review.</p></div>
              </div>
            </div>
          </section>
          <div className="grid min-w-0 gap-3">
            <section className="preview-panel">
              <h4><FolderIcon aria-hidden="true" /> Task artifacts</h4>
              <ul className="preview-artifacts">
                {artifacts.map(({ name, icon: Icon }) => <li key={name}><Icon aria-hidden="true" />{name}</li>)}
              </ul>
            </section>
            <section className="preview-panel">
              <h4><BellIcon aria-hidden="true" /> Reminder</h4>
              <div className="px-3 py-2.5 text-sm">Review the launch page</div>
            </section>
          </div>
        </div>
      </div>
    </div>
  </div>;
}

export default function Home() {
  return <main className="landing">
    <LandingHeader />

    <section className="landing-hero landing-wrap" aria-labelledby="landing-heading">
      <div className="landing-hero-copy">
        <h1 id="landing-heading">Good work<br /> has <em>company.</em></h1>
        <div className="landing-hero-intro">
          <p>Give your team an AI coworker that can share a conversation, take on a task, and remember what comes next.</p>
          <div className="landing-actions">
            <Link href="/conversations?signup=1" className="landing-cta">Get started <ArrowRightIcon aria-hidden="true" /></Link>
            <Link href="/how-it-works" className="landing-text-link">See how it works</Link>
          </div>
        </div>
      </div>
      <AgentBadges />
    </section>

    <section className="landing-section landing-wrap" id="workflow" aria-labelledby="workflow-heading">
      <div className="landing-workflow">
        <div>
          <h2 id="workflow-heading">From “could you?” to ready for review.</h2>
          <p>Ask for work in a shared conversation. Cowork asks for missing details, saves what you assign, and gives teammates a place to follow along.</p>
          <Link href="/conversations" className="landing-cta">Open workspace <ArrowRightIcon aria-hidden="true" /></Link>
        </div>
        <ol className="landing-steps">
          <li><ChatBubbleLeftRightIcon aria-hidden="true" /><div><strong>Start a conversation</strong><p>Bring your teammates and agent into the same thread.</p></div></li>
          <li><FolderIcon aria-hidden="true" /><div><strong>Assign a task</strong><p>Track progress and review the artifacts your agent shares.</p></div></li>
          <li><BellIcon aria-hidden="true" /><div><strong>Set a reminder</strong><p>Keep the next step on your calendar.</p></div></li>
        </ol>
      </div>
      <WorkspacePreview />
    </section>

    <LandingFooter />
  </main>;
}
