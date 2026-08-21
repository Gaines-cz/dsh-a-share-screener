import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFile, rm } from 'node:fs/promises'
import { readJson, writeJson } from './cache.js'

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


