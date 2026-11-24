export async function GET() {
  try {
    const response = await fetch('http://127.0.0.1:4000/api/health', { signal: AbortSignal.timeout(2000), cache: 'no-store' });
    if (!response.ok) throw new Error('Encore is not ready.');
    return Response.json({ status: 'ok' });
  } catch {
    return Response.json({ status: 'unavailable' }, { status: 503 });
  }
}
