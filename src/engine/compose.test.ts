import { describe, expect, it } from 'vitest'
import { composeStrategy, mergedParamDocs } from './compose.js'
import { FilterRegistry, type Filter } from './types.js'
import { createFilterRegistry } from '../filters/index.js'
import type { ParamDoc } from '../strategies/registry.js'
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

const input = { stock: META, bars: series(10) }

function filter(
  id: string,
  pass: boolean,
  paramDocs: Record<string, ParamDoc> = {},
  evidence: Record<string, number | string | boolean | null> = {},
): Filter {
  return { id, description: id, paramDocs, apply: () => ({ passed: pass, evidence }) }
}

function registry(...filters: Filter[]): FilterRegistry {
  const r = new FilterRegistry()
  for (const f of filters) r.register(f)
  return r
}

const and = (...ids: string[]) => ({
  kind: 'and' as const,
  children: ids.map((id) => ({ kind: 'filter' as const, filter: id })),
})

describe('mergedParamDocs', () => {
  it('deduplicates identical declarations shared by two filters', () => {
    const shared: ParamDoc = { type: 'number', default: 5, min: 1, max: 10, integer: true, description: 'shared' }
    const r = registry(filter('a', true, { shared }), filter('b', true, { shared }))
    const docs = mergedParamDocs(and('a', 'b'), r)
    expect(Object.keys(docs)).toEqual(['shared'])
  })

  it('deduplicates declarations that differ only in key insertion order', () => {
    const r = registry(
      filter('a', true, { shared: { type: 'number', default: 5, min: 1, description: 'shared' } }),
      filter('b', true, { shared: { description: 'shared', min: 1, default: 5, type: 'number' } }),
    )
    expect(() => mergedParamDocs(and('a', 'b'), r)).not.toThrow()
  })

  it('throws loudly on conflicting declarations of the same key', () => {
    const r = registry(
      filter('a', true, { shared: { type: 'number', default: 5, description: 'x' } }),
      filter('b', true, { shared: { type: 'number', default: 6, description: 'x' } }),
    )
    expect(() => mergedParamDocs(and('a', 'b'), r)).toThrow(/param collision 'shared'/)
  })

  it('merges the real limit-up search params shared by volume_limit_up and cooldown_pullback', () => {
    const docs = mergedParamDocs(and('volume_limit_up', 'cooldown_pullback'), createFilterRegistry())
    expect(docs.limitUpWindowBars?.default).toBe(120)
    expect(docs.cooldownBars?.default).toBe(5)
  })

  it('merges strategy-level extra docs after filter docs', () => {
    const r = registry(filter('a', true, { shared: { type: 'number', default: 5, description: 'x' } }))
    const docs = mergedParamDocs({ kind: 'filter', filter: 'a' }, r, {
      minBars: { type: 'number', default: 240, min: 60, max: 3000, integer: true, description: 'extra' },
    })
    expect(docs.minBars?.default).toBe(240)
    expect(docs.shared?.default).toBe(5)
  })
})

describe('composeStrategy', () => {
  it('screen on an OR tree short-circuits, so the passing hit lacks sibling evidence', () => {
    // Documents the cast assumption in compose.screen: for OR/NOT trees the
    // merged evidence of a strict hit may be missing sibling keys ('b' is never
    // evaluated once 'a' passes under short-circuit).
    const r = registry(filter('a', true, {}, { aVal: 1 }), filter('b', false, {}, { bVal: 0 }))
    const strategy = composeStrategy({
      id: 'or_strategy',
      description: 'test',
      predicate: { kind: 'or', children: [{ kind: 'filter', filter: 'a' }, { kind: 'filter', filter: 'b' }] },
      filters: r,
    })
    const hit = strategy.screen(input, {})
    expect(hit?.evidence).toEqual({ aVal: 1, close: 10, barsAnalyzed: 10 })
  })

  it('diagnose keeps raw leaf gates under a NOT and reports no failed gate', () => {
    // NOT(false) passes, but gates still carry the leaf's raw truth value and
    // the failed list stays empty — the near-miss blind spot documented on
    // PredicateResult.failed.
    const r = registry(filter('a', false))
    const strategy = composeStrategy({
      id: 'not_strategy',
      description: 'test',
      predicate: { kind: 'not', child: { kind: 'filter', filter: 'a' } },
      filters: r,
    })
    const diag = strategy.diagnose?.(input, {})
    expect(diag?.matched).toBe(true)
    expect(diag?.gates).toEqual({ a: false })
    expect(diag?.failedGates).toEqual([])
  })

  it('returns null from screen and diagnose when canEvaluate is false', () => {
    const strategy = composeStrategy({
      id: 'gated',
      description: 'test',
      predicate: { kind: 'filter', filter: 'a' },
      filters: registry(filter('a', true)),
      canEvaluate: () => false,
    })
    expect(strategy.screen(input, {})).toBeNull()
    expect(strategy.diagnose?.(input, {})).toBeNull()
  })
})

describe('composeStrategy data requirements', () => {
  it('unions the leaf filters\' requires into the strategy', () => {
    const needIndustry = { ...filter('ind', true), requires: { industry: true } }
    const needAmount = { ...filter('amt', true), requires: { amount: true } }
    const plain = filter('plain', true)
    const r = registry(needIndustry as Filter, needAmount as Filter, plain)
    const strategy = composeStrategy({ id: 'x', description: 'd', predicate: and('ind', 'amt', 'plain'), filters: r })
    expect(strategy.requires).toEqual({ industry: true, amount: true })
    const none = composeStrategy({ id: 'y', description: 'd', predicate: and('plain'), filters: r })
    expect(none.requires).toBeUndefined()
  })

  it('carries industry stats from the screen input into the derived context', () => {
    const seen: (string | undefined)[] = []
    const spy: Filter = {
      id: 'spy',
      description: 'spy',
      paramDocs: {},
      apply: (ctx) => {
        seen.push(ctx.industry?.industry)
        return { passed: true, evidence: { ok: 1 } }
      },
    }
    const r = registry(spy)
    const strategy = composeStrategy({ id: 'z', description: 'd', predicate: { kind: 'filter', filter: 'spy' }, filters: r })
    strategy.screen(
      { ...input, industryStats: { industry: '银行', members: 10, medDrawdown: 0.5, medPos: 0.3, deepShare: 0.4 } },
      {},
    )
    expect(seen).toEqual(['银行'])
  })
})

describe('composeStrategy hit evidence', () => {
  it('drops null evidence from passing OR trees (short-circuited sibling)', () => {
    const passing = filter('pass', true, {}, { good: 1 })
    const failing = filter('fail', false, {}, { bad: null })
    const r = registry(passing, failing)
    const strategy = composeStrategy({
      id: 'or-strategy',
      description: 'd',
      predicate: { kind: 'or', children: [{ kind: 'filter', filter: 'pass' }, { kind: 'filter', filter: 'fail' }] },
      filters: r,
    })
    const hit = strategy.screen(input, {})
    expect(hit).not.toBeNull()
    // The failing sibling's null evidence must not leak into the hit.
    expect(hit!.evidence.bad).toBeUndefined()
    expect(hit!.evidence.good).toBe(1)
    // Diagnosis still keeps the null for near-miss reporting.
    const diag = strategy.diagnose!(input, {})
    expect(diag!.metrics.bad).toBeNull()
  })
})

describe('derive index floor (defensive)', () => {
  it('clamps a corrupt ret <= -1 to a strictly positive chain', async () => {
    const { derive } = await import('./derive.js')
    const bad = series(4)
    bad[1] = { ...bad[1]!, ret: -1.5 } // corrupt: -150% in one bar
    bad[2] = { ...bad[2]!, ret: 0 }
    bad[3] = { ...bad[3]!, ret: 0 }
    const ctx = derive(META, bad)
    // Every idx value stays > 0, so downstream ratios cannot divide by zero.
    for (const value of ctx.idx) {
      expect(value).toBeGreaterThan(0)
    }
  })
})
