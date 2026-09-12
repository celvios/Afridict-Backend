import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import type { Database } from '../src/platform/database.js';
import { demoAuth, demoConfig, terms } from './fixtures.js';

const unavailable = async (): Promise<never> => { throw new Error('Contract generation must not access storage'); };
const db: Database = { query: unavailable, transaction: unavailable, close: async () => {} };
const app = await buildApp(db, { ...demoConfig, docs: false }, demoAuth);
const spec = app.swagger() as unknown as { components: { schemas: Record<string, Record<string, unknown>> }; paths: Record<string, Record<string, { responses?: Record<string, { description?: string; headers?: unknown }> }>> };
spec.components.schemas.MarketTerms!.examples = [terms('binary'), terms('categorical'), terms('scalar')];
const descriptions: Record<string,string> = {
  '400': 'VALIDATION_FAILED or INVALID_CURSOR. Correct the request before retrying.',
  '401': 'UNAUTHENTICATED or INVALID_PARTNER_SIGNATURE. Obtain valid caller or partner authentication.',
  '403': 'FORBIDDEN, ACCOUNT_RESTRICTED, ONBOARDING_REQUIRED, SEPARATION_OF_DUTIES or COUNTRY_POLICY_BLOCKED. Do not retry without resolving authorization or policy.',
  '404': 'NOT_FOUND. Resource does not exist or is not visible to this caller.',
  '409': 'Idempotency, workflow version, collateral, reservation, withdrawal or governance conflict. Refresh state; changed commands need a new idempotency key.',
  '413': 'VALIDATION_FAILED. Request body exceeds the configured size limit.',
  '415': 'UNSUPPORTED_MEDIA_TYPE. Use application/json.',
  '422': 'Invalid amount, asset, journal, market policy, template, source or policy reference. Correct semantic input before retrying.',
  '429': 'RATE_LIMITED. Observe Retry-After and retry with the original command key.',
  '500': 'INTERNAL_ERROR. Contact support with X-Request-Id; do not assume a command failed to commit.',
  '503': 'Dependency, identity, financial integration or partner adapter unavailable. Retry only transient failures with the same command key.',
};
for (const path of Object.values(spec.paths)) for (const operation of Object.values(path)) {
  if (!operation.responses) continue;
  for (const [status,response] of Object.entries(operation.responses)) {
    response.description = descriptions[status] ?? 'Successful result; see the operation description for what is committed.';
    response.headers = { 'X-Request-Id': { description: 'Server-issued correlation identifier.', schema: { type: 'string' } },
      ...(['429','503'].includes(status) ? { 'Retry-After': { description: 'Minimum delay in seconds before retrying.', schema: { type: 'integer', minimum: 1 } } } : {}) };
  }
}
await writeFile('api/openapi.json', JSON.stringify(spec,null,2) + '\n');
await writeFile('api/market-examples.json', JSON.stringify({ synthetic: true, examples: [terms('binary'),terms('categorical'),terms('scalar')] },null,2) + '\n');
await app.close();
