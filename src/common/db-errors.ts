import { Prisma } from '../generated/prisma/client.js';

/**
 * Neon is a remote database that suspends when idle and drops idle connections, so some failures are momentary:
 * the next attempt a moment later succeeds. These helpers tell those apart from real errors (bad data, bugs).
 */

/** Socket / DNS errors that mean the database could not be reached at that moment */
const NETWORK_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);

/** Postgres codes for "not now": waking up, shutting down, too many connections, connection failures */
const PG_CODES = new Set(['57P01', '57P02', '57P03', '53300', '08000', '08001', '08003', '08004', '08006']);

/** Prisma codes: unreachable, timed out, connection closed, pool / transaction start timeout, too many connections */
const PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024', 'P2037']);

const MESSAGE =
  /timeout exceeded when trying to connect|connection terminated|connection (?:was )?closed|server has closed the connection|can't reach database|could not connect|socket hang up|unable to start a transaction in the given time|too many connections|terminating connection|Connection terminated unexpectedly|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i;

function codesOf(e: unknown, depth = 0): string[] {
  if (!e || typeof e !== 'object' || depth > 4) return [];
  const err = e as { code?: unknown; cause?: unknown; errors?: unknown[] };
  return [
    ...(typeof err.code === 'string' ? [err.code] : []),
    ...codesOf(err.cause, depth + 1),
    // AggregateError from Node's connect attempts (one per address)
    ...(Array.isArray(err.errors) ? err.errors.flatMap((x) => codesOf(x, depth + 1)) : []),
  ];
}

function messagesOf(e: unknown, depth = 0): string {
  if (!e || typeof e !== 'object' || depth > 4) return '';
  const err = e as { message?: unknown; cause?: unknown };
  return `${typeof err.message === 'string' ? err.message : ''} ${messagesOf(err.cause, depth + 1)}`;
}

/** Could not open a connection at all: nothing reached the database, so trying again is always safe */
export function isConnectError(e: unknown) {
  const codes = codesOf(e);
  if (codes.some((c) => NETWORK_CODES.has(c) || PG_CODES.has(c))) return true;
  return /timeout exceeded when trying to connect|Connection terminated due to connection timeout|connect ETIMEDOUT|getaddrinfo/i.test(messagesOf(e));
}

/** Any momentary database failure (connect or mid-query drop): worth one more try for a read */
export function isTransientDbError(e: unknown) {
  if (e instanceof Prisma.PrismaClientInitializationError) return true;
  if (e instanceof Prisma.PrismaClientKnownRequestError && PRISMA_CODES.has(e.code)) return true;
  if (isConnectError(e)) return true;
  const codes = codesOf(e);
  if (codes.some((c) => PRISMA_CODES.has(c))) return true;
  // Prisma wraps driver errors; fall back to the wording
  if (e instanceof Prisma.PrismaClientUnknownRequestError || e instanceof Prisma.PrismaClientKnownRequestError || e instanceof Error) {
    return MESSAGE.test(messagesOf(e));
  }
  return false;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The last meaningful line of an error message (Prisma prefixes several lines of context) */
export const lastLine = (e: unknown) => (e instanceof Error ? (e.message.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? e.message) : String(e));

/** Waits between tries of a start-up task while the database is unreachable */
const STARTUP_RETRY_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

/**
 * Runs a start-up job (seeding, back-filling) in the background so the API starts even while the database is asleep
 * or unreachable; it is tried again later on a momentary database error. Any other failure is logged, never thrown.
 */
export function runAtStartup(logger: { warn: (m: string) => void; error: (m: string) => void }, name: string, job: () => Promise<unknown>) {
  void (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await job();
        return;
      } catch (e) {
        const msg = lastLine(e);
        if (!isTransientDbError(e) || attempt >= STARTUP_RETRY_MS.length) {
          logger.error(`${name} failed: ${msg}`);
          return;
        }
        logger.warn(`${name}: database not reachable yet, trying again in ${STARTUP_RETRY_MS[attempt] / 1000}s`);
        // unref: a pending retry never keeps the process alive on shutdown / redeploy
        await new Promise((r) => setTimeout(r, STARTUP_RETRY_MS[attempt]).unref());
      }
    }
  })();
}
