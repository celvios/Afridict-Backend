import { MAX_UINT256 } from '../financial/model.js';
import { contractCollateral, executionFee, PRICE_SCALE, type OrderSide } from '../trading/model.js';

export interface AmmLimits {
  inventoryLimit: bigint;
  subsidyLimit: bigint;
  lossLimit: bigint;
  maxSlippageBps: bigint;
  impactBps: bigint;
  feeBps: bigint;
}

export interface AmmExposure {
  sharesCommitted: bigint;
  subsidyCommitted: bigint;
  worstCaseLossCommitted: bigint;
}

export interface AmmRequest {
  side: OrderSide;
  quantity: bigint;
  referencePrice: bigint;
  limitPrice: bigint;
  contractUnit?:bigint;
}

const ceilDiv = (value: bigint, divisor: bigint) => (value + divisor - 1n) / divisor;

function bounded(value: bigint, name: string) {
  if (value < 0n || value > MAX_UINT256) throw new Error(`${name} must fit uint256`);
}

/**
 * A conservative quote preview. The caller must supply an approved, fresh,
 * server-owned reference price and atomically reserve the returned exposure.
 * This function does not authorize or post a trade.
 */
export function previewAmmQuote(limits: AmmLimits, exposure: AmmExposure, request: AmmRequest) {
  for (const [name, value] of Object.entries({ ...limits, ...exposure, ...request })) {
    if (typeof value === 'bigint') bounded(value, name);
  }
  if (limits.inventoryLimit === 0n || limits.subsidyLimit === 0n || limits.lossLimit === 0n ||
    limits.lossLimit > limits.subsidyLimit || limits.maxSlippageBps > 10_000n ||
    limits.impactBps > 10_000n || limits.feeBps > 1_000n) throw new Error('Invalid AMM limits');
  if (request.side !== 'buy' && request.side !== 'sell') throw new Error('Invalid AMM side');
  if (request.quantity === 0n || request.referencePrice === 0n || request.referencePrice >= PRICE_SCALE ||
    request.limitPrice === 0n || request.limitPrice >= PRICE_SCALE) throw new Error('Invalid AMM request');
  if (exposure.sharesCommitted > limits.inventoryLimit || exposure.subsidyCommitted > limits.subsidyLimit ||
    exposure.worstCaseLossCommitted > limits.lossLimit) throw new Error('Existing AMM exposure exceeds policy');

  const nextShares = exposure.sharesCommitted + request.quantity;
  if (nextShares > limits.inventoryLimit) throw new Error('AMM inventory limit exceeded');

  const impact = ceilDiv(request.referencePrice * limits.impactBps * request.quantity,
    limits.inventoryLimit * 10_000n);
  const price = request.side === 'buy' ? request.referencePrice + impact : request.referencePrice - impact;
  if (price <= 0n || price >= PRICE_SCALE) throw new Error('AMM price outside payout scale');
  if ((price > request.referencePrice ? price - request.referencePrice : request.referencePrice - price) * 10_000n >
    request.referencePrice * limits.maxSlippageBps) throw new Error('AMM slippage limit exceeded');
  if ((request.side === 'buy' && price > request.limitPrice) ||
    (request.side === 'sell' && price < request.limitPrice)) throw new Error('AMM price violates user limit');

  const contractUnit=request.contractUnit??PRICE_SCALE;
  const collateral=contractCollateral(request.quantity,price,contractUnit);
  const userCollateral = request.side === 'buy' ? collateral.buyer : collateral.seller;
  const ammCollateral = request.side === 'buy' ? collateral.seller : collateral.buyer;
  const fee=executionFee(request.side,request.quantity,price,limits.feeBps,contractUnit);
  const userTotal = userCollateral + fee;
  const nextSubsidy = exposure.subsidyCommitted + ammCollateral;
  const nextLoss = exposure.worstCaseLossCommitted + ammCollateral;
  if (userTotal > MAX_UINT256 || collateral.total > MAX_UINT256 || nextSubsidy > MAX_UINT256 || nextLoss > MAX_UINT256)
    throw new Error('AMM quote exceeds uint256');
  if (nextSubsidy > limits.subsidyLimit || nextLoss > limits.lossLimit)
    throw new Error('AMM subsidy or worst-case loss limit exceeded');

  return {
    price,
    quantity: request.quantity,
    userCollateral,
    ammCollateral,
    fee,
    userTotal,
    nextExposure: {
      sharesCommitted: nextShares,
      subsidyCommitted: nextSubsidy,
      worstCaseLossCommitted: nextLoss,
    } satisfies AmmExposure,
  };
}
