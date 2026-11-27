'use client';

import { ClerkProvider, SignIn, SignUp } from '@clerk/nextjs';
import { createContext, useContext, useState, type ReactNode } from 'react';

const ClerkMode = createContext<'legacy' | 'clerk' | 'unavailable'>('legacy');
export const useClerkMode = () => useContext(ClerkMode);

export function CoworkAuth({ publishableKey, enabled, children }: {
  publishableKey?: string;
  enabled: boolean;
  children: ReactNode;
}) {
  if (!enabled) return children;
  if (!publishableKey) return <ClerkMode.Provider value="unavailable">{children}</ClerkMode.Provider>;
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={{
      variables: {
        colorPrimary: 'var(--accent)', colorBackground: 'var(--surface)', colorForeground: 'var(--ink)',
        colorMutedForeground: 'var(--muted)', colorInput: 'var(--surface)',
        colorInputForeground: 'var(--ink)', fontFamily: 'Instrument Sans, sans-serif', borderRadius: '8px',
      },
    }}>
      <ClerkMode.Provider value="clerk">{children}</ClerkMode.Provider>
    </ClerkProvider>
  );
}

export function ClerkSignIn({ initialMode = 'login' }: { initialMode?: 'signup' | 'login' }) {
  const [mode, setMode] = useState(initialMode);
  const signup = mode === 'signup';
  return (
    <main className="onboarding sign-in-gate">
      <div className="onboarding-story">
        <div>
          <h1>{signup ? 'Set up your Cowork workspace' : 'Sign in to Cowork'}</h1>
          <p>{signup ? 'Choose the agents you want to work with and connect the tools they need.' : 'Open your workspace, pick up a conversation, or check on your agent’s work.'}</p>
        </div>
      </div>
      <div className="onboarding-form-side">
        <div className="clerk-sign-in">
          <div className="onboarding-switch" role="group" aria-label="Account access">
            <button type="button" aria-pressed={!signup} onClick={() => setMode('login')}>Sign in</button>
            <button type="button" aria-pressed={signup} onClick={() => setMode('signup')}>Create account</button>
          </div>
          {signup ? <SignUp routing="hash" fallbackRedirectUrl="/conversations" />
            : <SignIn routing="hash" fallbackRedirectUrl="/conversations" />}
        </div>
      </div>
    </main>
  );
}
