// app/components/PDFProcessor.tsx - "Start learning" entry point.
// Uploads a PDF to /api/summarize and lands the user in their learning
// workspace. The old inline summary/quiz rendering was removed when the
// workspace became the destination; a minimal fallback remains for responses
// without a summaryId.
'use client';
import { useState, useRef, ChangeEvent, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  FileText,
  MessageCircle,
  Key,
  CheckSquare,
  Layers,
  HelpCircle,
  Edit3,
  UploadCloud,
  Lock,
  Zap,
  ArrowRight,
  X,
  Coffee,
} from 'react-feather';
import FeedbackPopup from './FeedbackPopup';
import MarkdownContent from './MarkdownContent';
import { Button, Card, CardBody, Badge } from '@/components/ui';
import { analyticsEvents } from '@/lib/analytics';


import { getErrorMessage } from '@/lib/errors';
const parseJSON = async (response: Response) => {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error('Invalid JSON response:', text);
    throw new Error('Invalid server response');
  }
};

export default function PDFProcessor() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const t = useTranslations('pdfProcessor');
  const tWorkspace = useTranslations('workspace');
  const [summary, setSummary] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [fileSize, setFileSize] = useState(0);
  const [usage, setUsage] = useState({
    used: 0,
    limit: 3,
    fileSizeLimit: 10 * 1024 * 1024  // Default to 10MB
  });
  const [showFeedback, setShowFeedback] = useState(false);
  const [isSubmittingFeedback, setIsSubmittingFeedback] = useState(false);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [summaryLength, setSummaryLength] = useState<'short' | 'long' | 'academic'>('long');
  const [hasPreviousFeedback, setHasPreviousFeedback] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch usage data and feedback status on component mount
  useEffect(() => {
    if (status === 'authenticated') {
      fetchUsage();
      checkFeedbackStatus();
    }
  }, [status]);

  // Check if we should show feedback request at exactly 3 usages
  useEffect(() => {
    if (status === 'authenticated' && usage.used === 3 && !hasPreviousFeedback) {
      setTimeout(() => setShowFeedback(true), 1500);
    }
  }, [usage, status, hasPreviousFeedback]);

  const fetchUsage = async () => {
    try {
      const response = await fetch('/api/usage');
      if (!response.ok) throw new Error('Failed to fetch usage');

      const data = await response.json();
      if (response.ok) {
        const fileSizeLimitBytes = data.fileSizeLimit * 1024 * 1024;
        setUsage({ ...data, fileSizeLimit: fileSizeLimitBytes });
      }
    } catch (error) {
      console.error('Error fetching usage:', error);
    }
  };

  const checkFeedbackStatus = async () => {
    try {
      const response = await fetch('/api/feedback');
      if (!response.ok) throw new Error('Failed to check feedback status');

      const data = await response.json();
      setHasPreviousFeedback(data.hasFeedback);
    } catch (error) {
      console.error('Error checking feedback status:', error);
    }
  };

  const selectFile = async (file: File) => {
    if (file.type !== 'application/pdf') {
      setError(t('pdfOnly'));
      return;
    }

    if (file.size > usage.fileSizeLimit) {
      const maxSizeMB = usage.fileSizeLimit / (1024 * 1024);
      setError(t('fileTooBig', { maxSizeMB }));
      return;
    }

    setError('');
    setSelectedFile(file);
    setFileName(file.name);
    setFileSize(file.size);
    setSummary('');

    // Automatically start processing the file
    await processFile(file);
  };

  const processFile = async (file: File) => {
    if (status !== 'authenticated') {
      router.push('/login');
      return;
    }

    if (usage.used >= usage.limit) {
      setError(usage.limit === 3
        ? t('limitReached', { limit: usage.limit })
        : t('limitReachedWait', { limit: usage.limit }));
      return;
    }

    // Track PDF upload
    analyticsEvents.pdfUpload(file.size);

    setIsLoading(true);

    try {
      // Track processing started
      analyticsEvents.pdfProcessingStarted();
      const processingStartTime = Date.now();

      // Vercel functions cap request bodies at 4.5MB, so large PDFs are
      // uploaded straight to storage via a signed URL and /api/summarize
      // receives only the path. Small files keep the direct multipart path.
      const DIRECT_UPLOAD_LIMIT = 4 * 1024 * 1024;
      let response: Response;

      if (file.size > DIRECT_UPLOAD_LIMIT) {
        const urlRes = await fetch('/api/upload-url', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, size: file.size })
        });
        const urlData = await parseJSON(urlRes);
        if (!urlRes.ok) {
          throw new Error(urlData.error || 'Upload failed');
        }

        const putRes = await fetch(urlData.signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/pdf' },
          body: file
        });
        if (!putRes.ok) {
          throw new Error('Upload failed');
        }

        response = await fetch('/api/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storagePath: urlData.path,
            filename: file.name,
            summaryLength
          })
        });
      } else {
        const formData = new FormData();
        formData.append('pdf', file);
        formData.append('filename', file.name);
        formData.append('summaryLength', summaryLength);

        response = await fetch('/api/summarize', {
          method: 'POST',
          body: formData
        });
      }

      const contentType = response.headers.get('content-type');

      if (!contentType || !contentType.includes('application/json')) {
        const text = await response.text();
        if (text.startsWith('<!DOCTYPE html>')) {
          throw new Error('Internal server error');
        }
        throw new Error(`Unexpected response: ${text.substring(0, 100)}`);
      }

      const data = await parseJSON(response);

      if (!response.ok) {
        throw new Error(data.error || 'Unknown processing error');
      }

      if (data.summary) {
        // Track successful processing
        const processingTime = Date.now() - processingStartTime;
        analyticsEvents.pdfProcessingCompleted(processingTime);
        analyticsEvents.summaryGenerated();

        // Land the user in their learning workspace. The inline result view
        // below remains as a fallback for responses without a summaryId.
        // `duplicate` means the same file was already summarized - the
        // workspace shows an explanatory banner via the query param.
        if (data.summaryId) {
          router.push(`/workspace/${data.summaryId}${data.duplicate ? '?existing=1' : ''}`);
          return;
        }

        setSummary(data.summary);
        fetchUsage();

        // Check if we should show feedback after exactly 3 summaries
        const totalSummaries = (usage.used || 0) + 1; // Current usage + the one we just generated
        if (totalSummaries === 3 && !hasPreviousFeedback) {
          setTimeout(() => setShowFeedback(true), 2000);
        }
      } else {
        setError(t('noSummary'));
        analyticsEvents.pdfProcessingFailed('no_summary_generated');
      }
    } catch (err) {
      console.error('PDF processing error:', err);
      const message = getErrorMessage(err);
      
      // Track processing failure
      analyticsEvents.pdfProcessingFailed(message || 'unknown_error');
      
      let userMessage = message || 'Unknown processing error';
      
      if (message.includes('Failed to fetch')) {
        userMessage = t('connectionFailed');
      } else if (message.includes('Internal server error')) {
        userMessage = t('serverError');
      } else if (message.includes('monthly limit')) {
        userMessage = message;
      }

      setError(userMessage);
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    const file = files[0];
    await selectFile(file);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      await selectFile(file);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const triggerFileInput = () => {
    if (status !== 'authenticated') {
      router.push('/login');
      return;
    }

    if (usage.used >= usage.limit) {
      setError(usage.limit === 3
        ? t('limitReached', { limit: usage.limit })
        : t('limitReachedWait', { limit: usage.limit }));
      return;
    }

    // Reset states when selecting new file
    setSelectedFile(null);
    setFileName('');
    setFileSize(0);
    setError('');
    setSummary('');

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
      fileInputRef.current.click();
    }
  };

  const submitFeedback = async (rating: number, comment: string) => {
    setIsSubmittingFeedback(true);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          rating,
          comment,
        })
      });

      if (response.ok) {
        setFeedbackSubmitted(true);
        setHasPreviousFeedback(true); // Mark that user has given feedback
        setTimeout(() => {
          setShowFeedback(false);
        }, 2000);
      } else {
        throw new Error('Failed to submit feedback');
      }
    } catch (error) {
      console.error('Feedback submission error:', error);
      setError(t('feedbackError'));
    } finally {
      setIsSubmittingFeedback(false);
    }
  };

  const maxSizeMB = usage.fileSizeLimit / (1024 * 1024);

  const featureChips: Array<{ icon: React.ReactNode; label: string }> = [
    { icon: <FileText size={14} />, label: tWorkspace('sections.summary') },
    { icon: <MessageCircle size={14} />, label: tWorkspace('sections.chat') },
    { icon: <Key size={14} />, label: tWorkspace('sections.concepts') },
    { icon: <CheckSquare size={14} />, label: tWorkspace('sections.quiz') },
    { icon: <Layers size={14} />, label: tWorkspace('sections.flashcards') },
    { icon: <HelpCircle size={14} />, label: tWorkspace('sections.questions') },
    { icon: <Edit3 size={14} />, label: tWorkspace('sections.notes') },
  ];

  return (
    <div className="min-h-screen bg-canvas py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-3xl mx-auto">
        {/* Usage bar */}
        {status === 'authenticated' && (
          <div className="mb-6 bg-surface border border-line rounded-card p-4 flex flex-col sm:flex-row justify-between items-center gap-3">
            <div className="text-sm text-ink-soft">
              <span className="font-medium">{t('monthlyUsage')} </span>
              <span className="font-semibold text-ink">
                {usage.used} / {usage.limit} {t('summaries')}
              </span>
              <span className="ml-4 font-medium">
                {t('fileLimit')} {maxSizeMB}MB
              </span>
            </div>
            {usage.used >= usage.limit && (
              <Button size="sm" onClick={() => router.push('/pricing')}>
                {t('upgradePlan')}
              </Button>
            )}
          </div>
        )}

        {/* Hero */}
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-ink sm:text-4xl">
            {t('heroTitle')}
          </h1>
          <p className="mt-3 text-lg text-ink-soft">
            {t('heroSubtitle')}
          </p>
        </div>

        {/* Dropzone */}
        <Card
          className={`overflow-hidden transition-all ${
            isDragOver ? 'border-accent ring-4 ring-accent/20 bg-accent-soft' : ''
          }`}
        >
          <div
            className="px-6 py-8 sm:p-10"
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <div className="text-center">
              <div className="mx-auto bg-accent-soft w-16 h-16 rounded-full flex items-center justify-center mb-5">
                <UploadCloud className="h-8 w-8 text-accent" />
              </div>

              <h3 className="text-lg font-semibold text-ink mb-1.5">
                {t('uploadDocument')}
              </h3>

              <p className="text-sm text-ink-soft mb-6 max-w-md mx-auto">
                {isDragOver ? t('dropHere') : t('secureProcessing')}
              </p>

              {/* Summary Length Selector */}
              <div className="mb-6">
                <label className="block text-sm font-medium text-ink mb-3">
                  {t('summaryLength')}
                </label>
                <div className="flex justify-center flex-wrap gap-2.5">
                  <button
                    type="button"
                    onClick={() => setSummaryLength('short')}
                    className={`px-4 py-2 text-sm font-medium rounded-pill border transition-colors cursor-pointer ${
                      summaryLength === 'short'
                        ? 'bg-accent text-white border-accent'
                        : 'bg-surface text-ink-soft border-line-strong hover:bg-sunken'
                    }`}
                  >
                    {t('shortSummary')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSummaryLength('long')}
                    className={`px-4 py-2 text-sm font-medium rounded-pill border transition-colors cursor-pointer ${
                      summaryLength === 'long'
                        ? 'bg-accent text-white border-accent'
                        : 'bg-surface text-ink-soft border-line-strong hover:bg-sunken'
                    }`}
                  >
                    {t('longSummary')}
                  </button>
                  {session && usage.limit > 3 && session.user.subscription == 'premium' && (
                    <button
                      type="button"
                      onClick={() => setSummaryLength('academic')}
                      className={`px-4 py-2 text-sm font-medium rounded-pill border transition-colors cursor-pointer flex items-center gap-2 ${
                        summaryLength === 'academic'
                          ? 'bg-ink text-white border-ink'
                          : 'bg-surface text-ink-soft border-line-strong hover:bg-sunken'
                      }`}
                    >
                      <Badge tone="premium">PREMIUM</Badge>
                      <span>{t('academicSummary')}</span>
                    </button>
                  )}
                </div>
                {summaryLength === 'academic' && (
                  <div className="mt-4 p-4 bg-accent-soft border border-line rounded-card">
                    <p className="text-sm text-accent-strong font-medium">
                      {t('academicSummaryDescription')}
                    </p>
                  </div>
                )}
              </div>

              <div className="mt-6">
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileUpload}
                  accept=".pdf"
                  className="hidden"
                />

                <Button
                  size="lg"
                  loading={isLoading}
                  disabled={isLoading || (status === 'authenticated' && usage.used >= usage.limit)}
                  onClick={triggerFileInput}
                >
                  {isLoading ? t('processing') : t('selectPdf')}
                </Button>
              </div>

              {/* What the workspace unlocks */}
              <div className="mt-8 pt-6 border-t border-line">
                <p className="text-xs font-medium text-ink-faint uppercase tracking-wide mb-3">
                  {t('whatYouGet')}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {featureChips.map((chip, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-pill bg-sunken text-xs font-medium text-ink-soft"
                    >
                      <span className="text-accent">{chip.icon}</span>
                      {chip.label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Card>

        {/* While processing: the user doesn't have to sit on this page. Once
            the file reached the server, the summary lands in the Library even
            if they navigate away or close the tab. */}
        {isLoading && (
          <div className="mt-6 flex items-start gap-3 bg-accent-soft border border-line rounded-card p-4 sm:p-5">
            <div className="shrink-0 flex h-9 w-9 items-center justify-center rounded-full bg-surface text-accent">
              <Coffee size={17} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">{t('processingNoticeTitle')}</p>
              <p className="mt-0.5 text-sm text-ink-soft leading-relaxed">{t('processingNotice')}</p>
              <Link
                href="/summaries"
                className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-accent hover:text-accent-strong"
              >
                {t('processingNoticeLink')}
                <ArrowRight size={14} />
              </Link>
            </div>
          </div>
        )}

        {/* Error / fallback result */}
        {(summary || error) && (
          <Card className="mt-8 overflow-hidden">
            <CardBody className="sm:p-8">
              <div className="flex justify-between items-start mb-4">
                <h2 className="text-lg font-semibold text-ink">
                  {summary ? t('generatedSummary') : t('processingError')}
                </h2>

                <button
                  type="button"
                  onClick={() => {
                    setSummary('');
                    setFileName('');
                    setFileSize(0);
                    setError('');
                    setSelectedFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                  className="text-ink-faint hover:text-ink cursor-pointer"
                  aria-label="Close"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {error ? (
                <div className="bg-danger-soft border-l-4 border-danger p-4 rounded-btn">
                  <p className="text-sm font-medium text-danger">{error}</p>
                  <div className="mt-2 text-sm text-ink-soft">
                    <p>{t('recommendations')}</p>
                    <ul className="list-disc pl-5 space-y-1 mt-1">
                      <li>{t('checkConnection')}</li>
                      <li>{t('trySmaller')}</li>
                      <li>{t('contactSupport')}</li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div className="bg-sunken p-5 rounded-card border border-line">
                  <div className="prose max-w-none">
                    <MarkdownContent content={summary} />
                  </div>
                  <div className="mt-6">
                    <Button href="/summaries">
                      {tWorkspace('backToLibrary')}
                      <ArrowRight size={15} />
                    </Button>
                  </div>
                </div>
              )}
            </CardBody>
          </Card>
        )}

        {/* Trust bar */}
        <div className="mt-10 text-center">
          <div className="inline-flex flex-wrap justify-center gap-4 text-sm text-ink-soft">
            <span className="flex items-center gap-1.5">
              <Lock size={14} className="text-accent" />
              {t('secureData')}
            </span>
            <span className="flex items-center gap-1.5">
              <FileText size={14} className="text-accent" />
              {maxSizeMB}{t('limitMB')}
            </span>
            <span className="flex items-center gap-1.5">
              <Zap size={14} className="text-accent" />
              {t('fastProcessing')}
            </span>
          </div>

          <p className="mt-4 text-xs text-ink-faint">
            {t('aiModels')}
          </p>
          <div className="mt-4">
            <Link
              href="/convert-to-pdf"
              className="text-accent hover:text-accent-strong text-sm font-medium inline-flex items-center gap-1"
            >
              {t('noPdf')}
              <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      </div>

      <FeedbackPopup
        show={showFeedback}
        onClose={() => {
          setShowFeedback(false);
        }}
        onSubmit={submitFeedback}
        isSubmitting={isSubmittingFeedback}
        feedbackSubmitted={feedbackSubmitted}
      />
    </div>
  );
}
