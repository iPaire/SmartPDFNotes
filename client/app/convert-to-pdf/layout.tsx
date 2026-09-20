// Server layout for /convert-to-pdf. The page itself is a client component and
// cannot export metadata, so the SEO tags live here. This wrapper also injects
// FAQ structured data for rich results.
import type { Metadata } from 'next';
import { SITE_URL } from '@/lib/site';

const TITLE = 'Convert to PDF Online - Free Image, Word & Text to PDF';
const DESCRIPTION =
  'Convert JPG, PNG, Word (DOCX), and text files to PDF online for free. Fast, browser-based, no signup - drag, drop, and download your PDF in seconds.';
const PATH = '/convert-to-pdf';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    'convert to pdf',
    'convert to pdf online free',
    'image to pdf',
    'jpg to pdf',
    'png to pdf',
    'word to pdf',
    'docx to pdf',
    'txt to pdf',
    'free pdf converter',
  ],
  alternates: { canonical: PATH },
  openGraph: {
    type: 'website',
    url: `${SITE_URL}${PATH}`,
    siteName: 'SmartPDF Notes',
    title: 'Convert to PDF Online - Free & Fast',
    description:
      'Turn images, Word docs, and text files into a clean PDF in seconds. Free, no signup, no watermarks.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Convert to PDF Online - Free & Fast',
    description:
      'Turn images, Word docs, and text files into a clean PDF in seconds. Free, no signup, no watermarks.',
  },
};

// FAQ rich-result data. Answers must stay truthful: conversion is free and
// unauthenticated, and files are processed in memory and not persisted.
const faqJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'FAQPage',
  mainEntity: [
    {
      '@type': 'Question',
      name: 'Is this PDF converter free?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Yes - converting to PDF is completely free, with no watermarks or sign-up required.',
      },
    },
    {
      '@type': 'Question',
      name: 'What files can I convert?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'JPG and PNG images, Word documents (.docx), and plain text (.txt). You can combine multiple images into one PDF.',
      },
    },
    {
      '@type': 'Question',
      name: 'Are my files safe?',
      acceptedAnswer: {
        '@type': 'Answer',
        text: 'Files are processed on demand to generate your PDF and are not stored afterward.',
      },
    },
  ],
};

export default function ConvertToPdfLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
      />
      {children}
    </>
  );
}
