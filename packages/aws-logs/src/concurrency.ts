export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Full-jitter exponential backoff (the AWS-recommended shape). Full jitter
 * beats equal jitter when many callers retry in lockstep, which is exactly
 * what a fan-out across log groups produces.
 */
export function backoffDelay(
  attempt: number,
  baseMs = 200,
  capMs = 20_000,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(Math.random() * exp);
}

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  capMs?: number;
  /** Absolute deadline in epoch ms. Retries stop once passed. */
  deadlineMs?: number;
  isRetryable: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Retry a call that may fail transiently. The AWS SDK already retries at the
 * HTTP layer (adaptive mode); this wraps operations where we need retry policy
 * the SDK does not model — notably StartQuery hitting the account-wide
 * concurrent-query quota, which the SDK treats as a terminal client error.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 5;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (!opts.isRetryable(err)) throw err;
      if (attempt === maxAttempts - 1) break;

      const delay = backoffDelay(attempt, opts.baseMs, opts.capMs);
      if (
        opts.deadlineMs !== undefined &&
        Date.now() + delay >= opts.deadlineMs
      ) {
        break;
      }
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }

  throw lastErr;
}

/**
 * Map with bounded concurrency. Every item resolves to a settled result so one
 * failing log group never discards the results from the others — partial
 * success is the normal case when searching across an account.
 */
export type Settled<R> =
  | { ok: true; value: R; index: number }
  | { ok: false; error: unknown; index: number };

export async function mapSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  const results: Settled<R>[] = new Array(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = {
          ok: true,
          value: await fn(items[index], index),
          index,
        };
      } catch (error) {
        results[index] = { ok: false, error, index };
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/** Split an array into fixed-size chunks (Logs Insights caps at 50 groups/query). */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}
