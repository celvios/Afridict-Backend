import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { previewAmmQuote, type AmmExposure, type AmmLimits } from '../src/liquidity/amm-model.js';
import { PRICE_SCALE } from '../src/trading/model.js';

const limits: AmmLimits = {
  inventoryLimit: 100n,
  subsidyLimit: 100_000_000n,
  lossLimit: 80_000_000n,
  maxSlippageBps: 500n,
  impactBps: 100n,
  feeBps: 100n,
};
const empty: AmmExposure = { sharesCommitted: 0n, subsidyCommitted: 0n, worstCaseLossCommitted: 0n };

describe('bounded synthetic AMM quote mathematics', () => {
  it('fully collateralizes each quoted contract with exact integer fees', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 100_000, max: 900_000 }),
      fc.constantFrom('buy', 'sell') as fc.Arbitrary<'buy' | 'sell'>, (quantity, reference, side) => {
        const quote = previewAmmQuote(limits, empty, {
          side, quantity: BigInt(quantity), referencePrice: BigInt(reference),
          limitPrice: side === 'buy' ? PRICE_SCALE - 1n : 1n,
        });
        expect(quote.userCollateral + quote.ammCollateral).toBe(BigInt(quantity) * PRICE_SCALE);
        expect(quote.userTotal).toBe(quote.userCollateral + quote.fee);
        expect(quote.nextExposure.worstCaseLossCommitted).toBe(quote.ammCollateral);
        expect(quote.nextExposure.subsidyCommitted).toBe(quote.ammCollateral);
      }), { numRuns: 500 });
  });

  it('charges adverse price impact in the correct direction and enforces user limits', () => {
    const buy = previewAmmQuote(limits, empty,
      { side: 'buy', quantity: 10n, referencePrice: 500_000n, limitPrice: 600_000n });
    const sell = previewAmmQuote(limits, empty,
      { side: 'sell', quantity: 10n, referencePrice: 500_000n, limitPrice: 400_000n });
    expect(buy.price).toBe(500_500n);
    expect(sell.price).toBe(499_500n);
    expect(() => previewAmmQuote(limits, empty,
      { side: 'buy', quantity: 10n, referencePrice: 500_000n, limitPrice: 500_000n }))
      .toThrow('user limit');
    expect(() => previewAmmQuote(limits, empty,
      { side: 'sell', quantity: 10n, referencePrice: 500_000n, limitPrice: 500_000n }))
      .toThrow('user limit');
  });

  it('fails closed at inventory, subsidy, loss and slippage boundaries', () => {
    const request = { side: 'buy' as const, quantity: 1n, referencePrice: 500_000n, limitPrice: 900_000n };
    expect(() => previewAmmQuote(limits, { ...empty, sharesCommitted: 100n }, request)).toThrow('inventory');
    expect(() => previewAmmQuote(limits, { ...empty, subsidyCommitted: 100_000_000n }, request)).toThrow('subsidy');
    expect(() => previewAmmQuote(limits, { ...empty, worstCaseLossCommitted: 80_000_000n }, request)).toThrow('loss');
    expect(() => previewAmmQuote({ ...limits, maxSlippageBps: 0n }, empty, request)).toThrow('slippage');
  });

  it('refuses near-boundary prices, malformed policy and overflow', () => {
    const buy = { side: 'buy' as const, quantity: 100n, referencePrice: 999_999n, limitPrice: 999_999n };
    expect(() => previewAmmQuote(limits, empty, buy)).toThrow('outside payout scale');
    expect(() => previewAmmQuote({ ...limits, lossLimit: 100_000_001n }, empty,
      { side: 'buy', quantity: 1n, referencePrice: 500_000n, limitPrice: 600_000n })).toThrow('Invalid AMM limits');
    expect(() => previewAmmQuote(limits, empty,
      { side: 'buy', quantity: -1n, referencePrice: 500_000n, limitPrice: 600_000n })).toThrow('uint256');
  });
});
