'use client';

import { useRef, useState } from 'react';
import {
  ArrowRightIcon, ChevronLeftIcon, ChevronRightIcon, CodeBracketIcon,
  CommandLineIcon, EnvelopeIcon, MagnifyingGlassIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import styles from './connection-catalog.module.css';

export const connectionApps = [
  { id: 'github', name: 'GitHub', category: 'Development', description: 'Give agents access to the repositories you choose.', icon: CodeBracketIcon },
  { id: 'gmail', name: 'Gmail', category: 'Email', description: 'Give agents read access to a mailbox you choose.', icon: EnvelopeIcon },
  { id: 'ssh', name: 'SSH', category: 'Infrastructure', description: 'Connect a host for use with an Agent Connections key.', icon: CommandLineIcon },
] as const;

export type ConnectionAppId = (typeof connectionApps)[number]['id'];
type Availability = 'loading' | 'ready' | 'setup' | 'settings' | 'unavailable';
type CatalogApp = {
  id: string;
  name: string;
  category: string;
  description: string;
  icon: typeof CodeBracketIcon;
  availability: Availability;
  connected: number;
  connect?: () => void;
  alternate?: { label: string; run: () => void };
};

const pageSize = 6;
const availabilityLabel = {
  loading: 'Checking availability',
  ready: 'Ready to connect',
  setup: 'Needs setup',
  settings: 'Set up in Settings',
  unavailable: 'Unavailable',
};

export function ConnectionCatalog({ apps, busy, serviceError, retry }: {
  apps: readonly CatalogApp[];
  busy: boolean;
  serviceError?: string;
  retry?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const search = useRef<HTMLInputElement>(null);
  const terms = query.toLowerCase().trim().split(/\s+/);
  const matches = apps.filter(({ name, category, description }) => {
    const searchable = `${name} ${category} ${description}`.toLowerCase();
    return terms.every((term) => searchable.includes(term));
  });
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const current = Math.min(page, pages);
  const first = (current - 1) * pageSize;
  const last = Math.min(first + pageSize, matches.length);
  const needsSetup = matches.some((app) => app.availability === 'setup');

  function searchFor(value: string) {
    setQuery(value);
    setPage(1);
  }

  return (
    <section className={styles.catalog} aria-label="App catalog">
      <header className={styles.catalogHeader}>
        <h2>Available apps</h2>
        <div className={styles.search}>
          <MagnifyingGlassIcon aria-hidden="true" />
          <input ref={search} type="search" aria-label="Search apps" placeholder="Search apps"
            value={query} onChange={(event) => searchFor(event.currentTarget.value)} />
          {query && <button className={styles.clearSearch} type="button" aria-label="Clear app search"
            onClick={() => { searchFor(''); search.current?.focus(); }}><XMarkIcon aria-hidden="true" /></button>}
        </div>
      </header>
      {serviceError && <div className={styles.notice} role="alert">
        <p>{serviceError}</p>
        {retry && <button className="quiet" type="button" onClick={retry}>Retry</button>}
      </div>}
      {matches.length ? (
        <ul role="list">
          {matches.slice(first, last).map(({ id, name, category, description, icon: Icon, availability, connected, connect, alternate }) => (
            <li key={id} className={styles.app}>
              <span className={styles.appIcon}><Icon aria-hidden="true" /></span>
              <div className={styles.appInfo}>
                <h3>{name}</h3>
                <p>{description}</p>
                <span className={styles.category}>{category}</span>
              </div>
              <div className={styles.appAction}>
                {connected > 0 && <span className={styles.appStatus} data-state="connected">{connected} connected</span>}
                {availability === 'ready' && connect ? (
                  <button className="quiet" type="button" aria-label={connected ? `Add account for ${name}` : `Connect ${name}`} disabled={busy} onClick={connect}>
                    {connected ? 'Add account' : 'Connect'} <ArrowRightIcon aria-hidden="true" />
                  </button>
                ) : <span className={styles.appStatus} data-state={availability}>{availabilityLabel[availability]}</span>}
                {availability === 'ready' && alternate && <button className={styles.alternate} type="button" disabled={busy} onClick={alternate.run}>
                  {alternate.label}
                </button>}
              </div>
            </li>
          ))}
        </ul>
      ) : <div className={styles.empty}><strong>No matching apps</strong><p>Try an app name or category.</p></div>}

      <footer className={styles.catalogFooter}>
        <p role="status">{pages > 1
          ? `${last === first + 1 ? last : `${first + 1}–${last}`} of ${matches.length} apps`
          : `${matches.length} ${matches.length === 1 ? 'app' : 'apps'}`}</p>
        {pages > 1 && <nav className={styles.pagination} aria-label="App pages">
          <button className="quiet" type="button" disabled={current === 1} onClick={() => setPage(current - 1)}>
            <ChevronLeftIcon aria-hidden="true" /> Previous
          </button>
          <button className="quiet" type="button" disabled={current === pages} onClick={() => setPage(current + 1)}>
            Next <ChevronRightIcon aria-hidden="true" />
          </button>
        </nav>}
      </footer>
      {needsSetup && <p className={styles.setupNote}>Apps marked “Needs setup” require credentials on this Cowork deployment.</p>}
    </section>
  );
}
