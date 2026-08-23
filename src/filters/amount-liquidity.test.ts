import { describe, expect, it } from 'vitest'
import { derive } from '../engine/derive.js'
import type { SeriesBar, StockMeta } from '../types.js'
import type { StrategyParams } from '../strategies/registry.js'
import { amountLiquidityFilter } from './amount-liquidity.js'

const META: StockMeta = { code: '600001', fullCode: '600001.SH', name: 'X', board: 'main', listDate: '20100101' }

function series(amounts: (number | null | undefined)[]): SeriesBar[] {
  return amounts.map((amount, i) => ({
    date: `202601${String(i).padStart(2, '0')}`,
    close: 10,
    volume: 1000,
    amount: amount ?? null,
    ret: i === 0 ? null : 0,
  }))
}

function params(overrides: Partial<StrategyParams> = {}): StrategyParams {
  return { liquidityWindowBars: 20, minMedianAmountYi: 0.3, ...overrides }
}

describe('amount_liquidity', () => {
  it('passes when the median traded value clears the floor (odd window)', () => {
    // 5 bars of 0.4/0.5/0.6/0.7/0.8亿 → median 0.6亿 >= 0.3亿.
    const amounts = [0.4e8, 0.5e8, 0.6e8, 0.7e8, 0.8e8]
    const result = amountLiquidityFilter.apply(derive(META, series(amounts)), params({ liquidityWindowBars: 5 }))
    expect(result.passed).toBe(true)
    expect(result.evidence.medianAmountYi).toBe(0.6)
  })

  it('averages the two middle values for an even window', () => {
    const amounts = [0.4e8, 0.5e8, 0.7e8, 0.9e8]
    const result = amountLiquidityFilter.apply(derive(META, series(amounts)), params({ liquidityWindowBars: 4 }))
    expect(result.evidence.medianAmountYi).toBe(0.6)
  })

  it('fails below the floor', () => {
    const amounts = [0.05e8, 0.1e8, 0.2e8]
    const result = amountLiquidityFilter.apply(derive(META, series(amounts)), params({ liquidityWindowBars: 3 }))
    expect(result.passed).toBe(false)
    expect(result.evidence.medianAmountYi).toBe(0.1)
  })

  it('measures only the last liquidityWindowBars bars', () => {
    // 10 huge bars then 5 tiny bars: window 5 → median from the tiny tail.
    const amounts = [...Array.from({ length: 10 }, () => 5e8), ...Array.from({ length: 5 }, () => 0.05e8)]
    const result = amountLiquidityFilter.apply(derive(META, series(amounts)), params({ liquidityWindowBars: 5 }))
    expect(result.passed).toBe(false)
    expect(result.evidence.medianAmountYi).toBe(0.05)
  })

  it('skips null-amount bars inside the window and fails with null evidence when none carry amount', () => {
    const mixed = [0.5e8, null, 0.7e8]
    const mixedResult = amountLiquidityFilter.apply(derive(META, series(mixed)), params({ liquidityWindowBars: 3 }))
    expect(mixedResult.evidence.medianAmountYi).toBe(0.6)
    const noData = amountLiquidityFilter.apply(derive(META, series([null, null])), params())
    expect(noData.passed).toBe(false)
    expect(noData.evidence.medianAmountYi).toBeNull()
  })
})
