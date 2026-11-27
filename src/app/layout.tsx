import type { Metadata } from 'next';
import { connection } from 'next/server';
import { CoworkAuth } from './components/clerk-auth';
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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await connection();
  const enabled = process.env.COWORK_AUTH === 'clerk';
  const publishableKey = process.env.CLERK_SECRET_KEY
    ? process.env.CLERK_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
    : undefined;
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: initializeTheme }} /></head>
      <body><CoworkAuth enabled={enabled} publishableKey={publishableKey}>{children}</CoworkAuth></body>
    </html>
  );
}
