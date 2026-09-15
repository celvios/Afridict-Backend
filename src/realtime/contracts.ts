import { Type } from '@sinclair/typebox';
import { Timestamp, object } from '../contracts.js';

export const RealtimeTicketSchema=object({ticket:Type.String({minLength:43,maxLength:43}),expires_at:Timestamp,
  websocket_path:Type.Literal('/v1/realtime')},{$id:'RealtimeTicket',
  description:'One-use credential for authenticating a browser WebSocket without exposing its bearer token in a URL.'});

export const realtimeSchemas=[RealtimeTicketSchema];
