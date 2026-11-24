import { after, type NextRequest } from 'next/server';
import { appLink, emailConfig, sendEmail } from '../../lib/email';
import { welcomeEmail } from '../../lib/welcome-email';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) {
    return Response.json({ error: 'Use a JSON request.' }, { status: 415 });
  }

  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== 'object' || !('Email' in body) || typeof body.Email !== 'string'
    || body.Email.length > 254 || !/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(body.Email.trim())) {
    return Response.json({ error: 'Enter a valid email address.' }, { status: 400 });
  }
  const email = body.Email.trim().toLowerCase();
  let response: Response;
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const cookie = request.headers.get('cookie');
    if (cookie) headers.set('Cookie', cookie);
    response = await fetch('http://127.0.0.1:4000/api/signup', {
      method: 'POST', headers, body: JSON.stringify({ ...body, Email: email }), signal: AbortSignal.timeout(8000),
    });
  } catch {
    return Response.json({ error: 'Cowork could not create the account.' }, { status: 502 });
  }

  if (response.ok) {
    const account = await response.clone().json() as { name: string; workspace: { Role: string } };
    const config = emailConfig();
    const link = appLink('/conversations', request.nextUrl.origin);
    if (config && link) {
      after(async () => {
        try {
          await sendEmail(config, email, welcomeEmail(account.name, account.workspace.Role, link));
          console.info('SES accepted a Cowork welcome email.');
        } catch (error) {
          console.warn('Cowork welcome email could not be sent:', error instanceof Error ? error.name : 'Unknown error');
        }
      });
    }
  }
  return response;
}
