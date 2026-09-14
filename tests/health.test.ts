import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { demoAuth, demoConfig } from '../scripts/fixtures.js';
import { buildApp } from '../src/app.js';
import type { Database, Sql } from '../src/platform/database.js';

const apps: FastifyInstance[] = [];

function database(failureCode?: string): Database {
  const query: Sql['query'] = async <T>() => {
    if (failureCode) throw Object.assign(new Error('Dependency failed'), { code: failureCode });
    return { rows: [] as T[] };
  };
  return { query, transaction: work => work({ query }), close: async () => {} };
}

afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('operational health endpoints', () => {
  it('reports process liveness without depending on PostgreSQL', async () => {
    const app = await buildApp(database('ECONNREFUSED'), demoConfig, demoAuth);
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness only after the required schema can be queried', async () => {
    const ready = await buildApp(database(), demoConfig, demoAuth);
    const unavailable = await buildApp(database('ECONNREFUSED'), demoConfig, demoAuth);
    apps.push(ready, unavailable);
    expect((await ready.inject({ method: 'GET', url: '/health/ready' })).json()).toEqual({ status: 'ready' });
    const failed = await unavailable.inject({ method: 'GET', url: '/health/ready' });
    expect(failed.statusCode).toBe(503);
    expect(failed.headers['retry-after']).toBe('2');
    expect(failed.json()).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });
});
