import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFile, rm } from 'node:fs/promises'
import { readJson, writeJson } from './cache.js'
import { mergeTuples } from './screener.js'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'screener-cache-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('cache', () => {
  it('round-trips JSON and creates parent directories', async () => {
    const dir = await tempDir()
    const file = join(dir, 'nested', 'deeper', 'data.json')
    await writeJson(file, { a: 1, list: [1, 2] })
    expect(await readJson<{ a: number }>(file)).toEqual({ a: 1, list: [1, 2] })
  })

  it('treats missing and corrupt files as absent', async () => {
    const dir = await tempDir()
    expect(await readJson(join(dir, 'missing.json'))).toBeUndefined()
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{not json', 'utf8')
    expect(await readJson(corrupt)).toBeUndefined()
  })
})

describe('mergeTuples', () => {
  const t = (date: string, close: number): [string, number, number, number, number, number, number | null] =>
    ['20250101', 1, 1, 1, close, 100, null].map((v, i) => (i === 0 ? date : v)) as [
      string,
      number,
      number,
      number,
      number,
      number,
      number | null,
    ]

  it('dedupes by date with the incoming value winning, sorted ascending', () => {
    const merged = mergeTuples(
      [t('20250103', 3), t('20250101', 1)],
      [t('20250102', 2), t('20250103', 33)],
    )
    expect(merged.map((tuple) => tuple[0])).toEqual(['20250101', '20250102', '20250103'])
    expect(merged[2]![4]).toBe(33)
  })
})
