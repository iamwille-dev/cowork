import { renderEmail } from './email-template';

export function invitationEmail(title: string, link: URL) {
  return renderEmail({
    subject: 'Invitation to chat in Cowork',
    preview: `You’ve been invited to join “${title}” in Cowork.`,
    heading: 'You’re invited to chat',
    introduction: 'Guest access is limited to the conversation below.',
    details: {
      label: 'Conversation',
      value: title,
      note: 'This single-use link expires in seven days.',
    },
    action: { label: 'Join conversation', link },
    footer: 'If you weren’t expecting this invitation, you can ignore this email.',
  });
}
