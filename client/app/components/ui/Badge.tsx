export type Tone = 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'premium';

const tones: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-soft',
  accent: 'bg-accent-soft text-accent-strong',
  success: 'bg-success-soft text-success',
  warn: 'bg-warn-soft text-warn',
  danger: 'bg-danger-soft text-danger',
  premium: 'bg-ink text-white',
};

export default function Badge({
  tone = 'neutral',
  className = '',
  children,
}: {
  tone?: Tone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-pill px-2.5 py-0.5 text-xs font-medium ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
