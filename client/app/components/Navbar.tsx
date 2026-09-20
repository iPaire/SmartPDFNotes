'use client';

import Link from 'next/link';
import { signOut, useSession } from 'next-auth/react';
import Image from 'next/image';
import { useState, useRef, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown, Plus, Menu } from 'react-feather';
import { Badge } from '@/components/ui';
import type { Tone } from '@/components/ui/Badge';
import NotificationsBell from '@/components/NotificationsBell';
import { analyticsEvents } from '@/lib/analytics';

const navLinkClass =
  'text-ink-soft px-3 py-2 rounded-btn text-sm font-medium hover:bg-sunken hover:text-ink transition-colors';

export default function Navbar() {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const mobileRef = useRef<HTMLDivElement>(null);
  const [daysLeft, setDaysLeft] = useState<number | null>(null);
  const t = useTranslations('common');

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
      if (toolsRef.current && !toolsRef.current.contains(event.target as Node)) {
        setToolsOpen(false);
      }
      if (mobileRef.current && !mobileRef.current.contains(event.target as Node)) {
        setMobileOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Calculează zilele rămase pentru trial
  useEffect(() => {
    if (session?.user?.subscription === 'trial' && session.user.trialExpires) {
      const now = new Date();
      const trialExpires = new Date(session.user.trialExpires);
      const diffTime = trialExpires.getTime() - now.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      setDaysLeft(diffDays);
    }
  }, [session]);

  // Loading state
  if (status === 'loading') {
    return (
      <nav className="bg-surface border-b border-line py-3 px-4 sm:px-6 flex justify-between items-center w-full">
        <Link href="/" className="text-lg font-bold text-ink">
          SmartPDF<span className="text-accent"> Notes</span>
        </Link>
        <div className="w-9 h-9 bg-sunken rounded-full animate-pulse" />
      </nav>
    );
  }

  const planTone: Tone =
    session?.user.subscription === 'free'
      ? 'neutral'
      : session?.user.subscription === 'standard'
        ? 'accent'
        : 'premium';

  const planLabel =
    session?.user.subscription === 'free'
      ? t('free')
      : session?.user.subscription === 'standard'
        ? t('standard')
        : session?.user.subscription === 'trial'
          ? `${t('premium')} Trial`
          : t('premium');

  return (
    <nav className="bg-surface border-b border-line py-3 px-4 sm:px-6 flex justify-between items-center w-full sticky top-0 z-40">
      <Link href="/" className="text-lg font-bold text-ink shrink-0">
        SmartPDF<span className="text-accent"> Notes</span>
      </Link>

      <div className="flex items-center gap-1 md:gap-2">
        {session ? (
          <>
            <Link
              href="/summaries"
              onClick={() => analyticsEvents.navigationClick('library', 'navbar')}
              className={`${navLinkClass} hidden sm:block`}
            >
              {t('library')}
            </Link>
            <Link
              href="/courses"
              onClick={() => analyticsEvents.navigationClick('courses', 'navbar')}
              className={`${navLinkClass} hidden sm:block`}
            >
              {t('courses')}
            </Link>
          </>
        ) : (
          <Link
            href="/"
            onClick={() => analyticsEvents.navigationClick('home', 'navbar')}
            className={`${navLinkClass} hidden sm:block`}
          >
            {t('home')}
          </Link>
        )}

        {/* Free tools (public) */}
        <div ref={toolsRef} className="relative hidden sm:block">
          <button
            onClick={() => setToolsOpen(!toolsOpen)}
            className={`${navLinkClass} flex items-center gap-1 cursor-pointer`}
            aria-expanded={toolsOpen}
          >
            {t('tools')}
            <ChevronDown size={14} />
          </button>
          {toolsOpen && (
            <div className="absolute right-0 mt-2 w-52 bg-surface rounded-card shadow-pop border border-line z-50 py-1.5">
              <Link
                href="/convert-to-pdf"
                onClick={() => {
                  setToolsOpen(false);
                  analyticsEvents.navigationClick('convert-to-pdf', 'navbar');
                }}
                className="block px-4 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
              >
                {t('convertToPdf')}
              </Link>
              <Link
                href="/translate"
                onClick={() => {
                  setToolsOpen(false);
                  analyticsEvents.navigationClick('translate', 'navbar');
                }}
                className="block px-4 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
              >
                {t('translatePdf')}
              </Link>
            </div>
          )}
        </div>

        <Link
          href="/pricing"
          onClick={() => analyticsEvents.navigationClick('pricing', 'navbar')}
          className={`${navLinkClass} hidden sm:block`}
        >
          {t('pricing')}
        </Link>

        {session && (
          <Link
            href="/upload"
            onClick={() => analyticsEvents.navigationClick('upload', 'navbar')}
            className="inline-flex items-center gap-1.5 bg-accent text-white text-sm font-semibold px-3.5 py-2 rounded-btn hover:bg-accent-strong transition-colors ml-1"
          >
            <Plus size={16} />
            <span className="hidden sm:inline">{t('newDocument')}</span>
          </Link>
        )}

        {session && <NotificationsBell />}

        {session ? (
          <div ref={menuRef} className="relative">
            <button
              onClick={() => setOpen(!open)}
              className="cursor-pointer focus:outline-none flex items-center hover:opacity-90 ml-2"
              aria-label="Profile menu"
            >
              {session.user?.image ? (
                <Image
                  src={session.user.image}
                  alt="Profil"
                  width={36}
                  height={36}
                  className="rounded-full border border-line"
                  style={{ maxWidth: '100%', height: 'auto' }}
                />
              ) : (
                <div className="w-9 h-9 bg-accent-soft rounded-full flex items-center justify-center text-accent-strong font-semibold">
                  {session.user?.name?.[0]?.toUpperCase() ?? '?'}
                </div>
              )}
            </button>

            {open && (
              <div className="absolute right-0 mt-2 w-60 bg-surface rounded-card shadow-pop border border-line z-50 max-w-[90vw] py-1.5">
                <div className="px-4 py-3 text-sm text-ink border-b border-line">
                  <p className="font-medium truncate">{session.user?.name}</p>
                  <p className="text-xs text-ink-faint truncate mt-1">{session.user?.email}</p>

                  <div className="mt-2.5 flex items-center gap-2">
                    <span className="text-xs font-medium text-ink-soft">Plan:</span>
                    <Badge tone={planTone}>{planLabel}</Badge>
                  </div>

                  {session.user.subscription === 'trial' && daysLeft !== null && (
                    <div className="mt-1.5 text-xs text-warn">
                      {daysLeft > 0
                        ? `Expires in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`
                        : 'Trial expired'}
                    </div>
                  )}
                </div>

                {(session.user.subscription === 'free' || session.user.subscription === 'trial') && (
                  <Link
                    href="/pricing"
                    className="block text-center mx-2 my-2 px-3 py-2 text-sm font-semibold bg-accent text-white hover:bg-accent-strong rounded-btn transition-colors"
                    onClick={() => {
                      setOpen(false);
                      analyticsEvents.buttonClick('upgrade_plan', 'navbar');
                    }}
                  >
                    Upgrade Plan Now
                  </Link>
                )}

                {/* Mobile-only shortcuts (hidden in the top bar on small screens) */}
                <div className="sm:hidden border-b border-line pb-1.5 mb-1.5">
                  <Link
                    href="/summaries"
                    className="block px-4 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                    onClick={() => setOpen(false)}
                  >
                    {t('library')}
                  </Link>
                  <Link
                    href="/courses"
                    className="block px-4 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                    onClick={() => setOpen(false)}
                  >
                    {t('courses')}
                  </Link>
                  <Link
                    href="/pricing"
                    className="block px-4 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                    onClick={() => setOpen(false)}
                  >
                    {t('pricing')}
                  </Link>
                  <Link
                    href="/convert-to-pdf"
                    className="block px-4 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                    onClick={() => setOpen(false)}
                  >
                    {t('convertToPdf')}
                  </Link>
                  <Link
                    href="/translate"
                    className="block px-4 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                    onClick={() => setOpen(false)}
                  >
                    {t('translatePdf')}
                  </Link>
                </div>

                {session.user.subscription !== 'free' && (
                  <Link
                    href="/dashboard"
                    className="block px-4 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                    onClick={() => setOpen(false)}
                  >
                    {t('dashboard')}
                  </Link>
                )}
                <Link
                  href="/settings"
                  className="block px-4 py-2 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                  onClick={() => setOpen(false)}
                >
                  {t('settings')}
                </Link>
                <button
                  onClick={async () => {
                    analyticsEvents.userLogout();
                    await signOut({
                      callbackUrl: '/',
                      redirect: true,
                    });
                    // Forțează refresh pentru clear cache complet
                    window.location.href = '/';
                  }}
                  className="cursor-pointer w-full text-left px-4 py-2 text-sm text-danger hover:bg-sunken"
                >
                  {t('logout')}
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            <Link
              href="/login"
              className="bg-accent text-white px-4 py-2 rounded-btn hover:bg-accent-strong transition-colors text-sm font-semibold ml-1"
            >
              {t('login')}
            </Link>

            {/* Mobile menu for visitors - the free tools must stay reachable */}
            <div ref={mobileRef} className="relative sm:hidden">
              <button
                onClick={() => setMobileOpen(!mobileOpen)}
                className="p-2 rounded-btn text-ink-soft hover:bg-sunken hover:text-ink transition-colors cursor-pointer"
                aria-label={t('menu')}
                aria-expanded={mobileOpen}
              >
                <Menu size={20} />
              </button>
              {mobileOpen && (
                <div className="absolute right-0 mt-2 w-64 bg-surface rounded-card shadow-pop border border-line z-50 py-1.5">
                  <Link
                    href="/"
                    onClick={() => setMobileOpen(false)}
                    className="block px-4 py-2.5 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                  >
                    {t('home')}
                  </Link>
                  <div className="px-4 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                    {t('freeTools')}
                  </div>
                  <Link
                    href="/convert-to-pdf"
                    onClick={() => {
                      setMobileOpen(false);
                      analyticsEvents.navigationClick('convert-to-pdf', 'navbar-mobile');
                    }}
                    className="block px-4 py-2.5 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                  >
                    {t('convertToPdf')}
                    <span className="block text-xs text-ink-faint mt-0.5">{t('noAccountNeeded')}</span>
                  </Link>
                  <Link
                    href="/translate"
                    onClick={() => {
                      setMobileOpen(false);
                      analyticsEvents.navigationClick('translate', 'navbar-mobile');
                    }}
                    className="block px-4 py-2.5 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                  >
                    {t('translatePdf')}
                    <span className="block text-xs text-ink-faint mt-0.5">{t('noAccountNeeded')}</span>
                  </Link>
                  <div className="border-t border-line mt-1.5 pt-1.5">
                    <Link
                      href="/pricing"
                      onClick={() => setMobileOpen(false)}
                      className="block px-4 py-2.5 text-sm text-ink-soft hover:bg-sunken hover:text-ink"
                    >
                      {t('pricing')}
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </nav>
  );
}
