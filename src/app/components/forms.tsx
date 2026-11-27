'use client';

import { Button } from './button';
import { Input } from './input';
import { useState, type ReactNode } from 'react';
import { ChatBubbleLeftRightIcon, ClipboardDocumentListIcon, CodeBracketIcon, MegaphoneIcon, UserGroupIcon } from '@heroicons/react/24/outline';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

const roles = [
  { name: 'Developer', detail: 'Plans, previews, and screenshots', icon: CodeBracketIcon },
  { name: 'Product Manager', detail: 'Briefs, priorities, and next steps', icon: ClipboardDocumentListIcon },
  { name: 'Sales Lead', detail: 'Prospect research and follow-ups', icon: UserGroupIcon },
  { name: 'Social Media', detail: 'Content ideas and review reminders', icon: MegaphoneIcon },
] as const;

type Details = { Name?: FormDataEntryValue; Email?: FormDataEntryValue; Password?: FormDataEntryValue; Invite?: FormDataEntryValue };

export function AuthForm({ submit, busy, initialMode = 'login' }: {
  submit: (mode: string, values: object) => void; busy: boolean; initialMode?: 'signup' | 'login';
}) {
  const [mode, setMode] = useState<string>(initialMode);
  const [step, setStep] = useState<'details' | 'agent'>('details');
  const [details, setDetails] = useState<Details>({});
  const [role, setRole] = useState<(typeof roles)[number]['name']>('Developer');
  const [joining, setJoining] = useState(false);
  const signup = mode === 'signup';
  const choosing = signup && step === 'agent';

  function changeMode(next: string) {
    setMode(next);
    setStep('details');
    setDetails({});
    setJoining(false);
  }

  return <section className={signup ? "onboarding" : "onboarding sign-in-gate"}>
    <div className="onboarding-story">
      <div>
        {signup ? <>
          <h1>Good work<br /> has <em>company.</em></h1>
          <p>Give your team a shared place to talk with an AI coworker, delegate work, and keep track of what comes next.</p>
        </> : <>
          <h1>Pick up where<br /> you <em>left off.</em></h1>
          <p>Your threads, teammates, and agent are all in your workspace.</p>
        </>}
      </div>
      <div className="onboarding-preview">
        <span className="onboarding-preview-icon" aria-hidden="true"><ChatBubbleLeftRightIcon className="size-5" /></span>
        <div><strong>One conversation, shared by the team</strong><small>Ask questions, assign tasks, and set reminders in chat.</small></div>
      </div>
    </div>
    <div className="onboarding-form-side">
      <div className="onboarding-form-wrap">
        <div className="onboarding-switch" role="group" aria-label="Account access">
          <button type="button" aria-pressed={!signup} onClick={() => changeMode('login')}>Sign in</button>
          <button type="button" aria-pressed={signup} onClick={() => changeMode('signup')}>Create account</button>
        </div>
        <form className="onboarding-form" key={mode + step} onSubmit={(event) => {
          event.preventDefault();
          if (choosing) { submit(mode, { ...details, Role: role }); return; }
          const values = Object.fromEntries(new FormData(event.currentTarget));
          if (!signup || joining) { submit(mode, values); return; }
          setDetails(values);
          setStep('agent');
        }}>
          <header>
            {signup && !joining && <p className="onboarding-step">{choosing ? 'Step 2 of 2' : 'Step 1 of 2'}</p>}
            <h2>{choosing ? 'Choose your agent' : signup ? (joining ? 'Join your workspace' : 'Create your account') : 'Sign in to Cowork'}</h2>
            <p>{choosing ? 'Pick a role that matches the work you want to delegate.' : signup ? (joining ? 'Use the invite code your teammate shared.' : 'Start with your details to set up a workspace.') : 'Use your account to open your conversations.'}</p>
          </header>
          {choosing ? <>
            <fieldset className="onboarding-roles">
              <legend className="sr-only">Choose an agent</legend>
              {roles.map(({ name, detail, icon: Icon }) => (
                <label key={name} className="onboarding-role">
                  <Icon aria-hidden="true" className="size-5" />
                  <span><strong>{name}</strong><small>{detail}</small></span>
                  <input type="radio" name="Role" value={name} checked={role === name} onChange={() => setRole(name)} />
                </label>
              ))}
            </fieldset>
            <Button type="submit" disabled={busy}>{busy ? 'Creating workspace…' : 'Create workspace'}</Button>
            <button type="button" className="onboarding-link" onClick={() => setStep('details')} disabled={busy}>Back to your details</button>
          </> : <>
            {signup && <label>Your name<Input name="Name" autoComplete="name" maxLength={80} defaultValue={String(details.Name ?? '')} required /></label>}
            <label>Email<Input name="Email" type="email" autoComplete="email" maxLength={254} defaultValue={String(details.Email ?? '')} required /></label>
            <label>Password<Input name="Password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={8} maxLength={128} defaultValue={String(details.Password ?? '')} required /></label>
            {signup && joining && <label>Workspace invite code<Input name="Invite" autoComplete="off" required /></label>}
            <Button type="submit" disabled={busy}>{busy ? 'Please wait…' : signup ? (joining ? 'Join workspace' : 'Continue') : 'Sign in'}</Button>
            {signup && <button type="button" className="onboarding-link" onClick={() => setJoining(!joining)}>{joining ? 'Create a workspace instead' : 'I have a workspace invite'}</button>}
          </>}
        </form>
      </div>
    </div>
  </section>;
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
