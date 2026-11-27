import Link from 'next/link';
import { ArrowRightIcon, SparklesIcon } from '@heroicons/react/24/outline';

type PublicPage = 'home' | 'how-it-works' | 'faq';

function Brand() {
  return <Link href="/" className="landing-brand" aria-label="Cowork home">
    <span className="brand-mark"><SparklesIcon aria-hidden="true" /></span> Cowork
  </Link>;
}

export function LandingHeader({ currentPage = 'home' }: { currentPage?: PublicPage }) {
  const rolesHref = { home: '#roles', 'how-it-works': '#agents', faq: '/#roles' }[currentPage];

  return <header className="landing-header">
    <div className="landing-wrap landing-nav">
      <Brand />
      <nav aria-label="Main navigation">
        <Link href={rolesHref}>Agent roles</Link>
        <Link href="/how-it-works" aria-current={currentPage === 'how-it-works' ? 'page' : undefined}>How it works</Link>
        <Link href="/faq" aria-current={currentPage === 'faq' ? 'page' : undefined}>FAQ</Link>
      </nav>
      <Link href="/conversations" className="landing-small-link">Open workspace <ArrowRightIcon aria-hidden="true" /></Link>
    </div>
  </header>;
}

export function LandingFooter({ currentPage = 'home' }: { currentPage?: PublicPage }) {
  return <footer className="landing-footer landing-wrap">
    <Brand />
    <nav className="landing-footer-links" aria-label="Footer navigation">
      {currentPage !== 'how-it-works' && <Link href="/how-it-works" className="landing-small-link">How it works</Link>}
      {currentPage === 'faq'
        ? <Link href="/" className="landing-small-link">Back to home</Link>
        : <Link href="/faq" className="landing-small-link">FAQ</Link>}
    </nav>
    <Link href="/conversations" className="landing-small-link">Open workspace <ArrowRightIcon aria-hidden="true" /></Link>
  </footer>;
}
