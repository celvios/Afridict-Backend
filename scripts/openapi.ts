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
  '401': 'UNAUTHENTICATED. Obtain a valid access token from the configured provider.',
  '403': 'FORBIDDEN, ACCOUNT_RESTRICTED, ONBOARDING_REQUIRED, SEPARATION_OF_DUTIES or COUNTRY_POLICY_BLOCKED. Do not retry without resolving authorization or policy.',
  '404': 'NOT_FOUND. Resource does not exist or is not visible to this caller.',
  '409': 'IDEMPOTENCY_CONFLICT, VERSION_OR_STATE_CONFLICT, JURISDICTION_CONFLICT, PROPOSAL_CONFLICT, REVIEW_ALREADY_RECORDED or REVIEWS_REQUIRED. Refresh resource state; changed commands need a new idempotency key.',
  '413': 'VALIDATION_FAILED. Request body exceeds the configured size limit.',
  '415': 'UNSUPPORTED_MEDIA_TYPE. Use application/json.',
  '422': 'INVALID_MARKET_POLICY, TEMPLATE_NOT_APPROVED, SOURCE_NOT_APPROVED or POLICY_NOT_APPROVED. Correct policy semantics or use approved registry entries.',
  '429': 'RATE_LIMITED. Observe Retry-After and retry with the original command key.',
  '500': 'INTERNAL_ERROR. Contact support with X-Request-Id; do not assume a command failed to commit.',
  '503': 'DEPENDENCY_UNAVAILABLE or IDENTITY_UNAVAILABLE. Retry after the indicated delay using the same command key.',
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
