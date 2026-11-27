'use client';

import { useRef, type Dispatch, type SetStateAction } from 'react';
import Image from 'next/image';
import {
  ArrowRightIcon, CheckIcon, ChevronRightIcon, PlusIcon, UserPlusIcon, XMarkIcon,
} from '@heroicons/react/24/outline';
import developerArt from './assets/agents/developer.webp';
import productManagerArt from './assets/agents/product-manager.webp';
import salesLeadArt from './assets/agents/sales-lead.webp';
import socialMediaArt from './assets/agents/social-media.webp';
import styles from './agent-picker.module.css';

export const agentCatalog = [
  { id: 'developer', role: 'Developer', description: 'Plan code changes and build previews for review.', artwork: developerArt, messaging: 'ada' },
  { id: 'product-manager', role: 'Product Manager', description: 'Prioritize feedback, draft briefs, and plan releases.', artwork: productManagerArt },
  { id: 'sales-lead', role: 'Sales Lead', description: 'Research prospects and write follow-ups.', artwork: salesLeadArt, messaging: 'sam' },
  { id: 'social-media', role: 'Social Media', description: 'Draft posts and plan your publishing calendar.', artwork: socialMediaArt },
] as const;

type AgentId = (typeof agentCatalog)[number]['id'];
export type AgentChoices = Partial<Record<AgentId, { added: boolean; name: string }>>;

type AgentPickerProps = {
  choices: AgentChoices;
  setChoices: Dispatch<SetStateAction<AgentChoices>>;
  busy: boolean;
  join: () => void;
  continueSetup: (agents: { ID: AgentId; Name: string }[]) => void;
};

export function AgentPicker({ choices, setChoices, busy, join, continueSetup }: AgentPickerProps) {
  const rosterButtons = useRef<Partial<Record<AgentId, HTMLButtonElement>>>({});
  const team = agentCatalog.filter(({ id }) => choices[id]?.added);

  function toggle(id: AgentId) {
    setChoices((current) => ({
      ...current,
      [id]: { added: !current[id]?.added, name: current[id]?.name ?? '' },
    }));
  }

  return (
    <section className={styles.picker} aria-labelledby="agent-picker-title">
      <header className={styles.intro}>
        <ol className={styles.progress} aria-label="Workspace setup progress">
          <li aria-current="step">Agents</li>
          <li><ChevronRightIcon aria-hidden="true" /> Tools</li>
          <li><ChevronRightIcon aria-hidden="true" /> Channels</li>
        </ol>
        <h1 id="agent-picker-title">Choose your agents</h1>
        <p>Choose one or more roles. Use the role name or enter your own.</p>
      </header>

      <form className={styles.form} onSubmit={(event) => {
        event.preventDefault();
        if (!busy && team.length) continueSetup(team.map(({ id }) => ({ ID: id, Name: choices[id]?.name ?? '' })));
      }}>
        <section className={styles.roster} aria-label="Available agents">
          <ul role="list" className={styles.rosterList}>
            {agentCatalog.map(({ id, role, description, artwork }) => {
              const added = Boolean(choices[id]?.added);
              return (
                <li key={id}>
                  <button className={styles.role} type="button" disabled={busy} aria-pressed={added}
                    aria-labelledby={'agent-role-' + id} aria-describedby={'agent-description-' + id}
                    ref={(button) => { if (button) rosterButtons.current[id] = button; }}
                    onClick={() => toggle(id)}>
                    <span className={styles.artwork}>
                      <Image src={artwork} alt="" unoptimized />
                      <span className={styles.toggleIcon}>
                        {added ? <CheckIcon aria-hidden="true" /> : <PlusIcon aria-hidden="true" />}
                      </span>
                    </span>
                    <span className={styles.roleCopy}>
                      <strong id={'agent-role-' + id}>{role}</strong>
                      <span id={'agent-description-' + id}>{description}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className={styles.team} aria-labelledby="agent-team-title">
          <div className={styles.panelHeader}>
            <h2 id="agent-team-title">Your team</h2>
            <span className={styles.count} role="status">{team.length} selected</span>
          </div>
          {team.length ? (
            <ul className={styles.teamList} role="list">
              {team.map(({ id, role, artwork }) => (
                <li className={styles.teamMember} key={id}>
                  <div className={styles.memberHeader}>
                    <Image src={artwork} alt="" className={styles.memberArtwork} unoptimized />
                    <strong>{role}</strong>
                    <button type="button" className={styles.remove} aria-label={'Remove ' + role} disabled={busy}
                      onClick={() => { toggle(id); rosterButtons.current[id]?.focus(); }}>
                      <XMarkIcon aria-hidden="true" />
                    </button>
                  </div>
                  <label className={styles.name}>{role} name
                    <input autoComplete="off" disabled={busy} maxLength={48} placeholder={role} value={choices[id]?.name ?? ''}
                      onChange={(event) => {
                        const name = event.currentTarget.value;
                        setChoices((current) => ({ ...current, [id]: { added: true, name } }));
                      }} />
                  </label>
                </li>
              ))}
            </ul>
          ) : (
            <div className={styles.empty}>
              <span className={styles.emptyIcon}><UserPlusIcon aria-hidden="true" /></span>
              <p>Add a role to start your team.</p>
            </div>
          )}
          <div className={styles.actions}>
            <button className="primary" type="submit" disabled={busy || team.length === 0}>
              {busy ? 'Saving…' : 'Continue to tools'} <ArrowRightIcon className="size-4" aria-hidden="true" />
            </button>
            <button className={styles.join} type="button" disabled={busy} onClick={join}>I have an invite code</button>
          </div>
        </section>
      </form>
    </section>
  );
}
