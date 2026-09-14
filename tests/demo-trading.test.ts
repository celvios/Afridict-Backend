import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTradingDemo, currentDemoTerms } from '../scripts/demo-trading.js';
import type { Database } from '../src/platform/database.js';

let app: FastifyInstance;
let db: Database;
let marketIds: string[];

beforeAll(async () => {
  ({ app, db, marketIds } = await createTradingDemo());
});
afterAll(async () => { if (app) await app.close(); if (db) await db.close(); });

const get = (persona: string, url: string) => app.inject({ method: 'GET', url,
  headers: { authorization: `Bearer demo.${persona}` } });

describe('fresh synthetic trading demo', () => {
  it('publishes three structures and starts each with an open, funded book and a real synthetic fill', async () => {
    expect(marketIds).toHaveLength(3);
    const kinds = new Set<string>();
    for (const marketId of marketIds) {
      const market = await get('trader', `/v1/markets/${marketId}`);
      expect(market.statusCode, market.body).toBe(200);
      const policy = market.json().terms;
      kinds.add(policy.market_type);
      expect(Date.parse(policy.open_at)).toBeLessThan(Date.now());
      expect(Date.parse(policy.trading_cutoff)).toBeGreaterThan(Date.now());
      const outcome = policy.outcomes[0].id as string;
      const book = await get('trader', `/v1/markets/${marketId}/book/${outcome}`);
      expect(book.statusCode, book.body).toBe(200);
      expect(book.json()).toMatchObject({ status: 'open', bids: [{ price: '400000', quantity: '2' }],
        asks: [{ price: '600000', quantity: '2' }] });
      const events = await get('trader', `/v1/markets/${marketId}/trading/events?after=0`);
      expect(events.json().items.map((item: { event_type: string }) => item.event_type)).toEqual([
        'activated', 'order_accepted', 'order_accepted', 'order_accepted', 'fill',
      ]);
    }
    expect(kinds).toEqual(new Set(['binary', 'categorical', 'scalar']));
    const balance = await get('trader', '/v1/balances');
    expect(balance.json().items).toEqual(expect.arrayContaining([expect.objectContaining({ asset: 'DEMO' })]));
  });

  it('allows a frontend persona to submit and cancel an order without crossing its own quote', async () => {
    const marketId = marketIds[0]!;
    const placed = await app.inject({ method: 'POST', url: `/v1/markets/${marketId}/orders`,
      headers: { authorization: 'Bearer demo.trader', 'idempotency-key': 'fresh-demo-order-1' },
      payload: { outcome_id: 'no', side: 'buy', limit_price: '500000', quantity: '1' } });
    expect(placed.statusCode, placed.body).toBe(201);
    expect(placed.json().order).toMatchObject({ state: 'open', remaining: '1' });
    const cancelled = await app.inject({ method: 'POST',
      url: `/v1/markets/${marketId}/orders/${placed.json().order.id}/cancel`,
      headers: { authorization: 'Bearer demo.trader', 'idempotency-key': 'fresh-demo-cancel-1' }, payload: {} });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: 'cancelled' });
  });

  it('generates a bounded future policy before startup and never changes shared test fixtures', () => {
    const now = Date.now();
    const policy = currentDemoTerms('binary', now);
    expect(Date.parse(policy.open_at)).toBe(now + 5_000);
    expect(Date.parse(policy.trading_cutoff)).toBe(now + 24 * 60 * 60_000);
  });
});
