import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./i18n.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    largePageDataBytes: 128 * 100000, // 128KB
  },
  images: {
    domains: ['lh3.googleusercontent.com'],
  },
  // Native/binary server deps that webpack must not try to bundle.
  serverExternalPackages: ['pdf-parse', 'pdfjs-dist', '@napi-rs/canvas'],
  // pdfjs loads standard fonts/cmaps from disk at runtime with dynamic
  // paths, which Vercel's file tracing can't see - include them explicitly
  // for the route that renders diagram pages.
  outputFileTracingIncludes: {
    '/api/summarize': [
      './node_modules/pdfjs-dist/standard_fonts/**',
      './node_modules/pdfjs-dist/cmaps/**',
    ],
  },
};

export default withNextIntl(nextConfig);