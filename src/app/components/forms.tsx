'use client';

import { Button } from './button';
import { Input } from './input';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ClipboardDocumentListIcon, CodeBracketIcon, MegaphoneIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import { AccountAccess, AccountModeSwitch, type AccountMode } from './account-access';
import styles from './account-access.module.css';

const roles = [
  { name: 'Developer', detail: 'Plans, previews, and screenshots', icon: CodeBracketIcon },
  { name: 'Product Manager', detail: 'Briefs, priorities, and next steps', icon: ClipboardDocumentListIcon },
  { name: 'Sales Lead', detail: 'Prospect research and follow-ups', icon: UserGroupIcon },
  { name: 'Social Media', detail: 'Content ideas and review reminders', icon: MegaphoneIcon },
] as const;

type Details = { Name?: FormDataEntryValue; Email?: FormDataEntryValue; Password?: FormDataEntryValue; Invite?: FormDataEntryValue };

export function AuthForm({ submit, busy, notice, clearNotice, initialMode = 'login' }: {
  submit: (mode: AccountMode, values: object) => void;
  busy: boolean;
  notice: string;
  clearNotice: () => void;
  initialMode?: AccountMode;
}) {
  const [mode, setMode] = useState(initialMode);
  const [step, setStep] = useState<'details' | 'agent'>('details');
  const [details, setDetails] = useState<Details>({});
  const [role, setRole] = useState<(typeof roles)[number]['name']>('Developer');
  const [joining, setJoining] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusHeading = useRef(false);
  const signup = mode === 'signup';
  const choosing = signup && step === 'agent';

  useEffect(() => {
    if (focusHeading.current) heading.current?.focus();
    focusHeading.current = false;
  }, [mode, step, joining]);

  function changeMode() {
    clearNotice();
    focusHeading.current = true;
    setMode(signup ? 'login' : 'signup');
    setStep('details');
    setDetails({});
    setJoining(false);
  }

  return <AccountAccess>
    <form className={`${styles.card} ${styles.form}`} key={mode + step} onSubmit={(event) => {
      event.preventDefault();
      if (choosing) { submit(mode, { ...details, Role: role }); return; }
      const values = Object.fromEntries(new FormData(event.currentTarget));
      if (!signup || joining) { submit(mode, values); return; }
      setDetails(values);
      focusHeading.current = true;
      setStep('agent');
    }}>
      <header className={styles.heading}>
        {signup && !joining && <p className={styles.progress}>{choosing ? 'Step 2 of 2' : 'Step 1 of 2'}</p>}
        <h1 className={styles.title} ref={heading} tabIndex={-1}>{choosing ? 'Choose your agent' : signup ? (joining ? 'Join your workspace' : 'Create your account') : 'Sign in to Cowork'}</h1>
        <p>{choosing ? 'Pick a role that matches the work you want to delegate.' : signup ? (joining ? 'Use the invite code your teammate shared.' : 'Start with your details to set up a workspace.') : 'Use your account to open your conversations.'}</p>
      </header>
      {notice && <p className={styles.notice} role="alert">{notice}</p>}
      {choosing ? <>
        <fieldset className="onboarding-roles" disabled={busy}>
          <legend className="sr-only">Choose an agent</legend>
          {roles.map(({ name, detail, icon: Icon }) => (
            <label key={name} className="onboarding-role">
              <Icon aria-hidden="true" className="size-5" />
              <span><strong>{name}</strong><small>{detail}</small></span>
              <input type="radio" name="Role" value={name} checked={role === name} onChange={() => setRole(name)} />
            </label>
          ))}
        </fieldset>
        <Button className={styles.primary} type="submit" disabled={busy}>{busy ? 'Creating workspace…' : 'Create workspace'}</Button>
        <button type="button" className={styles.textButton} onClick={() => {
          clearNotice();
          focusHeading.current = true;
          setStep('details');
        }} disabled={busy}>Back to your details</button>
      </> : <>
        {signup && <label>Your name<Input className={styles.field} name="Name" autoComplete="name" maxLength={80} defaultValue={String(details.Name ?? '')} required /></label>}
        <label>Email<Input className={styles.field} name="Email" type="email" autoComplete="email" maxLength={254} defaultValue={String(details.Email ?? '')} required /></label>
        <label>Password<Input className={styles.field} name="Password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={8} maxLength={128} defaultValue={String(details.Password ?? '')} required /></label>
        {signup && joining && <label>Workspace invite code<Input className={styles.field} name="Invite" autoComplete="off" required /></label>}
        <Button className={styles.primary} type="submit" disabled={busy}>{busy ? 'Please wait…' : signup ? (joining ? 'Join workspace' : 'Continue') : 'Sign in'}</Button>
        {signup && <button type="button" className={styles.textButton} onClick={() => {
          clearNotice();
          focusHeading.current = true;
          setJoining(!joining);
        }} disabled={busy}>{joining ? 'Create a workspace instead' : 'I have a workspace invite'}</button>}
      </>}
    </form>
    <AccountModeSwitch signup={signup} disabled={busy} onSwitch={changeMode} />
  </AccountAccess>;
}

export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  return <Dialog open onClose={close} className="fixed inset-0 z-[60] grid place-items-center p-4">
    <DialogBackdrop className="fixed inset-0 bg-gray-900/70" />
    <DialogPanel className="panel relative max-h-[90dvh] w-full max-w-lg overflow-y-auto p-5">
      <div className="dialog-heading mb-4"><DialogTitle>{title}</DialogTitle><Button type="button" variant="quiet" onClick={close}>Close</Button></div>
      {children}
    </DialogPanel>
  </Dialog>;
}
