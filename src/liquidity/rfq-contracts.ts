import {Type} from '@sinclair/typebox';
import {Timestamp,UUID,Uint,object} from '../contracts.js';

export const RfqEntitySchema=object({id:UUID,legal_name:Type.String(),status:Type.String({enum:['pending','active','suspended']}),
  exposure_limit_minor:Uint,created_by:UUID,approved_by:Type.Union([UUID,Type.Null()]),approved_at:Type.Union([Timestamp,Type.Null()]),
  created_at:Timestamp,updated_at:Timestamp},{$id:'RfqEntity'});
export const RfqMembershipSchema=object({entity_id:UUID,account_id:UUID,role:Type.String({enum:['requester','dealer']}),
  signing_key_fingerprint:Type.Union([Type.String({pattern:'^[a-f0-9]{64}$'}),Type.Null()])},{$id:'RfqMembership'});
export const RfqRequestSchema=object({id:UUID,entity_id:UUID,market_id:UUID,outcome_id:Type.String(),
  side:Type.String({enum:['buy','sell']}),quantity:Uint,expires_at:Timestamp,
  state:Type.String({enum:['open','accepted','cancelled','expired']}),accepted_quote_id:Type.Union([UUID,Type.Null()]),
  created_at:Timestamp,updated_at:Timestamp},{$id:'RfqRequest'});
export const RfqQuoteSchema=object({id:UUID,request_id:UUID,dealer_entity_id:UUID,price:Uint,expires_at:Timestamp,
  nonce:Type.String(),signing_key_fingerprint:Type.String({pattern:'^[a-f0-9]{64}$'}),signature:Type.String(),
  payload_hash:Type.String({pattern:'^[a-f0-9]{64}$'}),state:Type.String({enum:['open','accepted','rejected','expired']}),
  created_at:Timestamp,updated_at:Timestamp},{$id:'RfqQuote'});
export const RfqFillSchema=object({id:UUID,request_id:UUID,quote_id:UUID,market_id:UUID,outcome_id:Type.String(),
  requester_side:Type.String({enum:['buy','sell']}),price:Uint,quantity:Uint,sequence:Uint,created_at:Timestamp},
{$id:'RfqFill'});
export const rfqSchemas=[RfqEntitySchema,RfqMembershipSchema,RfqRequestSchema,RfqQuoteSchema,RfqFillSchema];
