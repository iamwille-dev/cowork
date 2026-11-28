type PreviewTask = { ID: string; Artifacts?: { Name: string; URL: string }[] };

export function taskPreviewUrl(task: PreviewTask, savedUrl = task.Artifacts?.find(({ Name }) => Name === 'Sandbox preview')?.URL) {
  if (!savedUrl) return;
  const path = `/api/artifact/${task.ID}/preview`;
  if (/^[a-f0-9]{48}$/.test(task.ID) && (savedUrl === path || savedUrl === `${path}.html`)) {
    const publicUrl = URL.parse(process.env.COWORK_PUBLIC_URL?.trim() || '');
    return publicUrl && /^https?:$/.test(publicUrl.protocol) && !publicUrl.username && !publicUrl.password
      ? new URL(savedUrl, publicUrl).href : savedUrl;
  }
  const url = URL.parse(savedUrl);
  if (url?.protocol === 'https:' && !url.username && !url.password) return url.href;
}

export function previewLink(url?: string) {
  return url && `[Open sandbox preview](<${url}>)`;
}
