export async function api<T>(path: string, data?: object): Promise<T> {
  const response = await fetch('/api/' + path, data === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(result.error || 'Cowork could not complete the request.'), { status: response.status });
  return result;
}

export const initials = (name: string) => name.trim().split(/\s+/).slice(0, 2).map((word) => Array.from(word)[0] || '').join('').toUpperCase();
export const localDay = (day: Date) => [day.getFullYear(), day.getMonth() + 1, day.getDate()].map((value) => String(value).padStart(2, '0')).join('-');
