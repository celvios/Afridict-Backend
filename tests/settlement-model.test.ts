import {describe,expect,it} from 'vitest';
import fc from 'fast-check';
import type {Address,Hex} from 'viem';
import {buildSettlementManifest,verifySettlementProof} from '../src/settlement/model.js';

const address=(value:number)=>`0x${value.toString(16).padStart(40,'0')}` as Address;
describe('Robinhood Chain settlement manifests',()=>{
  it('builds proofs that bind every recipient, amount and index to one deterministic root',()=>{
    fc.assert(fc.property(fc.array(fc.bigInt({min:1n,max:10n**18n}),{minLength:1,maxLength:100}),amounts=>{
      const payouts=amounts.map((amount,index)=>({fillId:`fill-${index}`,side:'buyer' as const,
        ownerId:`owner-${index}`,recipient:address(index+1),amount}));
      const one=buildSettlementManifest('11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','3'.repeat(64),payouts);
      const two=buildSettlementManifest('11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','3'.repeat(64),payouts);
      expect(two).toEqual(one);
      expect(one.total).toBe(amounts.reduce((sum,value)=>sum+value,0n));
      for(const item of one.items)expect(verifySettlementProof('11111111-1111-4111-8111-111111111111',item,one.merkleRoot)).toBe(true);
    }),{numRuns:100});
  });

  it('rejects a proof when the amount, recipient, batch or root changes',()=>{
    const manifest=buildSettlementManifest('11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222','3'.repeat(64),[
        {fillId:'a',side:'buyer',ownerId:'one',recipient:address(1),amount:10n},
        {fillId:'b',side:'seller',ownerId:'two',recipient:address(2),amount:20n},
      ]);
    const item=manifest.items[0]!;
    expect(verifySettlementProof('11111111-1111-4111-8111-111111111111',{...item,amount:11n},manifest.merkleRoot)).toBe(false);
    expect(verifySettlementProof('11111111-1111-4111-8111-111111111111',{...item,recipient:address(9)},manifest.merkleRoot)).toBe(false);
    expect(verifySettlementProof('99999999-9999-4999-8999-999999999999',item,manifest.merkleRoot)).toBe(false);
    expect(verifySettlementProof('11111111-1111-4111-8111-111111111111',item,
      `0x${'f'.repeat(64)}` as Hex)).toBe(false);
  });
});
