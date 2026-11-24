const htmlEscape = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character] ?? character));

export function welcomeEmail(name: string, role: string, link: URL) {
  const firstName = name.trim().split(/\s+/)[0] || 'there';
  const introduction = `Your ${role} agent is ready. Start a conversation, assign a task, or ask for a reminder.`;
  return {
    subject: 'Welcome to Cowork',
    text: `Welcome to Cowork, ${firstName}.\n\n${introduction}\n\nOpen your workspace: ${link.href}\n\nYou received this email because a Cowork account was created with this address.`,
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Welcome to Cowork</title></head>
<body style="margin:0;background:#0b090d;color:#f9f5f5;font-family:Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0b090d">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;text-align:left">
<tr><td style="padding:0 0 24px;font-size:23px;font-weight:bold;color:#f9f5f5">cowork<span style="color:#f68a82">.</span></td></tr>
<tr><td style="padding:30px 24px;background:#19131e;border:1px solid #433344;border-radius:18px">
<h1 style="margin:0 0 12px;color:#f9f5f5;font-size:32px;line-height:1.1">Welcome to Cowork, ${htmlEscape(firstName)}<span style="color:#f68a82">.</span></h1>
<p style="margin:0 0 24px;color:#c0b4be;font-size:16px;line-height:1.6">${htmlEscape(introduction)}</p>
<a href="${htmlEscape(link.href)}" style="display:inline-block;background:#f68a82;border-radius:24px;padding:12px 20px;color:#26131a;text-decoration:none;font-size:15px;font-weight:bold">Open your workspace</a>
</td></tr>
<tr><td style="padding:18px 0;color:#c0b4be;font-size:13px;line-height:1.5">You received this email because a Cowork account was created with this address.</td></tr>
</table>
</td></tr></table></body></html>`,
  };
}
