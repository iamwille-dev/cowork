import Link from 'next/link';
import { LandingFooter, LandingHeader } from './components/landing-navigation';
import {
  ArrowRightIcon, BellIcon, CalendarIcon, ChatBubbleLeftRightIcon, ClipboardDocumentListIcon,
  CodeBracketIcon, DocumentTextIcon, FolderIcon, MegaphoneIcon, PhotoIcon, RectangleGroupIcon,
  SparklesIcon, UserGroupIcon,
} from '@heroicons/react/24/outline';

const roles = [
  { name: 'Developer', icon: CodeBracketIcon, detail: 'Turn a UI brief into an implementation plan, a testable preview, and a screenshot.' },
  { name: 'Product Manager', icon: ClipboardDocumentListIcon, detail: 'Clarify outcomes, prioritize next steps, and turn decisions into tasks.' },
  { name: 'Sales Lead', icon: UserGroupIcon, detail: 'Talk through an opportunity and save the follow-up while the context is fresh.' },
  { name: 'Social Media', icon: MegaphoneIcon, detail: 'Draft content ideas and schedule reminders to review them with the team.' },
];

const previewNavigation = [
  { name: 'Conversations', icon: ChatBubbleLeftRightIcon },
  { name: 'Tasks', icon: FolderIcon },
  { name: 'Reminders', icon: CalendarIcon },
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
      <div className="preview-thread">
        <div className="preview-heading">
          <strong id="preview-title">Launch page</strong><span>Example conversation</span>
        </div>
        <div className="preview-messages">
          <p className="preview-request">Create a task to build a launch page.</p>
          <div className="preview-reply">
            <span className="brand-mark"><SparklesIcon aria-hidden="true" /></span>
            <div><strong>Developer agent</strong><p>The launch page is ready for review.</p></div>
          </div>
          <ul className="preview-artifacts">
            {artifacts.map(({ name, icon: Icon }) => <li key={name}><Icon aria-hidden="true" />{name}</li>)}
          </ul>
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
        <p>Give your team an AI coworker that can share a conversation, take on a task, and remember what comes next.</p>
        <div className="landing-actions">
          <Link href="/conversations?signup=1" className="landing-cta">Get started <ArrowRightIcon aria-hidden="true" /></Link>
          <a href="#workflow" className="landing-text-link">See how it works</a>
        </div>
      </div>
      <WorkspacePreview />
    </section>

    <section className="landing-section landing-wrap" id="roles">
      <h2>Choose your coworker.</h2>
      <div className="landing-roles">
        {roles.map(({ name, detail, icon: Icon }) => <article key={name}>
          <span className="landing-role-icon"><Icon aria-hidden="true" /></span>
          <h3>{name}</h3><p>{detail}</p>
        </article>)}
      </div>
    </section>

    <section className="landing-section landing-wrap landing-workflow" id="workflow">
      <div>
        <h2>From “could you?” to ready for review.</h2>
        <p>Ask for work in a shared conversation. Cowork asks for missing details, saves what you assign, and gives teammates a place to follow along.</p>
        <Link href="/conversations" className="landing-cta">Open workspace <ArrowRightIcon aria-hidden="true" /></Link>
      </div>
      <ol className="landing-steps">
        <li><ChatBubbleLeftRightIcon aria-hidden="true" /><div><strong>Start a conversation</strong><p>Bring your teammates and agent into the same thread.</p></div></li>
        <li><FolderIcon aria-hidden="true" /><div><strong>Assign a task</strong><p>Track progress and review the artifacts your agent shares.</p></div></li>
        <li><BellIcon aria-hidden="true" /><div><strong>Set a reminder</strong><p>Keep the next step on your calendar.</p></div></li>
      </ol>
    </section>

    <LandingFooter />
  </main>;
}
