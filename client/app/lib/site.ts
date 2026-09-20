// Site origin, used for metadataBase, Open Graph URLs, sitemap, and robots.
// Set NEXT_PUBLIC_SITE_URL to the deployed origin; falls back to localhost.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
).replace(/\/$/, '');
