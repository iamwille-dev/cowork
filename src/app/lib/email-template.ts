const font = '"Instrument Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif';

const escapedCharacters: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => escapedCharacters[character]);
}

type EmailTemplate = {
  subject: string;
  preview: string;
  heading: string;
  introduction: string;
  details: { label: string; value: string; note: string };
  action: { label: string; link: URL };
  footer: string;
};

export function renderEmail({ subject, preview, heading, introduction, details, action, footer }: EmailTemplate) {
  const text = [
    heading,
    introduction,
    `${details.label}: ${details.value}\n${details.note}`,
    `${action.label}: ${action.link.href}`,
    footer,
  ].join('\n\n');

  // The inbox receives a standalone document, so critical styles use Cowork's tokens inline.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <meta name="supported-color-schemes" content="light dark">
  <title>${escapeHtml(subject)}</title>
  <style>
    @media screen and (max-width: 480px) {
      .email-gutter { padding: 24px 12px 32px !important; }
      .email-panel { padding: 24px !important; }
      .email-heading { font-size: 28px !important; line-height: 34px !important; }
    }
  </style>
  <style>
    :root { color-scheme: light dark; }
    @media (prefers-color-scheme: dark) {
      .email-canvas { background-color: #1b1c1a !important; }
      .email-panel { background-color: #242522 !important; border-color: #393a34 !important; }
      .email-details { background-color: #20211e !important; border-color: #393a34 !important; }
      .email-ink { color: #f3f1eb !important; }
      .email-muted { color: #c0beb4 !important; }
      .email-action { background-color: #eae7de !important; color: #22221f !important; }
    }
  </style>
</head>
<body class="email-canvas" style='margin:0;padding:0;background-color:#f3f2ee;color:#252522;font-family:${font}'>
  <div aria-hidden="true" style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all">${escapeHtml(preview)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f2ee" class="email-canvas" style="background-color:#f3f2ee">
    <tr><td align="center" class="email-gutter" style="padding:40px 16px">
      <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;table-layout:fixed;text-align:left">
        <tr>
          <td class="email-ink" style='padding:0 2px 16px;color:#252522;font:700 22px/28px ${font};letter-spacing:-0.03em'>Cowork</td>
        </tr>
        <tr>
          <td bgcolor="#ffffff" class="email-panel" style='padding:32px;background-color:#ffffff;border:1px solid #e4e2db;border-radius:12px;font-family:${font}'>
            <h1 class="email-ink email-heading" style="margin:0 0 12px;color:#252522;font-size:34px;font-weight:600;line-height:40px;letter-spacing:-0.03em;word-wrap:break-word;overflow-wrap:anywhere">${escapeHtml(heading)}</h1>
            <p class="email-muted" style="margin:0 0 24px;color:#62615b;font-size:16px;line-height:24px">${escapeHtml(introduction)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="table-layout:fixed">
              <tr>
                <td bgcolor="#eeede8" class="email-details" style='padding:12px 16px;background-color:#eeede8;border:1px solid #e4e2db;border-radius:8px;font-family:${font};word-wrap:break-word;overflow-wrap:anywhere'>
                  <p class="email-muted" style="margin:0 0 2px;color:#62615b;font-size:13px;font-weight:500;line-height:18px">${escapeHtml(details.label)}</p>
                  <p class="email-ink" style="margin:0;color:#252522;font-size:16px;font-weight:600;line-height:22px">${escapeHtml(details.value)}</p>
                  <p class="email-muted" style="margin:4px 0 0;color:#62615b;font-size:13px;line-height:19px">${escapeHtml(details.note)}</p>
                </td>
              </tr>
            </table>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="padding-top:24px">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td bgcolor="#252522" align="center" class="email-action" style="background-color:#252522;border-radius:999px;mso-padding-alt:12px 20px">
                      <a href="${escapeHtml(action.link.href)}" class="email-action" style='display:inline-block;padding:12px 20px;mso-padding-alt:0;border-radius:999px;background-color:#252522;color:#ffffff;font:600 15px/20px ${font};text-decoration:none'>${escapeHtml(action.label)}</a>
                    </td>
                  </tr>
                </table>
              </td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td class="email-muted" style='padding:16px 2px 0;color:#62615b;font:400 13px/20px ${font}'>${escapeHtml(footer)}</td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;

  return { subject, text, html };
}
