'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDropzone } from 'react-dropzone';
import { Geist, Geist_Mono } from 'next/font/google';
import { analyticsEvents } from '@/lib/analytics';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono' });
const MONO = 'var(--font-geist-mono), ui-monospace, monospace';

// --- Palette (from the imported "Convert to PDF" design). Minimal near-black
// UI with a single blue accent; green = success, red = error. ---
const C = {
  bg: '#FAFAFA',
  ink: '#0A0A0A',
  border: '#EAEAEA',
  borderStrong: '#D4D4D8',
  zoneBorder: '#C4CAD4',
  zoneBg: '#F7F8FA',
  muted: '#666666',
  muted2: '#71717A',
  faint: '#A1A1AA',
  slate: '#667085',
  ink2: '#101828',
  chip: '#F4F4F5',
  chipBorder: '#EDEDEF',
  accent: '#2563EB',
  accentBg: '#F0F5FF',
  green: '#16A34A',
  red: '#DC2626',
};

// Kept in sync with the server guard (app/lib/upload-guard.ts). Vercel rejects
// request bodies over ~4.5MB before the function runs, so we validate here to
// fail fast with a clear message instead of letting the upload hit that wall.
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'pdf', 'txt', 'docx'];
const MAX_MB = Math.floor(MAX_FILE_BYTES / 1024 / 1024);

const DROPZONE_ACCEPT = {
  'image/jpeg': ['.jpg', '.jpeg'],
  'image/png': ['.png'],
  'application/pdf': ['.pdf'],
  'text/plain': ['.txt'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
};

type FailedFile = { name: string; reason: string };
type Phase = 'idle' | 'uploading' | 'converting' | 'done';
type ErrorKind = 'user' | 'server';

/** Returns an error message if the selection is invalid, otherwise null. */
function validateFiles(files: File[]): string | null {
  const badType = files.filter((f) => {
    const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
    return !ALLOWED_EXTENSIONS.includes(ext);
  });
  if (badType.length > 0) {
    return `Unsupported file type: ${badType.map((f) => f.name).join(', ')}. Allowed: JPG, PNG, PDF, TXT, DOCX.`;
  }

  const docxCount = files.filter((f) => /\.docx$/i.test(f.name)).length;
  if (docxCount > 0 && files.length > 1) {
    return 'Word documents must be converted one at a time. Please select a single .docx file.';
  }

  const oversize = files.filter((f) => f.size > MAX_FILE_BYTES);
  if (oversize.length > 0) {
    return `These files exceed the ${MAX_MB}MB per-file limit: ${oversize.map((f) => f.name).join(', ')}.`;
  }

  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    return `Total upload exceeds the ${MAX_MB}MB limit. Please convert fewer or smaller files at a time.`;
  }

  return null;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Short uppercase extension badge, e.g. "DOCX", "PNG". */
function extBadge(name: string): string {
  const parts = name.split('.');
  const ext = parts.length > 1 ? parts.pop()!.toLowerCase() : '';
  return (ext || 'file').toUpperCase().slice(0, 4);
}

/**
 * Turn a failed XHR into a user-facing error. The blob body may be our JSON
 * ({ error, failedFiles }) or a non-JSON platform page; fall back to a
 * status-based message so a 413/504 never surfaces as a JSON-parse crash.
 * 4xx (except 5xx) are "user" errors (amber, fixable); the rest are "server".
 */
async function parseXhrError(
  xhr: XMLHttpRequest
): Promise<{ message: string; failedFiles: FailedFile[]; kind: ErrorKind }> {
  const status = xhr.status;
  const kind: ErrorKind = [400, 413, 415, 422, 429].includes(status) ? 'user' : 'server';
  const byStatus: Record<number, string> = {
    413: `Your files are too large. Keep the total under ${MAX_MB}MB.`,
    415: 'That file type is not supported.',
    422: 'The file could not be processed. It may be corrupt.',
    429: 'Too many requests. Please wait a moment and try again.',
    502: 'The server had a problem. Please try again.',
    504: 'The conversion timed out. Try fewer or smaller files.',
  };

  let raw = '';
  try {
    if (xhr.response instanceof Blob) raw = await xhr.response.text();
    else if (typeof xhr.response === 'string') raw = xhr.response;
  } catch {
    // ignore - fall through to the status-based message
  }

  if (raw) {
    try {
      const data = JSON.parse(raw);
      return {
        message: data.error || byStatus[status] || 'Conversion failed. Please try again.',
        failedFiles: Array.isArray(data.failedFiles) ? data.failedFiles : [],
        kind,
      };
    } catch {
      // non-JSON body (platform error page) - use the status fallback below
    }
  }

  return {
    message: byStatus[status] || `Conversion failed (error ${status || 'network'}). Please try again.`,
    failedFiles: [],
    kind,
  };
}

export default function ConvertToPDF() {
  const { data: session } = useSession();
  const router = useRouter();
  const tConvert = useTranslations('convertToPdf');

  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [uploadPct, setUploadPct] = useState(0);
  const [convertedUrl, setConvertedUrl] = useState<string | null>(null);
  const [convertedName, setConvertedName] = useState('document.pdf');
  const [error, setError] = useState('');
  const [errorKind, setErrorKind] = useState<ErrorKind>('user');
  const [failedFiles, setFailedFiles] = useState<FailedFile[]>([]);
  const urlRef = useRef<string | null>(null);

  // Revoke the blob URL when it changes or on unmount to avoid leaks.
  useEffect(() => {
    urlRef.current = convertedUrl;
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [convertedUrl]);

  const onDrop = useCallback((accepted: File[]) => {
    if (accepted.length === 0) return;
    setSelectedFiles((prev) => {
      // Once results are showing, a fresh drop starts a new batch; otherwise
      // append (matching the "Add files" affordance). De-dupe by name+size.
      const base = phase === 'done' ? [] : prev;
      return [...base, ...accepted].filter(
        (f, i, all) => all.findIndex((g) => g.name === f.name && g.size === f.size) === i
      );
    });
    setConvertedUrl(null);
    setPhase('idle');
    setFailedFiles([]);
    setError('');
    setErrorKind('user');
  }, [phase]);

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    accept: DROPZONE_ACCEPT,
    multiple: true,
    noClick: true,
    noKeyboard: true,
  });

  // Re-validate whenever the selection changes.
  useEffect(() => {
    if (phase === 'idle') setError(selectedFiles.length ? validateFiles(selectedFiles) ?? '' : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFiles]);

  const removeFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const reset = () => {
    setSelectedFiles([]);
    setPhase('idle');
    setUploadPct(0);
    setConvertedUrl(null);
    setError('');
    setFailedFiles([]);
  };

  const handleConvert = () => {
    if (selectedFiles.length === 0) return;

    const validationError = validateFiles(selectedFiles);
    if (validationError) {
      setError(validationError);
      setErrorKind('user');
      setFailedFiles([]);
      return;
    }

    analyticsEvents.fileConverterUsed();

    const isDocx = /\.docx$/i.test(selectedFiles[0].name);
    const formData = new FormData();
    if (isDocx) {
      formData.append('file', selectedFiles[0]);
    } else {
      selectedFiles.forEach((f) => formData.append('files', f));
    }

    setError('');
    setFailedFiles([]);
    setUploadPct(0);
    setPhase('uploading');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', isDocx ? '/api/convert/docx' : '/api/convert');
    xhr.responseType = 'blob';

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setUploadPct(Math.round((e.loaded / e.total) * 100));
    };
    xhr.upload.onload = () => {
      setUploadPct(100);
      setPhase('converting');
    };

    xhr.onload = async () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const url = URL.createObjectURL(xhr.response as Blob);
        setConvertedUrl(url);
        setConvertedName(
          selectedFiles.length === 1
            ? `${selectedFiles[0].name.replace(/\.[^/.]+$/, '')}.pdf`
            : 'converted-documents.pdf'
        );
        setPhase('done');
        return;
      }
      const parsed = await parseXhrError(xhr);
      setError(parsed.message);
      setFailedFiles(parsed.failedFiles);
      setErrorKind(parsed.kind);
      setPhase('idle');
    };

    xhr.onerror = () => {
      setError('Could not reach the server. Check your connection and try again.');
      setErrorKind('server');
      setPhase('idle');
    };
    xhr.ontimeout = () => {
      setError('The conversion timed out. Try fewer or smaller files.');
      setErrorKind('server');
      setPhase('idle');
    };

    xhr.send(formData);
  };

  // This page is intentionally public so it can be indexed and used without an
  // account (the /api/convert backend allows anonymous, rate-limited use). Only
  // the secondary "Use for analysis" action requires a session.
  const busy = phase === 'uploading' || phase === 'converting';
  const done = phase === 'done';
  const hasFiles = selectedFiles.length > 0;
  const invalid = !!validateFiles(selectedFiles);
  const totalSize = selectedFiles.reduce((a, f) => a + f.size, 0);

  let summaryText: string;
  if (done) summaryText = `${selectedFiles.length} ${selectedFiles.length === 1 ? 'file' : 'files'} converted`;
  else if (phase === 'uploading') summaryText = `Uploading… ${uploadPct}%`;
  else if (phase === 'converting') summaryText = 'Converting your document…';
  else summaryText = `${selectedFiles.length} ${selectedFiles.length === 1 ? 'file' : 'files'} · ${humanSize(totalSize)}`;

  return (
    <div
      className={`${geist.variable} ${geistMono.variable}`}
      style={{ background: C.bg, color: C.ink, minHeight: '100vh', fontFamily: 'var(--font-geist), system-ui, sans-serif' }}
    >
      <style>{SP_STYLES}</style>

      <main className="relative flex flex-col items-center" style={{ padding: 'clamp(28px,6vw,56px) 20px 80px', overflow: 'hidden' }}>
        {/* Soft ambient wash behind the hero - depth without noise */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute', top: -180, left: '50%', transform: 'translateX(-50%)',
            width: 720, height: 420, pointerEvents: 'none',
            background: `radial-gradient(closest-side, ${C.accent}14, transparent 70%)`,
          }}
        />
        <div className="w-full relative" style={{ maxWidth: 600 }}>

          {/* Status pill */}
          <div
            className="inline-flex items-center gap-2 mb-4"
            style={{
              padding: '4px 10px', border: `1px solid ${C.border}`, background: '#fff',
              borderRadius: 999, fontFamily: MONO, fontSize: 11, letterSpacing: '0.04em', color: C.muted2,
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: C.green }} />
            PDF ENGINE ONLINE
          </div>

          {/* Heading + intro (crawlable) */}
          <h1 style={{ margin: '0 0 10px', fontSize: 'clamp(28px,5.5vw,38px)', fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1.08 }}>
            {tConvert('seoHeading')}
          </h1>
          <div aria-hidden="true" style={{ width: 44, height: 4, borderRadius: 999, background: C.accent, margin: '0 0 14px' }} />
          <p style={{ margin: '0 0 26px', fontSize: 15, lineHeight: 1.55, color: C.muted, maxWidth: 520 }}>
            {tConvert('seoIntro')}
          </p>

          {/* Main card */}
          <div
            {...getRootProps()}
            className="relative"
            style={{
              background: '#fff', border: `1px solid ${C.border}`, borderRadius: 14,
              boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 12px 32px -18px rgba(0,0,0,0.12)', overflow: 'hidden',
            }}
          >
            <input {...getInputProps()} />

            {/* Drag overlay */}
            {isDragActive && (
              <div
                className="absolute z-10 flex items-center justify-center"
                style={{ inset: 8, border: `2px solid ${C.accent}`, background: 'rgba(37,99,235,0.045)', borderRadius: 10, pointerEvents: 'none' }}
              >
                <span style={{ fontSize: 14, fontWeight: 600, color: C.accent }}>Drop files to upload</span>
              </div>
            )}

            {!hasFiles ? (
              /* Empty dropzone */
              <div style={{ padding: 10 }}>
                <div
                  role="button"
                  tabIndex={0}
                  aria-label="Upload files. Press Enter to browse."
                  onClick={open}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }}
                  className="sp-zone flex flex-col items-center text-center"
                  style={{
                    gap: 8, padding: 'clamp(40px,8vw,56px) 24px', border: `2px dashed ${C.zoneBorder}`,
                    borderRadius: 12, background: C.zoneBg, cursor: 'pointer',
                  }}
                >
                  <div
                    className="flex items-center justify-center"
                    style={{ width: 56, height: 56, borderRadius: 16, background: C.accentBg, border: `1px solid ${C.accent}26`, boxShadow: '0 1px 2px rgba(16,24,40,0.05)', color: C.accent, marginBottom: 6 }}
                  >
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 15V3" /><path d="m7 8 5-5 5 5" /><path d="M20 15v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-4" />
                    </svg>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: C.ink2 }}>Drag and drop your files here</div>
                  <div style={{ fontSize: 14, color: C.slate }}>
                    or <span style={{ color: C.accent, fontWeight: 600, textDecoration: 'underline', textUnderlineOffset: 2 }}>click to browse</span>
                  </div>
                  <div className="flex flex-wrap items-center justify-center" style={{ marginTop: 12, gap: 6 }}>
                    {['JPG', 'PNG', 'PDF', 'TXT', 'DOCX'].map((ext) => (
                      <span
                        key={ext}
                        style={{
                          padding: '3px 9px', borderRadius: 999, background: '#fff',
                          border: `1px solid ${C.chipBorder}`, fontFamily: MONO,
                          fontSize: 10.5, letterSpacing: '0.04em', color: C.muted2,
                        }}
                      >
                        {ext}
                      </span>
                    ))}
                    <span style={{ fontFamily: MONO, fontSize: 10.5, color: '#98A2B3', marginLeft: 4 }}>
                      up to {MAX_MB} MB
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                {/* File rows */}
                <ul style={{ listStyle: 'none', margin: 0, padding: 6, display: 'flex', flexDirection: 'column' }}>
                  {selectedFiles.map((file, i) => (
                    <FileRow
                      key={`${file.name}-${file.size}-${i}`}
                      file={file}
                      phase={phase}
                      uploadPct={uploadPct}
                      onRemove={() => removeFile(i)}
                    />
                  ))}
                </ul>

                {/* Error */}
                {error && <ErrorBanner message={error} kind={errorKind} failedFiles={failedFiles} onRetry={handleConvert} />}

                {/* Action bar */}
                <div
                  className="flex flex-wrap items-center justify-between"
                  style={{ gap: 12, padding: '14px 16px', borderTop: `1px solid ${C.chipBorder}` }}
                >
                  <div className="flex items-center min-w-0" style={{ gap: 14 }}>
                    {!done && (
                      <button type="button" onClick={open} disabled={busy} className="sp-btn-ghost" style={ghostBtn(busy)}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 5v14" /><path d="M5 12h14" />
                        </svg>
                        Add files
                      </button>
                    )}
                    <span aria-live="polite" style={{ fontSize: 13, color: C.muted2, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {summaryText}
                    </span>
                  </div>

                  <div className="flex items-center" style={{ gap: 8 }}>
                    {done ? (
                      <>
                        <button type="button" onClick={reset} className="sp-btn-ghost" style={ghostBtn(false, 38)}>
                          Start over
                        </button>
                        {session && (
                          <button
                            type="button"
                            onClick={() => router.push('/upload')}
                            className="sp-btn-ghost"
                            style={{ ...ghostBtn(false, 38), color: C.accent, borderColor: `${C.accent}44` }}
                          >
                            Use for analysis
                          </button>
                        )}
                        <a
                          href={convertedUrl ?? '#'}
                          download={convertedName}
                          className="sp-btn-primary inline-flex items-center"
                          style={{ ...primaryBtn(false), gap: 7, textDecoration: 'none' }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M12 3v12" /><path d="m7 12 5 5 5-5" /><path d="M5 21h14" />
                          </svg>
                          Download PDF
                        </a>
                      </>
                    ) : busy ? (
                      <button disabled className="inline-flex items-center" style={{ ...primaryBtn(false), gap: 8, opacity: 0.9, cursor: 'default' }}>
                        <span className="sp-spin" style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,0.35)', borderTopColor: '#fff', borderRadius: '50%' }} />
                        {phase === 'uploading' ? 'Uploading…' : 'Converting…'}
                      </button>
                    ) : (
                      <button type="button" onClick={handleConvert} disabled={invalid} className="sp-btn-primary" style={primaryBtn(invalid)}>
                        Convert to PDF
                      </button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Trust bar (honest: no storage, HTTPS, public) */}
          <div
            className="flex flex-wrap items-center justify-center"
            style={{ gap: 8, marginTop: 22 }}
          >
            {[
              {
                label: 'Encrypted in transit',
                icon: (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                ),
              },
              {
                label: "Files aren't stored",
                icon: (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                ),
              },
              {
                label: 'No sign-up required',
                icon: (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                ),
              },
            ].map((chip) => (
              <span
                key={chip.label}
                className="inline-flex items-center"
                style={{
                  gap: 6, padding: '5px 11px', borderRadius: 999, background: '#fff',
                  border: `1px solid ${C.border}`, fontSize: 12, fontWeight: 500, color: C.muted2,
                }}
              >
                <span style={{ color: C.green, display: 'inline-flex' }}>{chip.icon}</span>
                {chip.label}
              </span>
            ))}
          </div>

          {/* FAQ - crawlable content mirrored by the FAQPage JSON-LD in layout.tsx */}
          <div style={{ marginTop: 56 }}>
            <h2 style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em', margin: '0 0 16px' }}>
              {tConvert('faqTitle')}
            </h2>
            <div className="flex flex-col" style={{ gap: 10 }}>
              {[
                { q: tConvert('faq1Q'), a: tConvert('faq1A') },
                { q: tConvert('faq2Q'), a: tConvert('faq2A') },
                { q: tConvert('faq3Q'), a: tConvert('faq3A') },
              ].map((item, i) => (
                <div
                  key={i}
                  style={{
                    padding: '14px 16px', background: '#fff', border: `1px solid ${C.border}`,
                    borderRadius: 12, boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
                  }}
                >
                  <h3 style={{ fontSize: 14.5, fontWeight: 600, margin: '0 0 4px', color: C.ink2 }}>{item.q}</h3>
                  <p style={{ fontSize: 14, lineHeight: 1.55, color: C.muted, margin: 0 }}>{item.a}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

// ---------- helpers ----------

function ghostBtn(disabled: boolean, height = 34): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6, height, padding: '0 12px',
    border: `1px solid ${C.border}`, background: '#fff', borderRadius: 8,
    fontFamily: 'var(--font-geist), sans-serif', fontSize: 13, fontWeight: 600, color: C.ink,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    transition: 'background .12s ease, border-color .12s ease',
  };
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    height: 38, padding: '0 16px', border: 'none', background: C.accent, color: '#fff',
    borderRadius: 8, fontFamily: 'var(--font-geist), sans-serif', fontSize: 14, fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1,
    boxShadow: '0 1px 2px rgba(37,99,235,0.25)',
    transition: 'background .12s ease, transform .08s ease',
  };
}

// ---------- sub-components ----------

function FileRow({
  file,
  phase,
  uploadPct,
  onRemove,
}: {
  file: File;
  phase: Phase;
  uploadPct: number;
  onRemove: () => void;
}) {
  const uploading = phase === 'uploading';
  const converting = phase === 'converting';
  const done = phase === 'done';
  const busy = uploading || converting;

  let subline: string;
  let color: string;
  if (done) { subline = `${humanSize(file.size)} · PDF ready`; color = C.green; }
  else if (uploading) { subline = `${humanSize(file.size)} · Uploading`; color = C.accent; }
  else if (converting) { subline = `${humanSize(file.size)} · Converting`; color = C.accent; }
  else { subline = `${humanSize(file.size)} · Ready to convert`; color = C.muted2; }

  return (
    <li className="sp-row flex items-center" style={{ gap: 13, padding: '12px', borderRadius: 9 }}>
      <div
        className="flex items-center justify-center"
        style={{ flex: 'none', width: 42, height: 42, borderRadius: 9, background: C.chip, border: `1px solid ${C.chipBorder}`, fontFamily: MONO, fontSize: 10.5, fontWeight: 500, color: '#52525B' }}
      >
        {extBadge(file.name)}
      </div>

      <div className="flex-1 min-w-0">
        <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: '-0.006em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {file.name}
        </div>
        <div style={{ marginTop: 2, fontSize: 12.5, fontWeight: 500, color }}>{subline}</div>
        {busy && (
          <div style={{ marginTop: 9, height: 4, background: '#EFEFF1', borderRadius: 999, overflow: 'hidden' }}>
            {uploading ? (
              <div style={{ width: `${uploadPct}%`, height: '100%', background: C.accent, borderRadius: 999, transition: 'width .18s ease' }} />
            ) : (
              <div className="sp-indeterminate" style={{ height: '100%', background: C.accent }} />
            )}
          </div>
        )}
      </div>

      <div className="flex items-center" style={{ flex: 'none', gap: 6 }}>
        {uploading && (
          <span style={{ fontFamily: MONO, fontSize: 12, color: C.muted2, minWidth: 34, textAlign: 'right' }}>{uploadPct}%</span>
        )}
        {!busy && !done && (
          <button type="button" onClick={onRemove} aria-label={`Remove ${file.name}`} className="sp-remove flex items-center justify-center"
            style={{ width: 30, height: 30, flex: 'none', border: 'none', background: 'transparent', borderRadius: 7, color: C.faint, cursor: 'pointer', transition: 'background .12s ease, color .12s ease' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        )}
      </div>
    </li>
  );
}

function ErrorBanner({
  message,
  kind,
  failedFiles,
  onRetry,
}: {
  message: string;
  kind: ErrorKind;
  failedFiles: FailedFile[];
  onRetry: () => void;
}) {
  return (
    <div style={{ margin: '4px 10px 0', borderRadius: 9, padding: '12px 14px', background: '#FEF2F2', border: `1px solid ${C.red}22`, fontSize: 13.5 }}>
      <p style={{ margin: 0, fontWeight: 600, color: C.red }}>{message}</p>
      {failedFiles.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 16, color: C.ink2 }}>
          {failedFiles.map((f, i) => (
            <li key={i}><span style={{ fontWeight: 600 }}>{f.name}</span>: {f.reason}</li>
          ))}
        </ul>
      )}
      {kind === 'server' && (
        <button type="button" onClick={onRetry} style={{ marginTop: 8, background: 'none', border: 'none', padding: 0, fontWeight: 600, color: C.red, textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}>
          Try again
        </button>
      )}
    </div>
  );
}

// ---------- animations (reduced-motion aware) ----------

const SP_STYLES = `
.sp-zone:hover { border-color: ${C.accent} !important; background: ${C.accentBg} !important; }
.sp-zone:focus-visible { outline: 2px solid ${C.accent}; outline-offset: 2px; }
.sp-row:hover { background: #FAFAFA; }
.sp-remove:hover { background: #F0F0F1; color: ${C.ink}; }
.sp-btn-ghost:hover:not(:disabled) { background: #FAFAFA; border-color: ${C.borderStrong}; }
.sp-btn-primary:hover:not(:disabled) { background: #1D4ED8; }
.sp-btn-primary:active:not(:disabled) { transform: translateY(1px); }
@keyframes sp-spin { to { transform: rotate(360deg); } }
.sp-spin { animation: sp-spin .7s linear infinite; }
@keyframes sp-indeterminate-move { 0% { transform: translateX(-100%); } 100% { transform: translateX(320%); } }
.sp-indeterminate { width: 35%; border-radius: 999px; animation: sp-indeterminate-move 1.1s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) {
  .sp-spin, .sp-indeterminate { animation: none !important; }
}
`;
