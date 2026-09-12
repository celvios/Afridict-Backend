import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Database } from './database.js';

export async function migrate(db: Database, directory = new URL('../../migrations/', import.meta.url)) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    await db.transaction(async tx => {
      await tx.query('LOCK TABLE schema_migrations IN EXCLUSIVE MODE');
      const existing = (await tx.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1', [name])).rows[0];
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Migration checksum mismatch: ${name}`);
        return;
      }
      await tx.query(sql);
      await tx.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [name, checksum]);
    });
  }
}
