import { buildApp } from './app.js';
import { config } from './platform/config.js';
import { postgres } from './platform/database.js';

const cfg = config();
if (cfg.authMode === 'demo') throw new Error('Use npm run demo for the isolated synthetic environment');
if (!cfg.databaseUrl) throw new Error('DATABASE_URL is required');
const db = postgres(cfg.databaseUrl);
const app = await buildApp(db, cfg);
try {
  await db.query('SELECT id FROM accounts LIMIT 1');
  if (cfg.environment === 'production') {
    const privileges = (await db.query<{ audit_update: boolean; audit_delete: boolean; registry_update: boolean;
      role_update: boolean; journal_update: boolean; journal_delete: boolean; journal_truncate: boolean;
      entry_update: boolean; entry_delete: boolean; entry_truncate: boolean; asset_update: boolean; wallet_update:boolean }>(`
      SELECT has_table_privilege(current_user,'audit_events','UPDATE') AS audit_update,
      has_table_privilege(current_user,'audit_events','DELETE') AS audit_delete,
      has_table_privilege(current_user,'policy_registry','UPDATE') AS registry_update,
      has_table_privilege(current_user,'accounts','UPDATE') AS role_update,
      has_table_privilege(current_user,'ledger_journals','UPDATE') AS journal_update,
      has_table_privilege(current_user,'ledger_journals','DELETE') AS journal_delete,
      has_table_privilege(current_user,'ledger_journals','TRUNCATE') AS journal_truncate,
      has_table_privilege(current_user,'ledger_entries','UPDATE') AS entry_update,
      has_table_privilege(current_user,'ledger_entries','DELETE') AS entry_delete,
      has_table_privilege(current_user,'ledger_entries','TRUNCATE') AS entry_truncate,
      has_table_privilege(current_user,'financial_assets','UPDATE') AS asset_update,
      has_table_privilege(current_user,'smart_accounts','UPDATE') AS wallet_update`)).rows[0];
    if (!privileges || Object.values(privileges).some(Boolean))
      throw new Error('Runtime database role has excessive privileges');
  }
  await app.listen({ host: cfg.host, port: cfg.port });
} catch {
  app.log.error('Startup failed; verify database migration and service configuration.');
  await app.close(); await db.close(); process.exitCode = 1;
}
async function stop() { await app.close(); await db.close(); }
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
