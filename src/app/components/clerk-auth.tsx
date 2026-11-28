'use client';

import { ClerkProvider, SignIn, SignUp } from '@clerk/nextjs';
import { buttonClassName } from './button';
import { fieldClassName } from './input';
import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { AccountAccess, AccountModeSwitch, type AccountMode } from './account-access';
import styles from './account-access.module.css';

const ClerkMode = createContext<'legacy' | 'clerk' | 'unavailable'>('legacy');
export const useClerkMode = () => useContext(ClerkMode);

const accountAppearance = {
  options: { elevation: 'flush' },
  variables: { colorPrimary: 'var(--cowork-auth-primary)' },
  elements: {
    rootBox: styles.clerkRoot,
    cardBox: `${styles.card} ${styles.clerkCard}`,
    card: styles.clerkBody,
    footer: styles.clerkFooter,
    header: styles.clerkHeader,
    headerTitle: styles.title,
    main: styles.clerkMain,
    form: styles.clerkForm,
    formFieldInput: fieldClassName(styles.field),
    formButtonPrimary: buttonClassName('primary', styles.primary),
    socialButtonsBlockButton: styles.clerkProviderButton,
    dividerLine: styles.clerkDivider,
    footerAction__signIn: styles.clerkAccountSwitch,
    footerAction__signUp: styles.clerkAccountSwitch,
  },
} satisfies NonNullable<ComponentProps<typeof SignIn>['appearance']>;

export function CoworkAuth({ publishableKey, enabled, children }: {
  publishableKey?: string;
  enabled: boolean;
  children: ReactNode;
}) {
  if (!enabled) return children;
  if (!publishableKey) return <ClerkMode.Provider value="unavailable">{children}</ClerkMode.Provider>;
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={{
      cssLayerName: 'clerk',
      elements: { formFieldInput: fieldClassName(), formButtonPrimary: buttonClassName('primary') },
      variables: {
        colorPrimary: 'var(--accent)', colorBackground: 'var(--surface)', colorForeground: 'var(--ink)',
        colorPrimaryForeground: 'var(--on-accent)', colorBorder: 'var(--line-strong)', colorRing: 'var(--focus)',
        colorNeutral: 'var(--ink)', colorMuted: 'var(--sidebar)',
        colorMutedForeground: 'var(--muted)', colorInput: 'var(--surface)',
        colorInputForeground: 'var(--ink)', fontFamily: 'Instrument Sans, sans-serif', borderRadius: '8px',
      },
    }}>
      <ClerkMode.Provider value="clerk">{children}</ClerkMode.Provider>
    </ClerkProvider>
  );
}

export function ClerkSignIn({ initialMode = 'login' }: { initialMode?: AccountMode }) {
  const [mode, setMode] = useState(initialMode);
  const signup = mode === 'signup';
  const widget = useRef<HTMLDivElement>(null);
  const focusWidget = useRef(false);
  const label = signup ? 'Create your Cowork account' : 'Sign in to Cowork';
  const fallback = <p className={`${styles.card} ${styles.form}`} role="status">Loading {signup ? 'account creation' : 'sign-in'}…</p>;

  useEffect(() => {
    if (focusWidget.current) widget.current?.focus();
    focusWidget.current = false;
  }, [mode]);

  function changeMode() {
    const url = new URL(window.location.href);
    url.hash = '';
    if (url.pathname === '/conversations') {
      if (signup) url.searchParams.delete('signup');
      else url.searchParams.set('signup', '1');
    }
    window.history.replaceState(window.history.state, '', url);
    focusWidget.current = true;
    setMode(signup ? 'login' : 'signup');
  }

  return <AccountAccess>
    <div className={styles.clerkWidget} ref={widget} role="group" aria-label={label} tabIndex={-1}>
      {signup ? <SignUp appearance={accountAppearance} routing="hash" fallbackRedirectUrl="/conversations" fallback={fallback} />
        : <SignIn appearance={accountAppearance} routing="hash" fallbackRedirectUrl="/conversations" fallback={fallback} />}
    </div>
    <AccountModeSwitch signup={signup} onSwitch={changeMode} />
  </AccountAccess>;
}
