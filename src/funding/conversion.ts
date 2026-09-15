import {randomUUID} from 'node:crypto';
import {accountBalance,ledgerAccount,lockOwnerAsset,postJournal} from '../financial/ledger.js';
import {integer} from '../financial/model.js';
import type {Sql} from '../platform/database.js';
import {record} from '../platform/commands.js';
import {requireCondition} from '../platform/errors.js';

type RateRow={id:string;source_asset:string;destination_asset:string;rate_numerator:string;rate_denominator:string;
  fee_bps:number;minimum_source_minor:string;source_ref:string;expires_at:Date;created_at:Date};
type QuoteRow={id:string;owner_id:string;rate_snapshot_id:string;source_asset:string;destination_asset:string;
  source_amount_minor:string;fee_minor:string;destination_amount_minor:string;rate_numerator:string;rate_denominator:string;
  state:'quoted'|'executed';expires_at:Date;created_at:Date;executed_at:Date|null;trade_id?:string|null};

export const publicRate=(row:RateRow)=>({id:row.id,source_asset:row.source_asset,destination_asset:row.destination_asset,
  rate_numerator:row.rate_numerator,rate_denominator:row.rate_denominator,fee_bps:row.fee_bps,
  minimum_source_minor:row.minimum_source_minor,source_ref:row.source_ref,
  expires_at:new Date(row.expires_at).toISOString(),created_at:new Date(row.created_at).toISOString()});
export const publicQuote=(row:QuoteRow)=>({id:row.id,source_asset:row.source_asset,destination_asset:row.destination_asset,
  source_amount_minor:row.source_amount_minor,fee_minor:row.fee_minor,destination_amount_minor:row.destination_amount_minor,
  rate_numerator:row.rate_numerator,rate_denominator:row.rate_denominator,state:row.state,
  expires_at:new Date(row.expires_at).toISOString(),created_at:new Date(row.created_at).toISOString(),
  executed_at:row.executed_at?new Date(row.executed_at).toISOString():null,...(row.trade_id?{trade_id:row.trade_id}:{})});

const supportedPair=(source:string,destination:string)=>(source==='NGN'&&destination==='USDT_BSC')||
  (source==='USDT_BSC'&&destination==='NGN');

export async function publishConversionRate(sql:Sql,actor:string,input:{sourceAsset:string;destinationAsset:string;
  rateNumerator:string;rateDenominator:string;feeBps:number;minimumSourceMinor:string;sourceRef:string;expiresAt:Date;
  reason:string},requestId:string,now=new Date()) {
  requireCondition(supportedPair(input.sourceAsset,input.destinationAsset),422,'CONVERSION_PAIR_UNSUPPORTED','Only NGN and USDT on BNB Smart Chain may be converted.');
  const numerator=integer(input.rateNumerator),denominator=integer(input.rateDenominator),minimum=integer(input.minimumSourceMinor);
  requireCondition(numerator>0n&&denominator>0n&&minimum>0n,422,'INVALID_CONVERSION_RATE','Rate terms must be positive integers.');
  requireCondition(input.feeBps>=0&&input.feeBps<=1000,422,'INVALID_CONVERSION_FEE','Conversion fee must be between 0 and 1,000 basis points.');
  requireCondition(input.expiresAt.getTime()>now.getTime(),422,'INVALID_RATE_EXPIRY','The rate snapshot must expire in the future.');
  const assets=(await sql.query<{code:string;approved:boolean}>(`SELECT code,approved FROM financial_assets
    WHERE code=ANY($1::text[]) FOR SHARE`,[[input.sourceAsset,input.destinationAsset]])).rows;
  requireCondition(assets.length===2&&assets.every(asset=>asset.approved),422,'CONVERSION_ASSET_NOT_APPROVED','Both conversion assets must be approved.');
  const token=(await sql.query<{approved:boolean}>("SELECT approved FROM token_asset_registry WHERE asset_code='USDT_BSC' FOR SHARE")).rows[0];
  requireCondition(token?.approved,422,'CONVERSION_ASSET_NOT_APPROVED','The exact USDT token contract and network must be approved.');
  const id=randomUUID();
  const row=(await sql.query<RateRow>(`INSERT INTO conversion_rate_snapshots(id,source_asset,destination_asset,rate_numerator,
    rate_denominator,fee_bps,minimum_source_minor,source_ref,expires_at,created_by,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id,input.sourceAsset,input.destinationAsset,numerator.toString(),
    denominator.toString(),input.feeBps,minimum.toString(),input.sourceRef,input.expiresAt,actor,now])).rows[0]!;
  await record(sql,{actor,authority:'finance_operator',action:'conversion_rate.published',resource:id,request:requestId,
    reason:input.reason,evidence:input.sourceRef,after:publicRate(row)});
  return publicRate(row);
}

export async function fundConversionInventory(sql:Sql,actor:string,input:{asset:string;amountMinor:string;evidenceRef:string;
  reason:string},requestId:string) {
  requireCondition(['NGN','USDT_BSC'].includes(input.asset),422,'CONVERSION_ASSET_UNSUPPORTED','Only NGN and USDT conversion inventory is supported.');
  const amount=integer(input.amountMinor);requireCondition(amount>0n,422,'INVALID_AMOUNT','Inventory funding must be positive.');
  if(input.asset==='USDT_BSC'){
    const token=(await sql.query<{approved:boolean}>("SELECT approved FROM token_asset_registry WHERE asset_code='USDT_BSC' FOR SHARE")).rows[0];
    requireCondition(token?.approved,422,'CONVERSION_ASSET_NOT_APPROVED','The exact USDT token contract and network must be approved.');
  }
  await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`conversion-inventory:${input.asset}`]);
  const custody=await ledgerAccount(sql,null,input.asset,'escrow_asset');
  const inventory=await ledgerAccount(sql,null,input.asset,'conversion_inventory');
  const effect=`conversion-inventory:${randomUUID()}`;
  const journal=await postJournal(sql,{effectId:effect,asset:input.asset,kind:'conversion_inventory_funded',referenceId:effect,
    reason:input.reason,lines:[{account:custody,debit:amount,credit:0n},{account:inventory,debit:0n,credit:amount}]});
  await record(sql,{actor,authority:'finance_operator',action:'conversion_inventory.funded',resource:journal,request:requestId,
    reason:input.reason,evidence:input.evidenceRef,after:{asset:input.asset,amount_minor:amount.toString()}});
  return {journal_id:journal,asset:input.asset,amount_minor:amount.toString()};
}

export async function createConversionQuote(sql:Sql,owner:string,input:{sourceAsset:string;destinationAsset:string;
  sourceAmountMinor:string},now=new Date()) {
  requireCondition(supportedPair(input.sourceAsset,input.destinationAsset),422,'CONVERSION_PAIR_UNSUPPORTED','Only NGN and USDT on BNB Smart Chain may be converted.');
  const amount=integer(input.sourceAmountMinor);requireCondition(amount>0n,422,'INVALID_AMOUNT','Conversion amount must be positive.');
  const rate=(await sql.query<RateRow>(`SELECT r.* FROM conversion_rate_snapshots r
    JOIN financial_assets s ON s.code=r.source_asset JOIN financial_assets d ON d.code=r.destination_asset
    WHERE r.source_asset=$1 AND r.destination_asset=$2 AND r.expires_at>$3 AND s.approved=true AND d.approved=true
    ORDER BY r.created_at DESC LIMIT 1 FOR SHARE OF r`,[input.sourceAsset,input.destinationAsset,now])).rows[0];
  requireCondition(rate,503,'CONVERSION_RATE_UNAVAILABLE','No current approved conversion rate is available.');
  requireCondition(amount>=BigInt(rate.minimum_source_minor),422,'CONVERSION_MINIMUM_NOT_MET','The source amount is below the published conversion minimum.');
  const fee=(amount*BigInt(rate.fee_bps)+9999n)/10000n,net=amount-fee;
  requireCondition(net>0n,422,'CONVERSION_AMOUNT_TOO_SMALL','The amount does not cover the conversion fee.');
  const destination=net*BigInt(rate.rate_numerator)/BigInt(rate.rate_denominator);
  requireCondition(destination>0n,422,'CONVERSION_AMOUNT_TOO_SMALL','The converted amount rounds to zero.');
  const expiresAt=new Date(Math.min(now.getTime()+30_000,new Date(rate.expires_at).getTime()));
  const row=(await sql.query<QuoteRow>(`INSERT INTO wallet_conversion_quotes(id,owner_id,rate_snapshot_id,source_asset,
    destination_asset,source_amount_minor,fee_minor,destination_amount_minor,rate_numerator,rate_denominator,expires_at,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,[randomUUID(),owner,rate.id,input.sourceAsset,
    input.destinationAsset,amount.toString(),fee.toString(),destination.toString(),rate.rate_numerator,rate.rate_denominator,
    expiresAt,now])).rows[0]!;
  return publicQuote(row);
}

export async function getConversionQuote(sql:Sql,owner:string,id:string) {
  const row=(await sql.query<QuoteRow>(`SELECT q.*,t.id AS trade_id FROM wallet_conversion_quotes q
    LEFT JOIN wallet_conversion_trades t ON t.quote_id=q.id WHERE q.id=$1 AND q.owner_id=$2`,[id,owner])).rows[0];
  requireCondition(row,404,'NOT_FOUND','Wallet conversion quote not found.');return publicQuote(row);
}

export async function executeConversionQuote(sql:Sql,owner:string,id:string,requestId:string,now=new Date()) {
  const initial=(await sql.query<Pick<QuoteRow,'source_asset'|'destination_asset'>>(
    'SELECT source_asset,destination_asset FROM wallet_conversion_quotes WHERE id=$1 AND owner_id=$2',[id,owner])).rows[0];
  requireCondition(initial,404,'NOT_FOUND','Wallet conversion quote not found.');
  for(const asset of [initial.source_asset,initial.destination_asset].sort())await lockOwnerAsset(sql,owner,asset);
  for(const asset of [initial.source_asset,initial.destination_asset].sort())
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`conversion-inventory:${asset}`]);
  const row=(await sql.query<QuoteRow>('SELECT * FROM wallet_conversion_quotes WHERE id=$1 AND owner_id=$2 FOR UPDATE',[id,owner])).rows[0]!;
  requireCondition(row.state==='quoted',409,'CONVERSION_QUOTE_TERMINAL','The conversion quote has already been executed.');
  requireCondition(new Date(row.expires_at).getTime()>now.getTime(),409,'CONVERSION_QUOTE_EXPIRED','The conversion quote expired. Request a new quote.');
  const sourceAmount=BigInt(row.source_amount_minor),destinationAmount=BigInt(row.destination_amount_minor);
  const sourceUser=await ledgerAccount(sql,owner,row.source_asset,'user_available');
  const sourceInventory=await ledgerAccount(sql,null,row.source_asset,'conversion_inventory');
  const destinationInventory=await ledgerAccount(sql,null,row.destination_asset,'conversion_inventory');
  const destinationUser=await ledgerAccount(sql,owner,row.destination_asset,'user_available');
  requireCondition(await accountBalance(sql,sourceUser)>=sourceAmount,409,'INSUFFICIENT_COLLATERAL','The source wallet balance is insufficient.');
  requireCondition(await accountBalance(sql,destinationInventory)>=destinationAmount,409,'CONVERSION_INVENTORY_UNAVAILABLE','Treasury destination inventory is insufficient.');
  const tradeId=randomUUID();
  const sourceJournal=await postJournal(sql,{effectId:`conversion:${tradeId}:source`,asset:row.source_asset,kind:'wallet_conversion',referenceId:tradeId,
    reason:'Accepted wallet conversion quote',lines:[{account:sourceUser,debit:sourceAmount,credit:0n},{account:sourceInventory,debit:0n,credit:sourceAmount}]});
  const destinationJournal=await postJournal(sql,{effectId:`conversion:${tradeId}:destination`,asset:row.destination_asset,kind:'wallet_conversion',referenceId:tradeId,
    reason:'Accepted wallet conversion quote',lines:[{account:destinationInventory,debit:destinationAmount,credit:0n},{account:destinationUser,debit:0n,credit:destinationAmount}]});
  await sql.query(`INSERT INTO wallet_conversion_trades(id,quote_id,owner_id,source_journal_id,destination_journal_id,executed_at)
    VALUES($1,$2,$3,$4,$5,$6)`,[tradeId,id,owner,sourceJournal,destinationJournal,now]);
  const updated=(await sql.query<QuoteRow>("UPDATE wallet_conversion_quotes SET state='executed',executed_at=$2 WHERE id=$1 RETURNING *",[id,now])).rows[0]!;
  await record(sql,{actor:owner,authority:'account_owner',action:'wallet_conversion.executed',resource:tradeId,request:requestId,
    reason:'Customer accepted immutable wallet conversion quote',after:{quote_id:id,source_asset:row.source_asset,
      source_amount_minor:row.source_amount_minor,fee_minor:row.fee_minor,destination_asset:row.destination_asset,
      destination_amount_minor:row.destination_amount_minor}});
  return {...publicQuote(updated),trade_id:tradeId};
}
