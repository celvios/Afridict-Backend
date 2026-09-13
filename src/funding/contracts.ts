import { Type } from '@sinclair/typebox';
import { UUID, Timestamp, Uint, object, text } from '../contracts.js';

export const FinancialAssetSchema=object({code:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),scale:Type.Integer({minimum:0,maximum:36}),
  synthetic:Type.Boolean(),funding_enabled:Type.Boolean(),withdrawal_enabled:Type.Boolean()},{$id:'FinancialAsset'});
export const BalanceSchema=object({asset:Type.String(),available_minor:Uint,reserved_minor:Uint,withdrawal_pending_minor:Uint,
  spendable:Type.Literal(false)},{$id:'CollateralBalance',description:'Exact off-chain balances. Real trading is not active. Pending partner or chain deposits never appear as available.'});
export const FiatWalletSchema=object({currency:Type.String({enum:['NGN','USD']}),scale:Type.Literal(2),available_minor:Uint,
  reserved_minor:Uint,withdrawal_pending_minor:Uint,funding_enabled:Type.Boolean(),withdrawal_enabled:Type.Boolean()},
  {$id:'FiatWallet',description:'Currency-separated ledger projection. Values are integer minor units: kobo for NGN and cents for USD.'});
export const BankSchema=object({code:Type.String({pattern:'^[0-9]{3,10}$'}),name:text('Provider-reported bank name.',120)},{$id:'FiatBank'});
export const ResolvedBankAccountSchema=object({account_name:text('Provider-confirmed account holder name. Returned only to the authenticated caller.',200),
  account_number:Type.String({pattern:'^[0-9]{10}$'}),bank_code:Type.String({pattern:'^[0-9]{3,10}$'}),bank_name:text('Provider-reported bank name.',120)},
  {$id:'ResolvedBankAccount',description:'Ephemeral provider resolution result. Afridict does not persist this response.'});
export const FiatDepositSchema=object({id:UUID,currency:Type.String({enum:['NGN','USD']}),target_minor:Uint,
  state:Type.String({enum:['instruction_pending','instruction_creating','instructions_available','instruction_uncertain']}),
  expires_at:Timestamp,created_at:Timestamp,updated_at:Timestamp,instructions:Type.Union([Type.Null(),object({account_name:text('Provider-issued beneficiary name.',200),
    account_number:Type.String({pattern:'^[0-9]{10}$'}),bank_code:Type.String({minLength:1,maxLength:20}),bank_name:text('Provider-issued bank name.',120),provider:Type.Literal('swervpay')})])},
  {$id:'FiatDepositIntent',description:'Durable fiat collection workflow. Only instructions_available may be displayed for payment. Uncertain creation requires reconciliation.'});
export const DepositSchema=object({id:UUID,asset:Type.String(),target_minor:Uint,
  state:Type.String({enum:['awaiting_partner','partner_confirmed','chain_observed','reconciled_available','expired','exception']}),
  expires_at:Timestamp,created_at:Timestamp,updated_at:Timestamp,
  funding_instructions_available:Type.Literal(false)},{$id:'DepositIntent',description:'Workflow status only. A real payment quote or beneficiary is unavailable until a reviewed partner adapter is activated.'});
export const WithdrawalSchema=object({id:UUID,asset:Type.String(),amount_minor:Uint,
  state:Type.String({enum:['reserved','submitting','submitted','uncertain','finalized','cancelled','exception']}),
  destination_ref:text('Opaque destination saved for this owner; no raw bank or wallet details.',200),
  rail:Type.String(),created_at:Timestamp,updated_at:Timestamp},{$id:'Withdrawal'});
export const ReconciliationSchema=object({id:UUID,asset:Type.String(),status:Type.String({enum:['balanced','exceptions_opened']}),
  escrow_ledger_minor:Uint,chain_net_minor:Type.String({pattern:'^-?(0|[1-9][0-9]*)$'}),
  partner_deposits_minor:Uint,finalized_deposits_minor:Uint,user_claims_minor:Uint,exceptions:Type.Array(Type.String()),created_at:Timestamp},
  {$id:'ReconciliationSnapshot',description:'Compares stored observations and ledger. It is not independent proof of partner or chain state.'});
export const StatementSchema=object({id:UUID,effect_id:Type.String(),kind:Type.String(),reference_id:Type.String(),
  asset:Type.String(),bucket:Type.String(),direction:Type.String({enum:['increase','decrease']}),
  amount_minor:Uint,created_at:Timestamp},{$id:'StatementEntry'});
export const SmartAccountSchema=object({chain_id:Uint,address:Type.String({pattern:'^0x[a-f0-9]{40}$'}),
  status:Type.String({enum:['provisioning','active','recovery_pending','suspended']}),
  recovery:Type.Literal('identity_provider'),financial_mode:Type.String({enum:['disabled','synthetic']})},
  {$id:'SmartAccount',description:'The caller own embedded account metadata. No session keys or recovery secrets are exposed.'});
export const financialSchemas=[FinancialAssetSchema,BalanceSchema,FiatWalletSchema,BankSchema,ResolvedBankAccountSchema,
  FiatDepositSchema,DepositSchema,WithdrawalSchema,ReconciliationSchema,StatementSchema,SmartAccountSchema];
