import { describe, expect, it } from 'vitest'
import { derive } from './derive.js'
import { evaluate } from './evaluate.js'
import { FilterRegistry, type DerivedCtx, type Filter } from './types.js'
import type { SeriesBar, StockMeta } from '../types.js'

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101' }

function series(n: number): SeriesBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026${String(i).padStart(4, '0')}`,
    close: 10,
    volume: 1000,
    ret: i === 0 ? null : 0,
  }))
}

function ctx(): DerivedCtx {
  return derive(META, series(10))
}

function filter(id: string, pass: boolean): Filter {
  return { id, description: id, paramDocs: {}, apply: () => ({ passed: pass, evidence: { [id]: pass ? 1 : 0 } }) }
}

function registry(pairs: [string, boolean][]): FilterRegistry {
  const r = new FilterRegistry()
  for (const [id, pass] of pairs) r.register(filter(id, pass))
  return r
}

describe('evaluate', () => {
  it('evaluates a leaf filter', () => {
    const result = evaluate({ kind: 'filter', filter: 'a' }, ctx(), registry([['a', true]]), {})
    expect(result.passed).toBe(true)
    expect(result.gates).toEqual({ a: true })
    expect(result.failed).toEqual([])
    expect(result.evidence).toEqual({ a: 1 })
  })

  it('ANDs multiple leaves, collecting failed gates', () => {
    const predicate = {
      kind: 'and' as const,
      children: [
        { kind: 'filter' as const, filter: 'a' },
        { kind: 'filter' as const, filter: 'b' },
        { kind: 'filter' as const, filter: 'c' },
      ],
    }
    const result = evaluate(predicate, ctx(), registry([['a', true], ['b', false], ['c', true]]), {})
    expect(result.passed).toBe(false)
    expect(result.failed).toEqual(['b'])
    expect(result.gates).toEqual({ a: true, b: false, c: true })
  })

  it('short-circuits an AND once a child fails', () => {
    const predicate = {
      kind: 'and' as const,
      children: [
        { kind: 'filter' as const, filter: 'a' },
        { kind: 'filter' as const, filter: 'b' },
      ],
    }
    const result = evaluate(predicate, ctx(), registry([['a', false], ['b', true]]), {}, true)
    expect(result.passed).toBe(false)
    // 'b' is never evaluated under short-circuit, so it is absent from gates/evidence.
    expect(result.gates).toEqual({ a: false })
    expect(result.failed).toEqual(['a'])
  })

  it('ORs leaves, passing on the first hit', () => {
    const predicate = {
      kind: 'or' as const,
      children: [
        { kind: 'filter' as const, filter: 'a' },
        { kind: 'filter' as const, filter: 'b' },
      ],
    }
    const result = evaluate(predicate, ctx(), registry([['a', false], ['b', true]]), {})
    expect(result.passed).toBe(true)
    expect(result.failed).toEqual([])
  })

  it('reports every failed leaf when a full OR fails', () => {
    const predicate = {
      kind: 'or' as const,
      children: [
        { kind: 'filter' as const, filter: 'a' },
        { kind: 'filter' as const, filter: 'b' },
      ],
    }
    const result = evaluate(predicate, ctx(), registry([['a', false], ['b', false]]), {})
    expect(result.passed).toBe(false)
    expect(result.failed).toEqual(['a', 'b'])
  })

  it('negates a child without marking its leaf as a failed gate', () => {
    const result = evaluate({ kind: 'not', child: { kind: 'filter', filter: 'a' } }, ctx(), registry([['a', false]]), {})
    expect(result.passed).toBe(true)
    expect(result.gates).toEqual({ a: false })
    expect(result.failed).toEqual([])
  })
})
