import { createHash, randomUUID } from 'node:crypto';
import type { Database, Sql } from './database.js';
import { AppError } from './errors.js';

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, val]) => `${JSON.stringify(key)}:${canonical(val)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
export function hash(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
export type CommandResult = { status: number; body: unknown };

// The unique insert waits for a concurrent transaction. The row lock makes a
// retry observe either the committed result or a rollback, never half a command.
export async function command(db: Database, actor: string, key: string, input: unknown,
  authorize: (sql: Sql) => Promise<void>, work: (sql: Sql) => Promise<CommandResult>): Promise<CommandResult> {
  return db.transaction(async sql => {
    await authorize(sql);
    const fingerprint = hash(input);
    await sql.query(`INSERT INTO command_results(actor_id, idempotency_key, request_hash)
      VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [actor, key, fingerprint]);
    const row = (await sql.query<{ request_hash: string; status_code: number | null; response: unknown }>(
      `SELECT request_hash, status_code, response FROM command_results
       WHERE actor_id=$1 AND idempotency_key=$2 FOR UPDATE`, [actor, key])).rows[0];
    if (!row) throw new Error('Missing command record');
    if (row.request_hash !== fingerprint) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'This idempotency key was used for a different command.');
    if (row.status_code !== null) return { status: row.status_code, body: row.response };
    const result = await work(sql);
    await sql.query(`UPDATE command_results SET status_code=$3, response=$4
      WHERE actor_id=$1 AND idempotency_key=$2`, [actor, key, result.status, JSON.stringify(result.body)]);
    return result;
  });
}

export interface Audit {
  actor: string; authority: string; action: string; resource: string; request: string;
  reason: string; evidence?: string; before?: unknown; after?: unknown; result?: string;
}
export async function record(sql: Sql, audit: Audit) {
  await sql.query(`INSERT INTO audit_events
    (id,actor_id,authority,action,resource_id,request_id,reason,evidence_ref,before_state,after_state,result)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), audit.actor, audit.authority,
    audit.action, audit.resource, audit.request, audit.reason, audit.evidence ?? null,
    JSON.stringify(audit.before ?? null), JSON.stringify(audit.after ?? null), audit.result ?? 'succeeded']);
  await sql.query(`INSERT INTO outbox(id,event_type,aggregate_id,payload) VALUES ($1,$2,$3,$4)`,
    [randomUUID(), `${audit.action}.v1`, audit.resource,
      JSON.stringify({ resource_id: audit.resource, request_id: audit.request, result: audit.result ?? 'succeeded' })]);
}

export async function consumeOnce(db: Database, consumer: string, event: string, work: (sql: Sql) => Promise<void>) {
  return db.transaction(async sql => {
    const inserted = await sql.query(`INSERT INTO inbox(consumer,event_id) VALUES ($1,$2)
      ON CONFLICT DO NOTHING RETURNING event_id`, [consumer, event]);
    if (!inserted.rows.length) return false;
    await work(sql);
    return true;
  });
}
