import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cowork — Agent workspace',
  description: 'A shared workspace for your agent and your team.',
};

const initializeTheme = `try {
 const saved = localStorage.getItem('cowork-theme');
 document.documentElement.dataset.theme = saved === 'dark' || saved === 'light'
  ? saved : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch { document.documentElement.dataset.theme = 'light'; }`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: initializeTheme }} /></head>
      <body>{children}</body>
    </html>
  );
}
