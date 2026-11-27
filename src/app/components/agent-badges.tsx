'use client';

import { useState } from 'react';
import Image from 'next/image';
import { agentProfiles } from '../lib/agent-profiles';

export function AgentBadges() {
  const [liftedRole, setLiftedRole] = useState<(typeof agentProfiles)[number]['role']>();

  return <section className="landing-team" id="roles" aria-labelledby="roles-heading">
    <h2 id="roles-heading">Meet your coworkers</h2>
    <p className="agent-badge-touch-hint">Tap a badge to lift it.</p>
    <ul className="landing-roles" role="list">
      {agentProfiles.map(({ name, role, tone, portrait, personality, example }) => {
        const lifted = liftedRole === role;
        return <li key={role} className="agent-badge" data-tone={tone} data-lifted={lifted || undefined}>
          <div className="agent-badge-face">
            <div className="agent-badge-identity">
              <Image src={portrait} alt="" className="agent-badge-portrait" unoptimized />
              <div>
                <h3>{name}</h3>
                <p className="agent-badge-role">{role}</p>
                <p className="agent-badge-personality">{personality}</p>
              </div>
            </div>
            <p className="agent-badge-example"><q>{example}</q></p>
            <button type="button" className="agent-badge-lift" aria-label={`Lift badge for ${name}`} aria-pressed={lifted}
              onClick={() => setLiftedRole(current => current === role ? undefined : role)} />
          </div>
        </li>;
      })}
    </ul>
  </section>;
}
