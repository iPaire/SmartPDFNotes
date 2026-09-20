// Site origin, used for metadataBase, Open Graph URLs, sitemap, and robots.
// Uses NEXT_PUBLIC_SITE_URL when set, then the Vercel production URL, then localhost.
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : undefined;

export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || vercelUrl || 'http://localhost:3000'
).replace(/\/$/, '');
