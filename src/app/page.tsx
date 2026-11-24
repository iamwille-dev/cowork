import Link from 'next/link';

const roles = [
  { name: 'Developer', initial: 'D', color: 'coral', task: 'Build a launch preview', detail: 'Turn a UI brief into an implementation plan, a testable preview, and a screenshot.' },
  { name: 'Product Manager', initial: 'P', color: 'lilac', task: 'Draft the release brief', detail: 'Clarify outcomes, prioritize next steps, and turn decisions into tasks.' },
  { name: 'Sales Lead', initial: 'S', color: 'blue', task: 'Plan a prospect follow-up', detail: 'Talk through an opportunity and save the follow-up while the context is fresh.' },
  { name: 'Social Media', initial: 'M', color: 'green', task: 'Outline next week’s posts', detail: 'Draft content ideas and schedule reminders to review them with the team.' },
];

export default function Home() {
  return (
    <main className="landing">
      <header className="landing-header landing-wrap">
        <Link href="/" className="landing-brand"><span aria-hidden="true">✳</span> cowork<span className="landing-period">.</span></Link>
        <nav aria-label="Main navigation"><a href="#roles">Agent roles</a><a href="#workflow">How it works</a></nav>
        <Link href="/conversations" className="landing-small-link">Open workspace</Link>
      </header>

      <section className="landing-hero landing-wrap" aria-labelledby="landing-heading">
        <div className="landing-hero-copy">
          <h1 id="landing-heading">Good work<br />has <em>company.</em></h1>
          <p>Give your team an AI coworker that can share a conversation, take on a task, and remember what comes next.</p>
          <Link href="/conversations?signup=1" className="landing-cta">Get started</Link>
        </div>
        <div className="landing-role-scene" aria-label="Four Cowork agent roles">
          {roles.map((role) => (
            <a href="#roles" className={`landing-role-card ${role.color}`} key={role.name}>
              <span className="landing-role-initial" aria-hidden="true">{role.initial}</span>
              <strong>{role.name}</strong>
              <span>{role.task}</span>
            </a>
          ))}
        </div>
      </section>

      <section className="landing-section landing-wrap" id="roles">
        <h2>Choose your coworker.</h2>
        <div className="landing-roles">
          {roles.map(({ name, detail, color, initial }) => (
            <article key={name} className={color}>
              <span className="landing-feature-initial" aria-hidden="true">{initial}</span>
              <h3>{name}</h3><p>{detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="landing-section landing-workflow landing-wrap" id="workflow">
        <div>
          <h2>From “could you?”<br />to ready for review.</h2>
          <p>Ask for work in a shared conversation. Cowork asks for missing details, saves what you assign, and gives teammates a place to follow along.</p>
          <Link href="/conversations" className="landing-cta">Open workspace</Link>
        </div>
        <div className="landing-thread" aria-label="Example Developer conversation">
          <div className="landing-thread-heading"><strong>Developer conversation</strong><small>Example</small></div>
          <div className="landing-thread-message user">Create a task to build a launch page.</div>
          <div className="landing-thread-message"><strong>Developer agent</strong><p>The launch page is ready for review.</p>
            <div className="landing-artifacts"><span>Implementation plan</span><span>Sandbox preview</span><span>UI screenshot</span></div>
          </div>
        </div>
      </section>

      <footer className="landing-footer landing-wrap">
        <Link href="/" className="landing-brand"><span aria-hidden="true">✳</span> cowork<span className="landing-period">.</span></Link>
        <Link href="/conversations">Open workspace</Link>
      </footer>
    </main>
  );
}
