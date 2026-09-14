import {Type} from '@sinclair/typebox';
import {Timestamp,Uint,UUID,object} from '../contracts.js';

const Hash32=Type.String({pattern:'^0x[a-f0-9]{64}$'});
const Address=Type.String({pattern:'^0x[a-f0-9]{40}$'});
export const SettlementSubmissionSchema=object({id:UUID,attempt:Type.Integer({minimum:1}),
  state:Type.String({enum:['uncertain','submitted','confirmed','finalized','reverted','replaced','reorged']}),
  transaction_hash:Type.Union([Hash32,Type.Null()]),transaction_nonce:Type.Union([Uint,Type.Null()]),
  submitted_at:Timestamp},{$id:'SettlementSubmission'});
export const SettlementBatchSchema=object({id:UUID,batch_key:Hash32,market_id:UUID,asset:Type.String(),chain_id:Uint,
  contract_address:Address,resolution_hash:Type.String({pattern:'^[a-f0-9]{64}$'}),merkle_root:Hash32,
  manifest_hash:Type.String({pattern:'^[a-f0-9]{64}$'}),item_count:Type.Integer({minimum:1,maximum:100}),
  total_minor:Uint,state:Type.String({enum:['prepared','submitted','confirmed','finalized','exception']}),
  submission:Type.Union([Type.Ref(SettlementSubmissionSchema),Type.Null()]),created_at:Timestamp,updated_at:Timestamp},
  {$id:'SettlementBatch',description:'A deterministic claim batch. Finalized means the exact commitBatch calldata reached the configured contract and met the approved independent-RPC quorum and confirmation depth.'});
export const SettlementClaimSchema=object({batch_id:UUID,batch_key:Hash32,item_index:Type.Integer({minimum:0,maximum:99}),
  market_id:UUID,asset:Type.String(),chain_id:Uint,contract_address:Address,recipient_address:Address,
  amount_minor:Uint,leaf_hash:Hash32,merkle_root:Hash32,proof:Type.Array(Hash32),
  batch_state:Type.String({enum:['prepared','submitted','confirmed','finalized','exception']}),
  claim_ready:Type.Boolean()},{$id:'SettlementClaim',description:'Private claim material for the authenticated smart-account owner. Submit claims only after claim_ready is true.'});
export const SettlementRefreshSchema=object({batch:Type.Ref(SettlementBatchSchema),observer_count:Type.Integer({minimum:0}),
  confirmations:Uint,required_confirmations:Uint,required_quorum:Type.Integer({minimum:2})},
  {$id:'SettlementRefresh'});
export const settlementSchemas=[SettlementSubmissionSchema,SettlementBatchSchema,SettlementClaimSchema,SettlementRefreshSchema];
