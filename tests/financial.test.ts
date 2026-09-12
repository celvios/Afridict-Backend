import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { integer, redemption, reserveCost, scalarVector, validateJournal, MAX_UINT256 } from '../src/financial/model.js';
import { validateTerms } from '../src/markets/domain.js';
import { terms } from '../scripts/fixtures.js';

describe('exact financial reference mathematics', () => {
  it('never accepts floating point, noncanonical or out-of-range integers', () => {
    for (const bad of ['0.1','1e4','01','-1','+1',' 1','NaN']) expect(() => integer(bad)).toThrow();
    expect(integer(MAX_UINT256.toString())).toBe(MAX_UINT256);
    expect(() => integer((MAX_UINT256 + 1n).toString())).toThrow();
  });
  it('reserves a conservative notional and fee with no float conversion', () => {
    fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 18n }), fc.bigInt({ min: 0n, max: 10n ** 6n }),
      fc.integer({ min: 0, max: 1000 }), (quantity, price, feeBps) => {
        const scale = 10n ** 6n;
        const result = reserveCost(quantity, price, scale, BigInt(feeBps));
        expect(result.notional * scale).toBeGreaterThanOrEqual(quantity * price);
        expect(result.total).toBe(result.notional + result.fee);
        expect(result.fee * 10000n).toBeGreaterThanOrEqual(result.notional * BigInt(feeBps));
      }), { numRuns: 500 });
  });
  it('balances every asset separately and rejects impossible postings', () => {
    validateJournal([{ asset: 'A', account: 'asset', debit: 100n, credit: 0n },
      { asset: 'A', account: 'liability', debit: 0n, credit: 100n }]);
    expect(() => validateJournal([{ asset: 'A', account: 'asset', debit: 100n, credit: 0n },
      { asset: 'B', account: 'liability', debit: 0n, credit: 100n }])).toThrow();
    expect(() => validateJournal([{ asset: 'A', account: 'asset', debit: 1n, credit: 1n }])).toThrow();
  });
  it('keeps scalar weights conservative and exposes payout remainder', () => {
    fc.assert(fc.property(fc.bigInt({ min: -10000n, max: 20000n }), fc.bigInt({ min: 0n, max: 1000000n }), (observed, quantity) => {
      const { weights, denominator } = scalarVector(observed, 0n, 10000n);
      expect(weights[0]! + weights[1]!).toBe(denominator);
      const a = redemption(quantity, weights[0]!, denominator), b = redemption(quantity, weights[1]!, denominator);
      expect(a.payout + b.payout).toBeLessThanOrEqual(quantity);
      expect((a.payout + b.payout) * denominator + a.remainder + b.remainder).toBe(quantity * denominator);
    }), { numRuns: 500 });
  });
  it('rejects a scalar range whose bounds are reversed', () => {
    const t = terms('scalar'); t.scalar_range = { ...t.scalar_range!, lower: '10', upper: '0' };
    expect(() => validateTerms(t)).toThrow();
  });
});
