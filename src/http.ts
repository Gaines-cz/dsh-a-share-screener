/**
 * Rate-limited JSON fetching with signal-aware retries.
 * @module a-share-screener/http
 */

/**
 * Serial rate limiter: enforces a minimum interval between request starts.
 * Requests queue in call order; an aborted acquire rejects immediately.
 */
export class RateLimiter {
  private nextAt = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly requestsPerMinute: number) {
    if (!Number.isFinite(requestsPerMinute) || requestsPerMinute <= 0) {
      throw new Error(`requestsPerMinute must be a positive number, got ${requestsPerMinute}`)
    }
  }

  /** Wait for this request's slot. Rejects when `signal` aborts while waiting. */
  acquire(signal: AbortSignal): Promise<void> {
    const run = this.queue.then(() => this.wait(signal))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async wait(signal: AbortSignal): Promise<void> {
    const interval = 60_000 / Math.max(1, this.requestsPerMinute)
    const now = Date.now()
    this.nextAt = Math.max(this.nextAt, now)
    const delay = this.nextAt - now
    this.nextAt += interval
    if (delay > 0) await sleep(delay, signal)
  }
}

/** Sleep that rejects with an AbortError when `signal` fires first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError())
    const timer = setTimeout(done, ms)
    function done(): void {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort(): void {
      clearTimeout(timer)
      reject(abortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Standard abort error. */
export function abortError(): Error {
  const err = new Error('aborted')
  err.name = 'AbortError'
  return err
}

export interface FetchJsonOptions {
  url: string
  init?: RequestInit
  limiter: RateLimiter
  signal: AbortSignal
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number
  /** Retries beyond the first attempt (network errors, HTTP 429/5xx). */
  retries?: number
}

/**
 * Fetch and parse JSON with rate limiting, timeout, and retry. HTTP 4xx other
 * than 429 fail immediately; transient failures back off exponentially with
 * jitter. Throws on abort with an AbortError.
 */
export async function fetchJson(options: FetchJsonOptions): Promise<unknown> {
  const res = await fetchWithRetry(options)
  return res.json()
}

/**
 * Fetch raw text with rate limiting, timeout, and retry — for endpoints that
 * answer with non-JSON payloads (e.g. Sina's JSONP kline responses).
 */
export async function fetchText(options: FetchJsonOptions): Promise<string> {
  const res = await fetchWithRetry(options)
  return res.text()
}

/** Shared rate-limited, retrying fetch; callers decode the body themselves. */
async function fetchWithRetry(options: FetchJsonOptions): Promise<Response> {
  const { url, init, limiter, signal } = options
  const timeoutMs = options.timeoutMs ?? 20_000
  const retries = options.retries ?? 3
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal.aborted) throw abortError()
    await limiter.acquire(signal)
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    const signals: AbortSignal[] = [signal, timeoutSignal]
    if (init?.signal) signals.push(init.signal as AbortSignal)
    let permanent = false
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.any(signals) })
      if (res.ok) return res
      lastError = new Error(`HTTP ${res.status} for ${url}`)
      permanent = !(res.status === 429 || res.status >= 500)
    } catch (err) {
      if (signal.aborted) throw abortError()
      lastError = err
      permanent = false
    }
    if (permanent || attempt >= retries) break
    await sleep(Math.min(8_000, 500 * 2 ** attempt) + Math.random() * 250, signal)
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
