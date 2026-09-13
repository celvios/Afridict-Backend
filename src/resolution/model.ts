import type { MarketTerms } from '../contracts.js';
import { integer, scalarVector } from '../financial/model.js';
import { PRICE_SCALE } from '../trading/model.js';

export type ResolutionResult =
  | { kind:'outcome'; outcome_id:string }
  | { kind:'scalar'; observed_value:string }
  | { kind:'invalid' }
  | { kind:'cancelled' };

export function validateResult(terms:MarketTerms,result:ResolutionResult) {
  if (result.kind==='outcome') {
    if (terms.market_type==='scalar' || !terms.outcomes.some(o=>o.id===result.outcome_id))
      throw new Error('Invalid discrete outcome');
  } else if (result.kind==='scalar') {
    if (terms.market_type!=='scalar' || !terms.scalar_range || !/^(0|-?[1-9][0-9]*)$/.test(result.observed_value))
      throw new Error('Invalid scalar observation');
    const observed=BigInt(result.observed_value);
    if (observed<-(1n<<255n) || observed>(1n<<255n)-1n) throw new Error('Scalar observation exceeds int256');
  } else if (result.kind!=='invalid' && result.kind!=='cancelled') throw new Error('Unknown result');
}

export function payoutForFill(terms:MarketTerms,result:ResolutionResult,fill:{outcome_id:string;
  quantity:string;buyer_collateral:string;seller_collateral:string}) {
  validateResult(terms,result);
  const quantity=integer(fill.quantity),total=quantity*PRICE_SCALE;
  if (result.kind==='invalid' || result.kind==='cancelled') {
    const buyer=integer(fill.buyer_collateral),seller=integer(fill.seller_collateral);
    if (buyer+seller!==total) throw new Error('Recorded collateral does not cover the fill');
    return {buyer,seller,total};
  }
  if (result.kind==='outcome') {
    const buyer=result.outcome_id===fill.outcome_id?total:0n;
    return {buyer,seller:total-buyer,total};
  }
  const range=terms.scalar_range!;
  const {denominator,weights}=scalarVector(BigInt(result.observed_value),BigInt(range.lower),BigInt(range.upper));
  const weight=fill.outcome_id==='long'?weights[1]:fill.outcome_id==='short'?weights[0]:undefined;
  if (weight===undefined) throw new Error('Invalid scalar outcome in fill');
  const buyer=total*weight/denominator;
  return {buyer,seller:total-buyer,total};
}
