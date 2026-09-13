import { randomUUID } from 'node:crypto';
import type { Database } from '../src/platform/database.js';
import type { MarketTerms } from '../src/contracts.js';
import type { Authenticator } from '../src/identity/auth.js';
import { AppError } from '../src/platform/errors.js';
import type { Config } from '../src/platform/config.js';

export const demoConfig: Config = { environment: 'test', host: '127.0.0.1', port: 3000,
  authMode: 'demo', corsOrigins: ['http://localhost:5173','http://localhost:3001'], docs: true, logger: false,
  financialMode: 'synthetic',authMethods:[] };
export const personas: Record<string, string[]> = {
  trader: ['user'], creator: ['user','market_creator'], other_creator: ['user','market_creator'],
  approver: ['user','market_approver'], legal: ['user','legal_reviewer'], integrity: ['user','integrity_reviewer'],
  resolution: ['user','resolution_reviewer'], compliance: ['user','compliance_officer'],
  other_compliance: ['user','compliance_officer'], proposer: ['user','market_proposer'], auditor: ['user','auditor'],
  finance: ['user','finance_operator'],
};
export const demoAuth: Authenticator = { async verify(token) {
  const name = token.startsWith('demo.') ? token.slice(5) : '';
  if (!(name in personas) && name !== 'new_user') throw new AppError(401, 'UNAUTHENTICATED', 'Select a known synthetic demo persona.');
  return { issuer: 'urn:afridict:synthetic-demo', subject: name, expiresAt: new Date(Date.now() + 3600000).toISOString() };
} };
export function terms(type: 'binary' | 'categorical' | 'scalar' = 'binary'): MarketTerms {
  return {
    question: `Synthetic ${type} demonstration: what rainfall result will the example station report?`,
    market_type: type, template_id: `demo-${type}`, template_version: 1,
    outcomes: type === 'binary' ? [{ id: 'yes', label: 'Yes' },{ id: 'no', label: 'No' }] :
      type === 'scalar' ? [{ id: 'short', label: 'Lower rainfall' },{ id: 'long', label: 'Higher rainfall' }] :
        [{ id: 'dry', label: 'Dry' },{ id: 'normal', label: 'Normal' },{ id: 'wet', label: 'Wet' }],
    ...(type === 'scalar' ? { scalar_range: { lower: '0', upper: '10000', decimals: 2, unit: 'millimetres' } } : {}),
    category: 'weather', jurisdictions: ['ZZ'], open_at: '2099-01-01T00:00:00.000Z',
    trading_cutoff: '2099-01-02T00:00:00.000Z', expected_event_at: '2099-01-03T00:00:00.000Z', resolution_deadline: '2099-01-10T00:00:00.000Z',
    resolution: { criteria: 'Synthetic policy only: use the named daily rainfall edition and the selected outcome boundaries.',
      timezone: 'Africa/Lagos', method: 'bonded_proposal',
      primary_source: { name: 'Synthetic primary source', uri: 'https://example.com/synthetic/primary' },
      fallback_sources: [{ name: 'Synthetic fallback source', uri: 'https://example.org/synthetic/fallback' }],
      correction_rule: 'Use corrections received before the challenge window ends.',
      cancellation_rule: 'Cancel under the published payout policy when no valid observation exists by the deadline.',
      invalid_rule: 'Use the approved invalid-outcome payout vector when evidence cannot resolve the question.',
      challenge_window_seconds: 86400, timelock_seconds: 3600, panel_size: 3, adjudication_threshold: 2,
      adjudicator_policy_ref: 'demo:adjudication-v1', bond_policy_ref: 'demo:bond-v1', payout_policy_ref: 'demo:payout-v1' },
    risk: { classification: 'standard', eligibility_policy_ref: 'demo:eligibility-v1', exposure_limit_minor: '1000000', fee_bps: 100, settlement_asset_ref: 'demo:collateral' },
    liquidity: { clob: true, amm_enabled: false, rfq_enabled: true, subsidy_limit_minor: '0', inventory_limit_minor: '0', loss_limit_minor: '0', max_slippage_bps: 100 },
  };
}
export async function seedDemo(db: Database) {
  const ids: Record<string,string> = {};
  await db.transaction(async sql => {
    for (const [name, roles] of Object.entries(personas)) {
      const id = randomUUID(); ids[name] = id;
      await sql.query('INSERT INTO accounts(id,issuer,subject,jurisdiction,roles) VALUES ($1,$2,$3,$4,$5)',
        [id, 'urn:afridict:synthetic-demo', name, 'ZZ', roles]);
      await sql.query("INSERT INTO eligibility(account_id,status,policy_version) VALUES ($1,'pending','demo:unreviewed')", [id]);
      await sql.query(`INSERT INTO account_assurance(account_id,email_verified_at,phone_verified_at,identity_status,identity_evidence_ref)
        VALUES ($1,now(),now(),'VERIFIED','synthetic-demo-only')`,[id]);
      await sql.query(`INSERT INTO smart_accounts(owner_id,chain_id,address,status,recovery_policy_ref)
        VALUES ($1,46630,$2,'active','synthetic-demo-only')`,[id,`0x${id.replace(/-/g,'').padStart(40,'0')}`]);
    }
    await sql.query(`INSERT INTO financial_assets(code,scale,synthetic,approved,evidence_ref)
      VALUES ('DEMO',6,true,true,'synthetic-demo-only')`);
    await sql.query(`UPDATE financial_assets SET synthetic=true,approved=true,evidence_ref='synthetic-demo-only'
      WHERE code IN ('NGN','USD')`);
    for (const type of ['binary','categorical','scalar']) await sql.query(`INSERT INTO market_templates(id,version,market_type,approved,evidence_ref)
      VALUES ($1,1,$2,true,'synthetic-demo-only')`, [`demo-${type}`, type]);
    await sql.query(`INSERT INTO country_policies(jurisdiction,category,policy_version,publication_allowed,evidence_ref)
      VALUES ('ZZ','weather','demo:v1',true,'synthetic-demo-only')`);
    for (const source of [
      { name: 'Synthetic primary source', uri: 'https://example.com/synthetic/primary' },
      { name: 'Synthetic fallback source', uri: 'https://example.org/synthetic/fallback' },
    ]) await sql.query(`INSERT INTO evidence_sources(name,uri,approved,evidence_ref)
      VALUES ($1,$2,true,'synthetic-demo-only')`, [source.name, source.uri]);
    for (const [kind, ref] of [['eligibility','demo:eligibility-v1'], ['adjudication','demo:adjudication-v1'],
      ['bond','demo:bond-v1'], ['payout','demo:payout-v1'], ['collateral','demo:collateral']])
      await sql.query(`INSERT INTO policy_registry(kind,policy_ref,approved,evidence_ref)
        VALUES ($1,$2,true,'synthetic-demo-only')`, [kind, ref]);
    await sql.query(`INSERT INTO policy_registry(kind,policy_ref,approved,evidence_ref)
      VALUES ('finality','demo:finality-v1',true,'synthetic-demo-only')`);
  });
  return ids;
}
