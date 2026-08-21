/**
 * Disk cache: atomic JSON persistence under a resolved cache directory.
 * @module a-share-screener/cache
 */
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The dsh home directory (profile root). */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/** Default cache directory for this plugin. */
export function defaultCacheDir(): string {
  return join(dshHome(), 'a-share-screener')
}

/**
 * Read and parse a JSON file. Missing or corrupt files resolve to undefined —
 * the cache self-heals by refetching.
 */
export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return undefined
  }
}

/** Write JSON atomically (tmp file + rename), creating parent directories. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFileSafe(tmp, JSON.stringify(value))
  await rename(tmp, file)
}

async function writeFileSafe(file: string, text: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(file, text, 'utf8')
}

/** Remove a file if it exists. */
export async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true })
}

/** Whether a file (or directory) exists. */
export async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}
