import { PGlite } from '@electric-sql/pglite';
import type { Database, Sql } from '../src/platform/database.js';

// Embedded PostgreSQL is used only for isolated tests and frontend demos.
// Serialize access so unrelated queries cannot enter another caller's transaction.
export async function embeddedDatabase(): Promise<Database> {
  const pg = new PGlite();
  await pg.waitReady;
  let queue = Promise.resolve();
  const exclusive = async <T>(fn: () => Promise<T>) => {
    const prior = queue; let release!: () => void;
    queue = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await fn(); } finally { release(); }
  };
  const sql: Sql = { async query<T>(text: string, values?: unknown[]) {
    if (!values && text.includes(';')) { await pg.exec(text); return { rows: [] as T[] }; }
    return { rows: (await pg.query<T>(text, values)).rows };
  } };
  return {
    query: (text, values) => exclusive(() => sql.query(text, values)),
    transaction: work => exclusive(async () => {
      await pg.exec('BEGIN');
      try { const result = await work(sql); await pg.exec('COMMIT'); return result; }
      catch (error) { await pg.exec('ROLLBACK'); throw error; }
    }),
    close: () => exclusive(() => pg.close()),
  };
}
