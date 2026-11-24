import { SESv2Client, SendEmailCommand, SESv2ServiceException } from '@aws-sdk/client-sesv2';
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';

const encore = 'http://127.0.0.1:4000/api/thread/invite/email';
let ses: SESv2Client | undefined;

function reply(data: object, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
}

function configuredLink(request: NextRequest) {
  const publicURL = process.env.COWORK_PUBLIC_URL || process.env.NEXT_PUBLIC_COWORK_URL || request.nextUrl.origin;
  try {
    const url = new URL('/guest', publicURL);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(request: NextRequest) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'Use a JSON request.' }, 415);
  const session = request.cookies.get('cowork_session')?.value;
  if (!session) return reply({ error: 'Sign in to send an invitation.' }, 401);

  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== 'object' || !('Email' in input) || !('ThreadID' in input)
      || typeof input.Email !== 'string' || input.Email.length > 254
      || typeof input.ThreadID !== 'string' || (input.ThreadID && !/^[a-f0-9]{48}$/.test(input.ThreadID))) {
    return reply({ error: 'Choose a conversation and enter a valid email address.' }, 400);
  }

  const sender = process.env.AWS_SES_FROM_EMAIL?.trim();
  const region = process.env.AWS_SES_REGION?.trim() || process.env.AWS_REGION?.trim();
  const accessKeyId = process.env.AWS_SES_ACCESS_KEY?.trim();
  const secretAccessKey = process.env.AWS_SES_SECRET_KEY?.trim();
  const link = configuredLink(request);
  if (!sender || !region || !link || Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    return reply({ error: 'Invitation email is unavailable. Check the server’s SES settings and Cowork URL.' }, 503);
  }

  const headers = { 'Content-Type': 'application/json', Cookie: `cowork_session=${session}` };
  let grant: { token: string; email: string; title: string; expires: string };
  try {
    const response = await fetch(encore, {
      method: 'POST', headers, body: JSON.stringify({ ThreadID: input.ThreadID, Email: input.Email }),
      signal: AbortSignal.timeout(5000),
    });
    const data = await response.json();
    if (!response.ok) return reply({ error: data.error || 'Could not create the invitation.' }, response.status);
    grant = data;
  } catch {
    return reply({ error: 'Could not create the invitation.' }, 502);
  }

  link.hash = new URLSearchParams({ invite: grant.token }).toString();
  ses ??= new SESv2Client({
    region,
    maxAttempts: 1,
    ...(accessKeyId && secretAccessKey ? {
      credentials: { accessKeyId, secretAccessKey, sessionToken: process.env.AWS_SES_SESSION_TOKEN },
    } : {}),
  });
  try {
    await ses.send(new SendEmailCommand({
      FromEmailAddress: sender,
      Destination: { ToAddresses: [grant.email] },
      Content: { Simple: {
        Subject: { Data: 'Invitation to chat in Cowork', Charset: 'UTF-8' },
        Body: { Text: { Charset: 'UTF-8', Data:
          `You’ve been invited to join “${grant.title}” in Cowork.\n\n${link.href}\n\nThis single-use link grants access to that conversation only and expires in seven days. If you weren’t expecting it, you can ignore this email.`,
        } },
      } },
    }), { abortSignal: AbortSignal.timeout(12000) });
  } catch (error) {
    const status = error instanceof SESv2ServiceException ? error.$metadata.httpStatusCode ?? 0 : 0;
    if (status >= 400 && status < 500) {
      await fetch(encore + '/revoke', {
        method: 'POST', headers, body: JSON.stringify({ Text: grant.token }), signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      return reply({ error: 'Amazon SES rejected the invitation email. Check the sender, recipient, and SES sending permissions.' }, 502);
    }
    return reply({ error: 'Cowork could not confirm that Amazon SES accepted the invitation email.' }, 502);
  }
  return reply({ email: grant.email, expires: grant.expires });
}
