import { describe,expect,it } from 'vitest';
import fc from 'fast-check';
import { terms } from '../scripts/fixtures.js';
import { PRICE_SCALE } from '../src/trading/model.js';
import { payoutForFill,validateResult } from '../src/resolution/model.js';

const fill=(outcome_id:string,quantity:bigint,price:bigint)=>({outcome_id,quantity:quantity.toString(),
  buyer_collateral:(quantity*price).toString(),seller_collateral:(quantity*(PRICE_SCALE-price)).toString()});

describe('resolution payout conservation',()=>{
  it('pays exactly one payout per fill for binary and categorical results',()=>{
    fc.assert(fc.property(fc.bigInt({min:1n,max:10n**18n}),fc.bigInt({min:1n,max:PRICE_SCALE-1n}),
      (quantity,price)=>{
        for(const type of ['binary','categorical'] as const){
          const policy=terms(type),selected=policy.outcomes[0]!.id;
          for(const outcome of policy.outcomes){
            const result=payoutForFill(policy,{kind:'outcome',outcome_id:selected},fill(outcome.id,quantity,price));
            expect(result.buyer+result.seller).toBe(quantity*PRICE_SCALE);
            expect(result.buyer).toBe(outcome.id===selected?quantity*PRICE_SCALE:0n);
          }
        }
      }),{numRuns:500});
  });
  it('returns only recorded collateral on invalid or cancelled outcomes',()=>{
    fc.assert(fc.property(fc.bigInt({min:1n,max:10n**18n}),fc.bigInt({min:1n,max:PRICE_SCALE-1n}),
      (quantity,price)=>{
        for(const kind of ['invalid','cancelled'] as const){
          const result=payoutForFill(terms(),{kind},fill('yes',quantity,price));
          expect(result).toEqual({buyer:quantity*price,seller:quantity*(PRICE_SCALE-price),
            total:quantity*PRICE_SCALE});
        }
      }),{numRuns:500});
  });
  it('splits scalar payout deterministically and gives any rounding remainder to the complement',()=>{
    fc.assert(fc.property(fc.bigInt({min:1n,max:10n**18n}),fc.bigInt({min:-10000n,max:20000n}),
      (quantity,observation)=>{
        const policy=terms('scalar');
        for(const outcome of ['short','long']){
          const result=payoutForFill(policy,{kind:'scalar',observed_value:observation.toString()},
            fill(outcome,quantity,400000n));
          expect(result.buyer+result.seller).toBe(quantity*PRICE_SCALE);
          expect(result.buyer).toBeGreaterThanOrEqual(0n);
          expect(result.seller).toBeGreaterThanOrEqual(0n);
        }
      }),{numRuns:500});
  });
  it('rejects mismatched result types and forged cancellation collateral',()=>{
    expect(()=>validateResult(terms('scalar'),{kind:'outcome',outcome_id:'long'})).toThrow();
    expect(()=>validateResult(terms(),{kind:'scalar',observed_value:'100'})).toThrow();
    expect(()=>payoutForFill(terms(),{kind:'invalid'},
      {outcome_id:'yes',quantity:'1',buyer_collateral:'100',seller_collateral:'100'})).toThrow();
  });
});
