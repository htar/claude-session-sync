import { FetchFn } from './oauth';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_WAIT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 5 * 60_000;

export interface RetryOptions {
  /** Extra attempts after the first one. */
  retries?: number;
  /** A request that has not been answered after this long is given up and counts as a dropped connection. */
  timeoutMs?: number;
  /** Replaceable in tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** «Retry-After» in seconds, or undefined. */
function retryAfterMs(res: Response): number | undefined {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, MAX_WAIT_MS) : undefined;
}

/** One request that is aborted when no answer has started within `timeoutMs`: a stalled connection must not hang a sync forever. */
async function withTimeout(
  fetchFn: FetchFn,
  input: Parameters<FetchFn>[0],
  init: Parameters<FetchFn>[1],
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const outer = init?.signal;
  if (outer?.aborted) controller.abort();
  else outer?.addEventListener('abort', () => { controller.abort(); }, { once: true });
  const timer = setTimeout(() => { controller.abort(new Error('The storage did not answer in time.')); }, timeoutMs);
  try {
    return await fetchFn(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A fetch that tries again when the service says «slow down» (429) or fails for a moment (5xx), and when the
 * connection drops. Bodies of our requests are strings or byte arrays, so they can be sent again as they are.
 */
export function retryingFetch(fetchFn: FetchFn, opts: RetryOptions = {}): FetchFn {
  const { retries = 3, sleep = defaultSleep, timeoutMs = REQUEST_TIMEOUT_MS } = opts;
  return async (input, init) => {
    for (let attempt = 0; ; attempt++) {
      const backoff = Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
      try {
        const res = await withTimeout(fetchFn, input, init, timeoutMs);
        if (!RETRY_STATUS.has(res.status) || attempt >= retries) return res;
        await sleep(retryAfterMs(res) ?? backoff);
      } catch (e) {
        if (attempt >= retries) throw e;
        await sleep(backoff);
      }
    }
  };
}
