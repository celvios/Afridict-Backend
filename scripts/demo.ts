import { buildApp } from '../src/app.js';
import { migrate } from '../src/platform/migrations.js';
import { embeddedDatabase } from './embedded.js';
import { demoAuth, demoConfig, personas, seedDemo, terms } from './fixtures.js';

if (process.env.NODE_ENV === 'production') throw new Error('The demo cannot run in production');
const db = await embeddedDatabase();
await migrate(db); await seedDemo(db);
const app = await buildApp(db, { ...demoConfig, environment: 'development' }, demoAuth);
let sequence = 0;
async function send(persona: string, url: string, payload: unknown) {
  const response = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer demo.${persona}`, 'idempotency-key': `demo_seed_${++sequence}` }, payload: payload as Record<string, unknown> });
  if (response.statusCode >= 400) throw new Error(`Demo setup failed: ${response.body}`);
  return response.json<{ id: string }>();
}
for (const type of ['binary','categorical','scalar'] as const) {
  const market = await send('creator','/v1/admin/markets', { terms: terms(type) });
  await send('creator',`/v1/admin/markets/${market.id}/submit`, { expected_version: 1, reason: 'Synthetic frontend fixture' });
  for (const [review, persona] of [['product','approver'],['legal','legal'],['integrity','integrity'],['resolution','resolution']])
    await send(persona!,`/v1/admin/markets/${market.id}/reviews`, { expected_version: 1, review_type: review, decision: 'approved', reason: 'Synthetic review; no legal or operational approval', evidence_ref: 'demo:review' });
  await send('approver',`/v1/admin/markets/${market.id}/publish`, { expected_version: 1, reason: 'Synthetic metadata only' });
}
await app.listen({ host: '127.0.0.1', port: 3000 });
console.log('Synthetic frontend demo: http://127.0.0.1:3000/docs');
console.log('Bearer demo.<persona> selects a synthetic persona:', Object.keys(personas).join(', '));
console.log('All data is synthetic and disappears on shutdown. No external identity, payments or chain transactions.');
async function stop() { await app.close(); await db.close(); }
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
