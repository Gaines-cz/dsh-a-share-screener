import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchJson, RateLimiter, sleep } from './http.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RateLimiter', () => {
  it('spreads request starts by the configured interval', async () => {
    const limiter = new RateLimiter(6000) // one request per 10ms
    const controller = new AbortController()
    const start = Date.now()
    await limiter.acquire(controller.signal)
    await limiter.acquire(controller.signal)
    await limiter.acquire(controller.signal)
    expect(Date.now() - start).toBeGreaterThanOrEqual(20)
  })

  it('rejects waiting acquires on abort', async () => {
    const limiter = new RateLimiter(1) // one per minute → long wait
    const controller = new AbortController()
    await limiter.acquire(controller.signal)
    const second = limiter.acquire(controller.signal)
    controller.abort()
    await expect(second).rejects.toThrow(/aborted/)
  })
})

describe('sleep', () => {
  it('resolves after the delay and rejects on abort', async () => {
    const start = Date.now()
    await sleep(20, new AbortController().signal)
    expect(Date.now() - start).toBeGreaterThanOrEqual(15)
    const controller = new AbortController()
    controller.abort()
    await expect(sleep(20, controller.signal)).rejects.toThrow(/aborted/)
  })
})

describe('fetchJson', () => {
  it('retries network errors and succeeds on a later attempt', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const limiter = new RateLimiter(600_000)
    const value = (await fetchJson({
      url: 'https://example.test',
      limiter,
      signal: new AbortController().signal,
    })) as { ok: boolean }
    expect(value.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('fails fast on permanent HTTP 4xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)
    const limiter = new RateLimiter(600_000)
    await expect(
      fetchJson({ url: 'https://example.test', limiter, signal: new AbortController().signal }),
    ).rejects.toThrow(/HTTP 404/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries HTTP 429 with backoff then gives up', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    const limiter = new RateLimiter(600_000)
    await expect(
      fetchJson({
        url: 'https://example.test',
        limiter,
        signal: new AbortController().signal,
        retries: 1,
      }),
    ).rejects.toThrow(/HTTP 429/)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
