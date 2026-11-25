import type { Metadata } from 'next';
import type { CSSProperties } from 'react';
import { ChatBubbleLeftRightIcon, ChevronDownIcon } from '@heroicons/react/24/outline';
import { LandingFooter, LandingHeader } from '../components/landing-navigation';
import styles from './faq.module.css';

export const metadata: Metadata = {
  title: 'Frequently asked questions | Cowork',
  description: 'Get answers about Cowork agents, tasks, reminders, guest invitations, and workspace memory.',
};

const questions = [
  {
    question: 'What is Cowork?',
    answer: 'Cowork is a shared workspace for your team and an AI coworker. You can talk in conversations, assign tasks, review the work your agent shares, and keep track of reminders in one place.',
  },
  {
    question: 'Which agent roles can I choose?',
    answer: 'Cowork has four roles: Developer, Product Manager, Sales Lead, and Social Media. Each role has its own chat agent. The Developer can also run a task workflow that produces artifacts for your team to review.',
  },
  {
    question: 'How do I assign a task?',
    answer: 'Ask in a signed-in conversation. Try “Create a task to draft the launch page.” Cowork asks for any missing details. Open Tasks to track the assignment and review any results.',
  },
  {
    question: 'Can Cowork run work on a schedule?',
    answer: 'Yes. In a signed-in conversation, ask for a one-time or recurring run, such as “Every Monday at 9 am, draft a planning agenda from this brief.” Open Tasks to see upcoming runs and past results.',
  },
  {
    question: 'How do reminders work?',
    answer: 'Ask the agent to remind you about a specific action at a particular time. Try “Remind me to review the launch tomorrow at 10 am.” You can view your reminders and mark them complete in the workspace.',
  },
  {
    question: 'Can I invite someone outside my team?',
    answer: 'In a shareable conversation, choose Invite people, then By email. Guests can read the existing conversation and reply in that thread. The invitation and guest access expire seven days after the link is created.',
  },
  {
    question: 'What does my agent remember?',
    answer: 'You can ask your agent to remember project facts, decisions, and preferences for future conversations in the workspace. Guest conversations use their own conversation memory. You can also ask the agent to update or forget a saved detail.',
  },
];

function TypedAnswer({ answer }: { answer: string }) {
  const characters = Array.from(answer);
  return <p className={styles.answerText}>
    <span className="sr-only">{answer}</span>
    <span className={styles.typed} aria-hidden="true">
      {characters.map((character, index) => <span
        key={index}
        style={{ '--delay': `${index * 6}ms` } as CSSProperties}
      >{character}</span>)}
    </span>
  </p>;
}

export default function FaqPage() {
  return <div className={`landing ${styles.page}`}>
    <LandingHeader isFaq />
    <main className={`landing-wrap ${styles.main}`}>
      <div className={styles.intro}>
        <h1>Frequently asked<br className={styles.titleBreak} /> questions.</h1>
        <p>Pick a question to see the answer typed out.</p>
      </div>

      <div className={styles.faq}>
        <section className={styles.questions} aria-labelledby="faq-questions">
          <h2 id="faq-questions">Questions</h2>
          {questions.map(({ question, answer }) => <details key={question} name="cowork-faq" className={styles.item}>
            <summary>{question}<ChevronDownIcon aria-hidden="true" /></summary>
            <div className={styles.answer}>
              <div className={styles.sheet}>
                <h3>{question}</h3>
                <TypedAnswer answer={answer} />
              </div>
            </div>
          </details>)}
        </section>
        <div className={styles.stage} aria-hidden="true">
          <div className={`${styles.sheet} ${styles.idle}`}>
            <ChatBubbleLeftRightIcon />
            <p>Select a question to get started.</p>
          </div>
        </div>
      </div>
    </main>
    <LandingFooter isFaq />
  </div>;
}
