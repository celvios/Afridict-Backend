import { Pool } from 'pg';

export interface Sql {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Sql {
  transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export function postgres(url: string): Database {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000, statement_timeout: 10000, application_name: 'afridict-api' });
  return {
    query: async <T>(text: string, values?: unknown[]) => ({ rows: (await pool.query(text, values)).rows as T[] }),
    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '5s'");
        const result = await work({ query: async <T>(text: string, values?: unknown[]) =>
          ({ rows: (await client.query(text, values)).rows as T[] }) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}
