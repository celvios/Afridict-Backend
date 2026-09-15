import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database, Sql } from '../platform/database.js';
import { requireCondition } from '../platform/errors.js';

const digest=(ticket:string)=>createHash('sha256').update(ticket).digest();

export async function createRealtimeTicket(sql:Sql,accountId:string,now=new Date()) {
  const ticket=randomBytes(32).toString('base64url');
  const expiresAt=new Date(now.getTime()+60_000);
  await sql.query(`INSERT INTO realtime_tickets(id,token_hash,account_id,expires_at,created_at)
    VALUES ($1,$2,$3,$4,$5)`,[randomUUID(),digest(ticket),accountId,expiresAt,now]);
  return {ticket,expires_at:expiresAt.toISOString(),websocket_path:'/v1/realtime' as const};
}

export async function consumeRealtimeTicket(db:Database,ticket:string,now=new Date()) {
  requireCondition(/^[A-Za-z0-9_-]{43}$/.test(ticket),401,'INVALID_REALTIME_TICKET','The realtime ticket is invalid or expired.');
  return db.transaction(async sql=>{
    const row=(await sql.query<{account_id:string}>(`UPDATE realtime_tickets t SET consumed_at=$2
      FROM accounts a WHERE t.token_hash=$1 AND t.consumed_at IS NULL AND t.expires_at>$2
      AND a.id=t.account_id AND a.status='active' RETURNING t.account_id`,[digest(ticket),now])).rows[0];
    requireCondition(row,401,'INVALID_REALTIME_TICKET','The realtime ticket is invalid or expired.');
    return row.account_id;
  });
}
