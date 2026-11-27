'use client';

import { useState } from 'react';
import Image from 'next/image';
import { channelAgents } from '../../channel-agents';
import developer from '../assets/agents/developer.webp';
import productManager from '../assets/agents/product-manager.webp';
import salesLead from '../assets/agents/sales-lead.webp';
import socialMedia from '../assets/agents/social-media.webp';

const agents = [
  { ...channelAgents.ada, tone: 'blue', portrait: developer, personality: 'Methodical', example: 'Build a preview from this UI brief.' },
  { name: 'Ravi', role: 'Product Manager', tone: 'stone', portrait: productManager, personality: 'Organized', example: 'Turn this feedback into release priorities.' },
  { ...channelAgents.sam, tone: 'green', portrait: salesLead, personality: 'Curious', example: 'Research this prospect and draft a follow-up.' },
  { name: 'Sofia', role: 'Social Media', tone: 'amber', portrait: socialMedia, personality: 'Creative', example: 'Draft a week of posts for our launch.' },
] as const;

export function AgentBadges() {
  const [liftedRole, setLiftedRole] = useState<(typeof agents)[number]['role']>();

  return <section className="landing-team" id="roles" aria-labelledby="roles-heading">
    <h2 id="roles-heading">Meet your coworkers</h2>
    <p className="agent-badge-touch-hint">Tap a badge to lift it.</p>
    <ul className="landing-roles" role="list">
      {agents.map(({ name, role, tone, portrait, personality, example }) => {
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
