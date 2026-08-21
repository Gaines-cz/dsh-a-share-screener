/**
 * Eastmoney board (板块) resolution for the CLI's `--board` scope: find the
 * board id by exact name across 行业 (t:2) and 概念 (t:3) board lists, then
 * return its member codes. Free public endpoint (push2delay clist), the same
 * data the free sources carry — no industry classification needed.
 * @module a-share-screener/datasources/boards
 */
import { fetchJson, RateLimiter } from '../http.js'

interface BoardEntry {
  f12?: string
  f14?: string
}

interface ListResponse {
  data?: { total?: number; diff?: BoardEntry[] | Record<string, BoardEntry> }
}

const BOARD_LIST_FS: Record<'industry' | 'concept', string> = {
  industry: 'm:90+t:2',
  concept: 'm:90+t:3',
}
const MAX_PAGES = 20

async function listBoards(fs: string, limiter: RateLimiter, signal: AbortSignal): Promise<BoardEntry[]> {
  const out: BoardEntry[] = []
  let page = 1
  for (;;) {
    if (signal.aborted) throw new Error('aborted')
    const url =
      `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3` +
      `&fs=${encodeURIComponent(fs)}&fields=f12,f14`
    const json = (await fetchJson({ url, limiter, signal, retries: 1 })) as ListResponse
    const diff = json.data?.diff
    const entries = Array.isArray(diff) ? diff : Object.values(diff ?? {})
    if (entries.length === 0) break
    out.push(...entries)
    if (entries.length < 100 || page >= MAX_PAGES) break
    page++
  }
  return out
}

async function listMembers(boardId: string, limiter: RateLimiter, signal: AbortSignal): Promise<string[]> {
  const codes: string[] = []
  let page = 1
  for (;;) {
    if (signal.aborted) throw new Error('aborted')
    const url =
      `https://push2delay.eastmoney.com/api/qt/clist/get?pn=${page}&pz=100&po=1&np=1&fltt=2&invt=2&fid=f3` +
      `&fs=${encodeURIComponent(`b:${boardId}`)}&fields=f12,f14`
    const json = (await fetchJson({ url, limiter, signal, retries: 1 })) as ListResponse
    const diff = json.data?.diff
    const entries = Array.isArray(diff) ? diff : Object.values(diff ?? {})
    if (entries.length === 0) break
    for (const entry of entries) {
      const code = String(entry.f12 ?? '')
      if (/^\d{6}$/.test(code)) codes.push(code)
    }
    if (entries.length < 100 || page >= MAX_PAGES) break
    page++
  }
  return codes
}

export interface BoardHit {
  id: string
  name: string
  kind: 'industry' | 'concept'
}

/** Exact-name board lookup across industry and concept lists. */
export async function findBoard(name: string, limiter: RateLimiter, signal: AbortSignal): Promise<BoardHit[] | null> {
  const wanted = name.trim()
  const hits: BoardHit[] = []
  for (const [kind, fs] of Object.entries(BOARD_LIST_FS) as [keyof typeof BOARD_LIST_FS, string][]) {
    const boards = await listBoards(fs, limiter, signal)
    for (const board of boards) {
      if ((board.f14 ?? '').trim() === wanted) hits.push({ id: board.f12 ?? '', name: board.f14 ?? '', kind })
    }
  }
  return hits.length > 0 ? hits : null
}

/** Member 6-digit codes of one board (union across matched boards by caller). */
export async function boardMemberCodes(boardId: string, limiter: RateLimiter, signal: AbortSignal): Promise<string[]> {
  return listMembers(boardId, limiter, signal)
}

/** Fuzzy suggestions when an exact board name has no match (for error hints). */
export async function suggestBoards(keyword: string, limiter: RateLimiter, signal: AbortSignal): Promise<string[]> {
  const out = new Set<string>()
  for (const fs of Object.values(BOARD_LIST_FS)) {
    const boards = await listBoards(fs, limiter, signal)
    for (const board of boards) {
      const name = board.f14 ?? ''
      if (name.includes(keyword.trim())) {
        out.add(name)
        if (out.size >= 10) return [...out]
      }
    }
  }
  return [...out]
}
