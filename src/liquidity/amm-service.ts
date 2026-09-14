import { randomUUID } from 'node:crypto';
import type { Account } from '../identity/auth.js';
import { accountAssurance } from '../identity/capabilities.js';
import { accountBalance, ledgerAccount, lockOwnerAsset, postJournal } from '../financial/ledger.js';
import { reserve } from '../financial/reservations.js';
import { getMarket } from '../markets/service.js';
import type { Sql } from '../platform/database.js';
import { requireCondition } from '../platform/errors.js';
import { parseOrderAmount, parsePrice, type OrderSide } from '../trading/model.js';
import { previewAmmQuote, type AmmExposure, type AmmLimits } from './amm-model.js';

interface PoolRow {
  market_id:string;outcome_id:string;asset_code:string;status:'open'|'halted';inventory_limit:string;
  subsidy_limit:string;loss_limit:string;max_slippage_bps:number;impact_bps:number;fee_bps:number;
  shares_committed:string;subsidy_committed:string;worst_case_loss_committed:string;funded_minor:string;
}
interface ReferenceRow {id:string;market_id:string;outcome_id:string;price:string;observed_at:Date;expires_at:Date;source_ref:string}
interface QuoteRow {id:string;owner_id:string;market_id:string;outcome_id:string;side:OrderSide;quantity:string;
  reference_price_id:string;price:string;user_collateral:string;amm_collateral:string;fee:string;user_total:string;
  expires_at:Date;state:'quoted'|'executed'|'expired';created_at:Date;executed_at:Date|null}

const limits=(row:PoolRow):AmmLimits=>({inventoryLimit:BigInt(row.inventory_limit),subsidyLimit:BigInt(row.subsidy_limit),
  lossLimit:BigInt(row.loss_limit),maxSlippageBps:BigInt(row.max_slippage_bps),impactBps:BigInt(row.impact_bps),
  feeBps:BigInt(row.fee_bps)});
const exposure=(row:PoolRow):AmmExposure=>({sharesCommitted:BigInt(row.shares_committed),
  subsidyCommitted:BigInt(row.subsidy_committed),worstCaseLossCommitted:BigInt(row.worst_case_loss_committed)});
const publicQuote=(row:QuoteRow)=>({...row,expires_at:new Date(row.expires_at).toISOString(),created_at:new Date(row.created_at).toISOString(),
  executed_at:row.executed_at?new Date(row.executed_at).toISOString():null});

export async function activateAmm(sql:Sql,actor:Account,marketId:string,outcomeId:string,asset:string,impactBps:number){
  const market=await getMarket(sql,marketId,true);
  requireCondition(market.state==='scheduled'&&market.published_at&&market.terms.liquidity.amm_enabled,
    409,'AMM_NOT_APPROVED','The published market does not approve an AMM backstop.');
  requireCondition(market.terms.outcomes.some(outcome=>outcome.id===outcomeId),422,'INVALID_OUTCOME','Choose a published outcome.');
  const binding=(await sql.query<{approved:boolean;synthetic:boolean}>(`SELECT b.approved,a.synthetic FROM clob_asset_bindings b
    JOIN financial_assets a ON a.code=b.asset_code WHERE b.policy_ref=$1 AND b.asset_code=$2 AND a.approved=true FOR SHARE`,
  [market.terms.risk.settlement_asset_ref,asset])).rows[0];
  requireCondition(binding?.approved&&binding.synthetic,403,'ASSET_NOT_APPROVED','AMM collateral requires an approved synthetic binding.');
  const liquidity=market.terms.liquidity;
  return (await sql.query<PoolRow>(`INSERT INTO amm_pools(market_id,outcome_id,asset_code,inventory_limit,subsidy_limit,
    loss_limit,max_slippage_bps,impact_bps,fee_bps,activated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
  [marketId,outcomeId,asset,liquidity.inventory_limit_minor,liquidity.subsidy_limit_minor,liquidity.loss_limit_minor,
    liquidity.max_slippage_bps,impactBps,market.terms.risk.fee_bps,actor.id])).rows[0]!;
}

export async function fundAmm(sql:Sql,actor:Account,marketId:string,outcomeId:string,amountText:string,request:string){
  const amount=parseOrderAmount(amountText,'amount');
  const pool=(await sql.query<PoolRow>('SELECT * FROM amm_pools WHERE market_id=$1 AND outcome_id=$2 FOR UPDATE',
    [marketId,outcomeId])).rows[0];
  requireCondition(pool,404,'AMM_NOT_FOUND','AMM pool not found.');
  requireCondition(BigInt(pool.funded_minor)+amount<=BigInt(pool.subsidy_limit),409,'AMM_SUBSIDY_LIMIT','Funding exceeds the approved subsidy.');
  const custody=await ledgerAccount(sql,null,pool.asset_code,'escrow_asset');
  const treasury=await ledgerAccount(sql,null,pool.asset_code,'liquidity_reserve');
  await postJournal(sql,{effectId:`amm:${marketId}:${outcomeId}:fund:${request}`,asset:pool.asset_code,kind:'amm_treasury_funded',
    referenceId:marketId,reason:'Governed synthetic AMM treasury funding',lines:[
      {account:custody,debit:amount,credit:0n},{account:treasury,debit:0n,credit:amount},
    ]});
  await sql.query('UPDATE amm_pools SET funded_minor=funded_minor+$3::numeric,updated_at=now() WHERE market_id=$1 AND outcome_id=$2',
    [marketId,outcomeId,amount.toString()]);
  return {market_id:marketId,outcome_id:outcomeId,funded_minor:(BigInt(pool.funded_minor)+amount).toString()};
}

export async function recordAmmReference(sql:Sql,actor:Account,input:{marketId:string;outcomeId:string;price:string;
  observedAt:Date;expiresAt:Date;sourceRef:string}){
  const price=parsePrice(input.price);
  const pool=(await sql.query<PoolRow>('SELECT * FROM amm_pools WHERE market_id=$1 AND outcome_id=$2 FOR SHARE',
    [input.marketId,input.outcomeId])).rows[0];
  requireCondition(pool?.status==='open',409,'AMM_NOT_OPEN','AMM pool is not open.');
  requireCondition(input.observedAt<=new Date()&&input.expiresAt>new Date()&&input.expiresAt>input.observedAt,
    422,'INVALID_REFERENCE_PRICE','Reference price must be observed and currently fresh.');
  return (await sql.query<ReferenceRow>(`INSERT INTO amm_reference_prices(id,market_id,outcome_id,price,observed_at,
    expires_at,source_ref,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
  [randomUUID(),input.marketId,input.outcomeId,price.toString(),input.observedAt,input.expiresAt,input.sourceRef,actor.id])).rows[0]!;
}

export async function createAmmQuote(sql:Sql,actor:Account,input:{marketId:string;outcomeId:string;side:OrderSide;
  quantity:string;limitPrice:string},now=new Date()){
  const pool=(await sql.query<PoolRow>('SELECT * FROM amm_pools WHERE market_id=$1 AND outcome_id=$2 FOR SHARE',
    [input.marketId,input.outcomeId])).rows[0];
  requireCondition(pool?.status==='open',409,'AMM_NOT_OPEN','AMM pool is not open.');
  const assurance=await accountAssurance(sql,actor);
  requireCondition(actor.status==='active'&&assurance.identityStatus==='VERIFIED'&&assurance.fundingEligible,
    403,'TRADING_NOT_ELIGIBLE','Trading requires an active, verified, eligible account.');
  const reference=(await sql.query<ReferenceRow>(`SELECT * FROM amm_reference_prices WHERE market_id=$1 AND outcome_id=$2
    AND observed_at<=$3 AND expires_at>$3 ORDER BY observed_at DESC,id DESC LIMIT 1`,[input.marketId,input.outcomeId,now])).rows[0];
  requireCondition(reference,409,'AMM_REFERENCE_STALE','No fresh approved AMM reference price is available.');
  const quote=previewAmmQuote(limits(pool),exposure(pool),{side:input.side,quantity:parseOrderAmount(input.quantity,'quantity'),
    referencePrice:BigInt(reference.price),limitPrice:parsePrice(input.limitPrice)});
  requireCondition(BigInt(pool.funded_minor)>=quote.nextExposure.subsidyCommitted,409,'AMM_TREASURY_UNFUNDED',
    'The AMM treasury does not fund this quote.');
  const expiresAt=new Date(Math.min(reference.expires_at.getTime(),now.getTime()+15_000));
  const row=(await sql.query<QuoteRow>(`INSERT INTO amm_quotes(id,owner_id,market_id,outcome_id,side,quantity,
    reference_price_id,price,user_collateral,amm_collateral,fee,user_total,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,[randomUUID(),actor.id,input.marketId,
    input.outcomeId,input.side,quote.quantity.toString(),reference.id,quote.price.toString(),quote.userCollateral.toString(),
    quote.ammCollateral.toString(),quote.fee.toString(),quote.userTotal.toString(),expiresAt])).rows[0]!;
  return publicQuote(row);
}

export async function executeAmmQuote(sql:Sql,actor:Account,quoteId:string,request:string,now=new Date()){
  const quote=(await sql.query<QuoteRow>('SELECT * FROM amm_quotes WHERE id=$1 FOR UPDATE',[quoteId])).rows[0];
  requireCondition(quote&&quote.owner_id===actor.id,404,'AMM_QUOTE_NOT_FOUND','AMM quote not found.');
  requireCondition(quote.state==='quoted',409,'AMM_QUOTE_TERMINAL','AMM quote is no longer executable.');
  requireCondition(new Date(quote.expires_at)>now,409,'AMM_QUOTE_EXPIRED','AMM quote expired.');
  const pool=(await sql.query<PoolRow>('SELECT * FROM amm_pools WHERE market_id=$1 AND outcome_id=$2 FOR UPDATE',
    [quote.market_id,quote.outcome_id])).rows[0]!;
  requireCondition(pool.status==='open',409,'AMM_NOT_OPEN','AMM pool is not open.');
  const nextShares=BigInt(pool.shares_committed)+BigInt(quote.quantity);
  const nextSubsidy=BigInt(pool.subsidy_committed)+BigInt(quote.amm_collateral);
  const nextLoss=BigInt(pool.worst_case_loss_committed)+BigInt(quote.amm_collateral);
  requireCondition(nextShares<=BigInt(pool.inventory_limit)&&nextSubsidy<=BigInt(pool.subsidy_limit)&&
    nextLoss<=BigInt(pool.loss_limit)&&nextSubsidy<=BigInt(pool.funded_minor),409,'AMM_LIMIT_CHANGED',
    'AMM capacity changed after this quote was created.');
  await lockOwnerAsset(sql,actor.id,pool.asset_code);
  const reservation=await reserve(sql,{owner:actor.id,asset:pool.asset_code,purpose:'amm',reference:quote.id,amount:quote.user_total});
  const userHeld=await ledgerAccount(sql,actor.id,pool.asset_code,'user_reserved');
  const treasury=await ledgerAccount(sql,null,pool.asset_code,'liquidity_reserve');
  requireCondition(await accountBalance(sql,treasury)>=BigInt(quote.amm_collateral),409,'AMM_TREASURY_UNFUNDED','AMM treasury balance is insufficient.');
  const escrow=await ledgerAccount(sql,null,pool.asset_code,'market_escrow');
  const fees=await ledgerAccount(sql,null,pool.asset_code,'protocol_fee');
  await postJournal(sql,{effectId:`amm:${quote.id}:execution`,asset:pool.asset_code,kind:'amm_execution',referenceId:quote.id,
    reason:'Execute bounded synthetic AMM quote',lines:[
      {account:userHeld,debit:BigInt(quote.user_total),credit:0n},{account:treasury,debit:BigInt(quote.amm_collateral),credit:0n},
      {account:escrow,debit:0n,credit:BigInt(quote.user_collateral)+BigInt(quote.amm_collateral)},
      ...(BigInt(quote.fee)>0n?[{account:fees,debit:0n,credit:BigInt(quote.fee)}]:[]),
    ]});
  await sql.query("UPDATE collateral_reservations SET consumed=amount,state='consumed',updated_at=now() WHERE id=$1",[reservation.id]);
  await sql.query(`UPDATE amm_pools SET shares_committed=$3,subsidy_committed=$4,worst_case_loss_committed=$5,
    updated_at=now() WHERE market_id=$1 AND outcome_id=$2`,[quote.market_id,quote.outcome_id,nextShares.toString(),
    nextSubsidy.toString(),nextLoss.toString()]);
  const row=(await sql.query<QuoteRow>("UPDATE amm_quotes SET state='executed',executed_at=$2 WHERE id=$1 RETURNING *",
    [quote.id,now])).rows[0]!;
  return publicQuote(row);
}
