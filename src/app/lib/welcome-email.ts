import { renderEmail } from './email-template';

export function welcomeEmail(name: string, role: string, link: URL) {
  const firstName = name.trim().split(/\s+/)[0] || 'there';

  return renderEmail({
    subject: 'Welcome to Cowork',
    preview: `Your ${role} agent is ready.`,
    heading: `Welcome to Cowork, ${firstName}.`,
    introduction: 'Start a conversation, assign a task, or ask for a reminder.',
    details: { label: 'Your agent', value: role, note: 'Ready' },
    action: { label: 'Open your workspace', link },
    footer: 'You received this email because a Cowork account was created with this address.',
  });
}
