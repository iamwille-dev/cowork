import Link from 'next/link';
import { ArrowRightIcon, SparklesIcon } from '@heroicons/react/24/outline';

function Brand() {
  return <Link href="/" className="landing-brand" aria-label="Cowork home">
    <span className="brand-mark"><SparklesIcon aria-hidden="true" /></span> Cowork
  </Link>;
}

export function LandingHeader({ isFaq = false }: { isFaq?: boolean }) {
  return <header className="landing-header">
    <div className="landing-wrap landing-nav">
      <Brand />
      <nav aria-label="Main navigation">
        <Link href={isFaq ? '/#roles' : '#roles'}>Agent roles</Link>
        <Link href={isFaq ? '/#workflow' : '#workflow'}>How it works</Link>
        <Link href="/faq" aria-current={isFaq ? 'page' : undefined}>FAQ</Link>
      </nav>
      <Link href="/conversations" className="landing-small-link">Open workspace <ArrowRightIcon aria-hidden="true" /></Link>
    </div>
  </header>;
}

export function LandingFooter({ isFaq = false }: { isFaq?: boolean }) {
  return <footer className="landing-footer landing-wrap">
    <Brand />
    {isFaq
      ? <Link href="/" className="landing-small-link">Back to home</Link>
      : <Link href="/faq" className="landing-small-link">FAQ</Link>}
    <Link href="/conversations" className="landing-small-link">Open workspace <ArrowRightIcon aria-hidden="true" /></Link>
  </footer>;
}
