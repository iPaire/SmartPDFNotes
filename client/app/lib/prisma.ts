import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

/**
 * Supabase's transaction-mode pooler (port 6543) multiplexes many clients
 * over few server connections, so Prisma MUST run with pgbouncer=true
 * (disables prepared statements - otherwise: `prepared statement "s2"
 * already exists`, error 42P05). Appending the flags here makes that hold
 * even when the env var was set without the query-string suffix.
 */
function runtimeDatabaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url || !url.includes(':6543') || url.includes('pgbouncer=true')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}pgbouncer=true&connection_limit=1`;
}

const prisma = globalForPrisma.prisma || new PrismaClient({
  datasources: { db: { url: runtimeDatabaseUrl() } },
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error']
})

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma

export default prisma
