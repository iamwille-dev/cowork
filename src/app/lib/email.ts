import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

let ses: SESv2Client | undefined;

export function emailConfig() {
  const sender = process.env.AWS_SES_FROM_EMAIL?.trim();
  const region = process.env.AWS_SES_REGION?.trim() || process.env.AWS_REGION?.trim();
  const accessKeyId = process.env.AWS_SES_ACCESS_KEY?.trim();
  const secretAccessKey = process.env.AWS_SES_SECRET_KEY?.trim();
  if (!sender || !region || Boolean(accessKeyId) !== Boolean(secretAccessKey)) return undefined;
  return {
    sender, region,
    ...(accessKeyId && secretAccessKey ? {
      credentials: { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SES_SESSION_TOKEN },
    } : {}),
  };
}

export function appLink(path: string, origin: string) {
  try {
    const link = new URL(path, process.env.COWORK_PUBLIC_URL || process.env.NEXT_PUBLIC_COWORK_URL || origin);
    return ['https:', 'http:'].includes(link.protocol) && !link.username && !link.password ? link : undefined;
  } catch {
    return undefined;
  }
}

export async function sendEmail(config: NonNullable<ReturnType<typeof emailConfig>>, to: string,
  message: { subject: string; text: string; html?: string }) {
  const { sender, ...clientConfig } = config;
  ses ??= new SESv2Client({ ...clientConfig, maxAttempts: 1 });
  return ses.send(new SendEmailCommand({
    FromEmailAddress: sender,
    Destination: { ToAddresses: [to] },
    Content: { Simple: {
      Subject: { Data: message.subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: message.text, Charset: 'UTF-8' },
        ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' } } : {}),
      },
    } },
  }), { abortSignal: AbortSignal.timeout(12000) });
}
