import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { PRICE_SCALE, contractCollateral, matchPriceTime, parsePrice, reservationRequired } from '../src/trading/model.js';

describe('deterministic CLOB reference mathematics', () => {
  it('fully collateralizes every contract without floating point', () => {
    fc.assert(fc.property(
      fc.bigInt({ min: 2n, max: 10n ** 24n }),
      fc.bigInt({ min: 1n, max: PRICE_SCALE - 1n }),
      (quantity, price) => {
        const collateral = contractCollateral(quantity, price);
        expect(collateral.buyer + collateral.seller).toBe(quantity * PRICE_SCALE);
        expect(collateral.buyer).toBeGreaterThan(0n);
        expect(collateral.seller).toBeGreaterThan(0n);
      },
    ), { numRuns: 1000 });
  });

  it('reserves each side at its worst executable limit price including fees', () => {
    const buy = reservationRequired('buy', 10n, 600_000n, 100n);
    const sell = reservationRequired('sell', 10n, 600_000n, 100n);
    expect(buy).toEqual({ collateral: 6_000_000n, fee: 60_000n, total: 6_060_000n });
    expect(sell).toEqual({ collateral: 4_000_000n, fee: 40_000n, total: 4_040_000n });
    expect(buy.collateral + sell.collateral).toBe(10_000_000n);
    const chunks = [1n, 3n, 6n].map(q => reservationRequired('buy', q, 600_000n, 100n).total);
    expect(chunks.reduce((a, b) => a + b, 0n)).toBe(buy.total);
  });

  it('matches best price first and preserves sequence at the same price', () => {
    const result = matchPriceTime('buy', 650_000n, 12n, [
      { id: 'later', side: 'sell', price: 600_000n, remaining: 5n, sequence: 3n },
      { id: 'best', side: 'sell', price: 550_000n, remaining: 4n, sequence: 2n },
      { id: 'earlier', side: 'sell', price: 600_000n, remaining: 6n, sequence: 1n },
      { id: 'outside', side: 'sell', price: 700_000n, remaining: 99n, sequence: 0n },
    ]);
    expect(result.matches.map(fill => fill.makerId)).toEqual(['best', 'earlier', 'later']);
    expect(result.matches.map(fill => fill.quantity)).toEqual([4n, 6n, 2n]);
    expect(result.remaining).toBe(0n);
  });

  it('uses the resting order price and leaves unmatched quantity open', () => {
    expect(matchPriceTime('sell', 400_000n, 10n, [
      { id: 'bid', side: 'buy', price: 450_000n, remaining: 3n, sequence: 1n },
    ])).toEqual({ matches: [{ makerId: 'bid', quantity: 3n, price: 450_000n }], remaining: 7n });
  });

  it('rejects boundary and noncanonical prices', () => {
    for (const value of ['0', '01', '-1', '1.2', PRICE_SCALE.toString()]) expect(() => parsePrice(value)).toThrow();
  });
});
