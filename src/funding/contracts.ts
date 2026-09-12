import { Type } from '@sinclair/typebox';
import { UUID, Timestamp, Uint, object, text } from '../contracts.js';

export const FinancialAssetSchema=object({code:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),scale:Type.Integer({minimum:0,maximum:36}),
  synthetic:Type.Boolean(),funding_enabled:Type.Boolean(),withdrawal_enabled:Type.Boolean()},{$id:'FinancialAsset'});
export const BalanceSchema=object({asset:Type.String(),available_minor:Uint,reserved_minor:Uint,withdrawal_pending_minor:Uint,
  spendable:Type.Literal(false)},{$id:'CollateralBalance',description:'Exact off-chain balances. Real trading is not active. Pending partner or chain deposits never appear as available.'});
export const DepositSchema=object({id:UUID,asset:Type.String(),target_minor:Uint,
  state:Type.String({enum:['awaiting_partner','partner_confirmed','chain_observed','reconciled_available','expired','exception']}),
  expires_at:Timestamp,created_at:Timestamp,updated_at:Timestamp,
  funding_instructions_available:Type.Literal(false)},{$id:'DepositIntent',description:'Workflow status only. A real payment quote or beneficiary is unavailable until a reviewed partner adapter is activated.'});
export const WithdrawalSchema=object({id:UUID,asset:Type.String(),amount_minor:Uint,
  state:Type.String({enum:['reserved','submitted','uncertain','finalized','cancelled','exception']}),
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
export const financialSchemas=[FinancialAssetSchema,BalanceSchema,DepositSchema,WithdrawalSchema,ReconciliationSchema,StatementSchema,SmartAccountSchema];
