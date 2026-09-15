import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { ledgerAccount, postJournal } from '../src/financial/ledger.js';
import type { Database } from '../src/platform/database.js';
import { migrate } from '../src/platform/migrations.js';
import { embeddedDatabase } from './embedded.js';
import { demoAuth, demoConfig, seedDemo, terms } from './fixtures.js';

const MINUTE = 60_000;

export function currentDemoTerms(type: 'binary' | 'categorical' | 'scalar', now = Date.now()) {
  const policy = terms(type);
  policy.open_at = new Date(now + 5_000).toISOString();
  policy.trading_cutoff = new Date(now + 24 * 60 * MINUTE).toISOString();
  policy.expected_event_at = new Date(now + 48 * 60 * MINUTE).toISOString();
  policy.resolution_deadline = new Date(now + 8 * 24 * 60 * MINUTE).toISOString();
  policy.risk.exposure_limit_minor = '100000000';
  return policy;
}

export async function createTradingDemo(): Promise<{ app: FastifyInstance; db: Database; marketIds: string[] }> {
  const db = await embeddedDatabase();
  let app: FastifyInstance | undefined;
  try {
    await migrate(db);
    const identities = await seedDemo(db);
    await db.query("UPDATE country_policies SET trading_enabled=true WHERE jurisdiction='ZZ' AND category='weather'");
    await db.query("UPDATE eligibility SET status='eligible' WHERE account_id = ANY($1::uuid[])",
      [[identities.trader, identities.proposer, identities.creator, identities.other_creator]]);
    await db.query(`INSERT INTO clob_asset_bindings(policy_ref,asset_code,approved,evidence_ref)
      VALUES ('demo:collateral','DEMO',true,'synthetic-demo-only')`);
    for (const who of ['trader', 'proposer', 'creator', 'other_creator']) {
      await db.transaction(async sql => {
        const escrow = await ledgerAccount(sql, null, 'DEMO', 'escrow_asset');
        const available = await ledgerAccount(sql, identities[who]!, 'DEMO', 'user_available');
        await postJournal(sql, { effectId: `demo:collateral:${who}`, asset: 'DEMO', kind: 'deposit_finalized',
          referenceId: identities[who]!, reason: 'Isolated synthetic trading collateral', lines: [
            { account: escrow, debit: 50_000_000n, credit: 0n },
            { account: available, debit: 0n, credit: 50_000_000n },
          ] });
      });
    }

    app = await buildApp(db, { ...demoConfig, environment: 'development' }, demoAuth);
    let sequence = 0;
    async function send(persona: string, url: string, payload: unknown) {
      const response = await app!.inject({ method: 'POST', url,
        headers: { authorization: `Bearer demo.${persona}`, 'idempotency-key': `demo_seed_${++sequence}` },
        payload: payload as Record<string, unknown> });
      if (response.statusCode >= 400) throw new Error(`Demo setup failed (${response.statusCode}): ${response.body}`);
      return response.json<{ id: string }>();
    }

    const marketIds: string[] = [];
    const policies = (['binary', 'categorical', 'scalar'] as const).map(type => currentDemoTerms(type));
    for (const policy of policies) {
      const market = await send('creator', '/v1/admin/markets', { terms: policy });
      marketIds.push(market.id);
      await send('creator', `/v1/admin/markets/${market.id}/submit`,
        { expected_version: 1, reason: 'Synthetic frontend fixture' });
      for (const [review, persona] of [['product', 'approver'], ['legal', 'legal'],
        ['integrity', 'integrity'], ['resolution', 'resolution']]) {
        await send(persona!, `/v1/admin/markets/${market.id}/reviews`, {
          expected_version: 1, review_type: review, decision: 'approved',
          reason: 'Synthetic review only', evidence_ref: 'demo:review',
        });
      }
      await send('approver', `/v1/admin/markets/${market.id}/publish`,
        { expected_version: 1, reason: 'Synthetic metadata only' });
    }

    const opening = Math.max(...policies.map(policy => Date.parse(policy.open_at)));
    if (Date.now() < opening) await new Promise(resolve => setTimeout(resolve, opening - Date.now()));
    for (const [index, marketId] of marketIds.entries()) {
      const outcomeId = policies[index]!.outcomes[0]!.id;
      await send('approver', `/v1/admin/markets/${marketId}/trading/activate`, {});
      await send('proposer', `/v1/markets/${marketId}/orders`,
        { outcome_id: outcomeId, side: 'sell', limit_price: '600000', quantity: '3' });
      await send('trader', `/v1/markets/${marketId}/orders`,
        { outcome_id: outcomeId, side: 'buy', limit_price: '400000', quantity: '2' });
      await send('creator', `/v1/markets/${marketId}/orders`,
        { outcome_id: outcomeId, side: 'buy', limit_price: '650000', quantity: '1' });
    }
    return { app, db, marketIds };
  } catch (error) {
    if (app) await app.close();
    await db.close();
    throw error;
  }
}
