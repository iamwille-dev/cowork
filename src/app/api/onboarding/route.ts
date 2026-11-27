import { after, type NextRequest } from 'next/server';
import { appLink, emailConfig, sendEmail } from '../../lib/email';
import { welcomeEmail } from '../../lib/welcome-email';

async function onboarding(request: NextRequest) {
  if (process.env.COWORK_AUTH !== 'clerk') return Response.json({ error: 'Clerk is unavailable.' }, { status: 503 });
  const headers = new Headers();
  for (const name of ['cookie', 'origin', 'content-type']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  let result: Response;
  try {
    result = await fetch('http://127.0.0.1:4000/api/onboarding', {
      method: request.method, headers, cache: 'no-store', signal: AbortSignal.timeout(10_000),
      ...(request.method === 'POST' && { body: request.body, duplex: 'half' }),
    });
  } catch {
    return Response.json({ error: 'Workspace setup is unavailable. Try again.' }, { status: 502 });
  }

  if (result.headers.get('x-cowork-new-account') === '1') {
    const account = await result.clone().json() as {
      name: string; viewerId: string; workspace: { Role: string }; directory: { ID: string; Email: string }[];
    };
    const email = account.directory.find(({ ID }) => ID === account.viewerId)?.Email;
    const config = emailConfig();
    const link = appLink('/conversations', request.nextUrl.origin);
    if (config && email && link) {
      after(async () => {
        try {
          await sendEmail(config, email, welcomeEmail(account.name, account.workspace.Role, link));
        } catch (error) {
          console.warn('Cowork welcome email could not be sent:', error instanceof Error ? error.name : 'Unknown error');
        }
      });
    }
  }
  return new Response(result.body, {
    status: result.status,
    headers: { 'Cache-Control': 'no-store', 'Content-Type': result.headers.get('content-type') || 'application/json' },
  });
}

export const GET = onboarding;
export const POST = onboarding;
