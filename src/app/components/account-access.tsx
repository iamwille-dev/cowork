import { useId, type ReactNode } from 'react';
import Image from 'next/image';
import {
  ChatBubbleLeftRightIcon, CheckCircleIcon, DocumentTextIcon, FolderIcon, RectangleGroupIcon,
} from '@heroicons/react/24/outline';
import developer from '../assets/agents/developer.webp';
import styles from './account-access.module.css';

export type AccountMode = 'login' | 'signup';

export function AccountAccess({ children }: { children: ReactNode }) {
  const previewTitle = useId();

  return <section className={styles.layout}>
    <div className={styles.formColumn}>{children}</div>
    <aside className={styles.previewStage} aria-labelledby={previewTitle}>
      <div className={styles.preview}>
        <header className={styles.previewHeader}>
          <div>
            <h2 id={previewTitle}>Launch page</h2>
            <p>Example workspace</p>
          </div>
          <span className={styles.review}><CheckCircleIcon aria-hidden="true" /> Ready for review</span>
        </header>
        <div className={styles.previewBody}>
          <section className={styles.conversation}>
            <h3><ChatBubbleLeftRightIcon aria-hidden="true" /> Conversation</h3>
            <p className={styles.request}>Create a task to build a launch page.</p>
            <div className={styles.reply}>
              <Image src={developer} width={30} height={30} alt="" unoptimized />
              <div><strong>Developer agent</strong><p>The launch page is ready for review.</p></div>
            </div>
          </section>
          <section className={styles.artifacts}>
            <h3><FolderIcon aria-hidden="true" /> Task artifacts</h3>
            <ul role="list">
              <li><DocumentTextIcon aria-hidden="true" /> Implementation plan</li>
              <li><RectangleGroupIcon aria-hidden="true" /> Sandbox preview</li>
            </ul>
          </section>
        </div>
      </div>
    </aside>
  </section>;
}

export function AccountModeSwitch({ signup, disabled, onSwitch }: {
  signup: boolean;
  disabled?: boolean;
  onSwitch: () => void;
}) {
  return <p className={styles.switch}>
    {signup ? 'Already have an account?' : 'New to Cowork?'}{' '}
    <button type="button" className={styles.textButton} disabled={disabled} onClick={onSwitch}>
      {signup ? 'Sign in' : 'Create account'}
    </button>
  </p>;
}
