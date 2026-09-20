'use client';

// Shared generate-on-demand wrapper for workspace artifact tabs.
// Handles every lifecycle state: locked (plan), empty (generate CTA),
// loading, error (retry), rate-limited (countdown) and ready.
/* eslint-disable @typescript-eslint/no-explicit-any -- artifact payloads vary per type and are validated by each consumer */
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Lock, Zap } from 'react-feather';
import { Button, EmptyState, Skeleton, SkeletonText } from '@/components/ui';

// Survives tab switches (which unmount tabs) without refetching.
const artifactCache = new Map<string, any>();

type Status = 'idle' | 'loading' | 'ready' | 'error' | 'ratelimited';

interface ArtifactSectionProps {
  summaryId: string;
  type: string;
  /** Server said this artifact already exists in the DB. */
  exists: boolean;
  /** Feature not available on the user's plan. */
  locked: boolean;
  icon: React.ReactNode;
  emptyTitle: string;
  emptyDescription: string;
  /** Section label used in the locked state. */
  sectionLabel: string;
  onGenerated: (type: string) => void;
  children: (content: any, regenerate: () => void) => React.ReactNode;
}

export default function ArtifactSection({
  summaryId,
  type,
  exists,
  locked,
  icon,
  emptyTitle,
  emptyDescription,
  sectionLabel,
  onGenerated,
  children,
}: ArtifactSectionProps) {
  const t = useTranslations('workspace');
  const cacheKey = `${summaryId}:${type}`;

  const [status, setStatus] = useState<Status>(() =>
    artifactCache.has(cacheKey) ? 'ready' : exists ? 'loading' : 'idle'
  );
  const [content, setContent] = useState<any>(() => artifactCache.get(cacheKey) ?? null);
  const [retryAfter, setRetryAfter] = useState(0);
  const fetchedRef = useRef(false);

  // Load an existing artifact from the DB on first mount.
  useEffect(() => {
    if (locked || fetchedRef.current || !exists || artifactCache.has(cacheKey)) return;
    fetchedRef.current = true;
    (async () => {
      try {
        const res = await fetch(`/api/workspace/${summaryId}/artifacts`);
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        const found = (data.artifacts || []).find((a: any) => a.type === type);
        if (found) {
          artifactCache.set(cacheKey, found.content);
          setContent(found.content);
          setStatus('ready');
        } else {
          setStatus('idle');
        }
      } catch {
        setStatus('error');
      }
    })();
  }, [locked, exists, cacheKey, summaryId, type]);

  // Rate-limit countdown.
  useEffect(() => {
    if (status !== 'ratelimited' || retryAfter <= 0) return;
    const timer = setInterval(() => {
      setRetryAfter((s) => {
        if (s <= 1) {
          clearInterval(timer);
          setStatus('idle');
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [status, retryAfter > 0]);

  const generate = async (force = false) => {
    setStatus('loading');
    try {
      const res = await fetch(`/api/workspace/${summaryId}/artifacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, force }),
      });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({}));
        setRetryAfter(Number(data.retryAfter) || 30);
        setStatus('ratelimited');
        return;
      }
      if (!res.ok) throw new Error('generation failed');
      const data = await res.json();
      artifactCache.set(cacheKey, data.content);
      setContent(data.content);
      setStatus('ready');
      onGenerated(type);
    } catch {
      setStatus('error');
    }
  };

  if (locked) {
    return (
      <EmptyState
        icon={<Lock size={22} />}
        title={t('locked.title', { feature: sectionLabel })}
        description={t('locked.description')}
        action={<Button href="/pricing">{t('locked.cta')}</Button>}
        className="bg-surface border border-line rounded-card"
      />
    );
  }

  if (status === 'ready' && content) {
    return <>{children(content, () => generate(true))}</>;
  }

  if (status === 'loading') {
    return (
      <div className="bg-surface border border-line rounded-card p-6">
        <div className="flex items-center gap-3 mb-6">
          <Skeleton className="h-10 w-10 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-4 w-40 mb-2" />
            <p className="text-xs text-ink-faint">{t('generatingHint')}</p>
          </div>
        </div>
        <SkeletonText lines={8} />
      </div>
    );
  }

  if (status === 'ratelimited') {
    return (
      <EmptyState
        icon={icon}
        title={emptyTitle}
        description={t('rateLimited', { seconds: retryAfter })}
        className="bg-surface border border-line rounded-card"
      />
    );
  }

  if (status === 'error') {
    return (
      <EmptyState
        icon={icon}
        title={t('generationError')}
        action={
          <Button variant="secondary" onClick={() => generate()}>
            {t('retry')}
          </Button>
        }
        className="bg-surface border border-line rounded-card"
      />
    );
  }

  // idle: friendly generate CTA
  return (
    <EmptyState
      icon={icon}
      title={emptyTitle}
      description={emptyDescription}
      action={
        <Button size="lg" onClick={() => generate()}>
          <Zap size={16} />
          {t('generate')}
        </Button>
      }
      className="bg-surface border border-line rounded-card"
    />
  );
}
