'use client';

import { useState, type ReactNode } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';

const roles = ['Developer', 'Product Manager', 'Sales Lead', 'Social Media'];

export function AuthForm({ submit, busy }: { submit: (mode: string, values: object) => void; busy: boolean }) {
  const [mode, setMode] = useState('signup');
  const signup = mode === 'signup';
  return <section className="auth">
    <div className="auth-intro"><span className="auth-mark" aria-hidden="true">✳</span><h1>Meet your<br />AI coworker.</h1><p>Chat with an agent, assign tasks, and share the work with your team.</p></div>
    <form className="panel stack auth-panel" onSubmit={(event) => {
      event.preventDefault();
      submit(mode, Object.fromEntries(new FormData(event.currentTarget)));
    }}>
      <h2>{signup ? 'Create your workspace' : 'Sign in'}</h2>
      {signup && <label>Your name<input name="Name" autoComplete="name" maxLength={80} required /></label>}
      <label>Email<input name="Email" type="email" autoComplete="email" maxLength={254} required /></label>
      <label>Password<input name="Password" type="password" autoComplete={signup ? 'new-password' : 'current-password'} minLength={8} maxLength={128} required /></label>
      {signup && <>
        <label>Choose an agent<select name="Role">{roles.map((role) => <option key={role}>{role}</option>)}</select></label>
        <details><summary>Joining a teammate?</summary><label>Workspace invite code<input name="Invite" autoComplete="off" /></label></details>
      </>}
      <button className="primary" disabled={busy}>{signup ? 'Create workspace' : 'Sign in'}</button>
      <button type="button" className="quiet" onClick={() => setMode(signup ? 'login' : 'signup')}>{signup ? 'Already have an account? Sign in' : 'Create an account'}</button>
    </form>
  </section>;
}

export function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  return <Dialog open onClose={close} className="fixed inset-0 z-[60] grid place-items-center p-4">
    <DialogBackdrop className="fixed inset-0 bg-gray-900/70" />
    <DialogPanel className="panel relative max-h-[90dvh] w-full max-w-lg overflow-y-auto p-5">
      <div className="dialog-heading mb-4"><DialogTitle>{title}</DialogTitle><button type="button" className="quiet" onClick={close}>Close</button></div>
      {children}
    </DialogPanel>
  </Dialog>;
}
