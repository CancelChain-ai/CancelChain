/**
 * Guard shared by every service that opens a database pool (`api`, `indexer`).
 *
 * Supabase free tier gives **two direct connections for all services**, and
 * there are two services — the second one would not start. Both therefore go
 * through the transaction pooler, which in turn cannot keep prepared
 * statements (hence `prepare: false` wherever a pool is created).
 */
export const POOLER_PORT = 6543

export function postgresUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    return url.protocol === 'postgres:' || url.protocol === 'postgresql:' ? url : null
  } catch {
    return null
  }
}

/** `''` — the URL names no port (the driver's default 5432); `null` — not a postgres URL. */
export function databasePort(databaseUrl: string): string | null {
  return postgresUrl(databaseUrl)?.port ?? null
}

export class DirectDatabaseConnectionError extends Error {
  constructor(port: string) {
    super(
      `DATABASE_URL points at port ${port || '(default)'}, not the transaction pooler ` +
        `(${POOLER_PORT}). Supabase free tier gives 2 direct connections for both services. ` +
        'Set ALLOW_DIRECT_DATABASE=true to opt in explicitly.',
    )
    this.name = 'DirectDatabaseConnectionError'
  }
}

/** Throws unless the URL goes through the pooler or a direct connection is explicitly allowed. */
export function assertPooledDatabaseUrl(databaseUrl: string, allowDirect: boolean): void {
  if (allowDirect) return
  const port = databasePort(databaseUrl)
  if (port !== String(POOLER_PORT)) throw new DirectDatabaseConnectionError(port ?? '')
}
