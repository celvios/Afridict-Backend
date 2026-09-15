import { Type } from '@sinclair/typebox';
import { UUID, Timestamp, Uint, object } from '../contracts.js';

export const OrderSchema=object({id:UUID,market_id:UUID,outcome_id:Type.String(),
  side:Type.String({enum:['buy','sell']}),limit_price:Uint,quantity:Uint,remaining:Uint,
  state:Type.String({enum:['open','filled','cancelled']}),sequence:Uint,created_at:Timestamp,updated_at:Timestamp},
{$id:'ClobOrder',description:'Integer share limit order. One matched share is backed by 1,000,000 collateral minor units. Buy funds the selected outcome; sell funds its complement. Both require collateral before admission.'});
export const FillSchema=object({id:UUID,market_id:UUID,maker_order_id:UUID,taker_order_id:UUID,
  outcome_id:Type.String(),price:Uint,quantity:Uint,sequence:Uint,created_at:Timestamp},
{$id:'ClobFill',description:'Immutable execution at the resting order price. Each fill escrows both counterparties\' collateral and records per-share fees.'});
export const PositionSchema=object({market_id:UUID,outcome_id:Type.String(),side:Type.String({enum:['buy','sell']}),
  quantity:Uint,collateral_minor:Uint,fees_minor:Uint},
{$id:'ClobPosition',description:'Account-owned unsettled outcome exposure derived from immutable unredeemed fills. Buy claims the selected outcome and sell claims its complement. Collateral is escrowed until governed redemption.'});
const Level=object({price:Uint,quantity:Uint});
export const BookSchema=object({market_id:UUID,outcome_id:Type.String(),status:Type.String({enum:['open','halted']}),
  sequence:Uint,bids:Type.Array(Level),asks:Type.Array(Level)},
{$id:'ClobBook',description:'Aggregate price levels; bids descend and asks ascend. The sequence is a consistent snapshot cursor for the append-only market event feed.'});
export const TradingStateSchema=object({market_id:UUID,asset_code:Type.String(),
  status:Type.String({enum:['open','halted']}),sequence:Uint},{$id:'ClobTradingState'});
export const MarketEventSchema=object({sequence:Uint,event_type:Type.String({enum:[
  'activated','halted','order_accepted','fill','order_cancelled','resolution_proposed',
  'resolution_challenged','resolution_finalized','redemption_batch','amm_execution','rfq_execution']}),
  order_id:Type.Union([UUID,Type.Null()]),fill_id:Type.Union([UUID,Type.Null()])},
{$id:'ClobMarketEvent'});
export const tradingSchemas=[OrderSchema,FillSchema,PositionSchema,BookSchema,TradingStateSchema,MarketEventSchema];
