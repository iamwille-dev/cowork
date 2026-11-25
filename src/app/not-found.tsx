import Link from 'next/link';
import { ArrowLeftIcon, DocumentMagnifyingGlassIcon } from '@heroicons/react/24/outline';

export default function NotFound() {
  return <main className="grid min-h-dvh place-items-center p-4">
    <section className="panel grid w-full max-w-md justify-items-start gap-3 p-6 sm:p-8">
      <span className="chat-agent-mark"><DocumentMagnifyingGlassIcon aria-hidden="true" /></span>
      <h1 className="text-2xl">Page not found</h1>
      <p>Check the address or return to Cowork.</p>
      <Link href="/" className="primary mt-2"><ArrowLeftIcon className="size-4" aria-hidden="true" /> Back to home</Link>
    </section>
  </main>;
}
