import Fastify, { LogController, type FastifyRequest, type FastifySchema } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { createHash, randomUUID } from 'node:crypto';
import type { Config } from './platform/config.js';
import type { Database, Sql } from './platform/database.js';
import { AppError, requireCondition } from './platform/errors.js';
import { command, hash, record } from './platform/commands.js';
import { findAccount, hasRole, oidcAuthenticator, publicAccount, type Account, type Authenticator, type Principal } from './identity/auth.js';
import { schemas, AccountSchema, EligibilitySchema, ErrorSchema, IdParams, IdempotencyHeaders,
  Terms, MarketSchema, ProposalSchema, ReviewSchema, ReviewCommand, VersionCommand, ListQuery,
  Reason, EvidenceRef, EligibilityReviewSchema, Country, UUID, Timestamp, Uint, object, text, type MarketTerms } from './contracts.js';
import { approvedTemplate, approvedReferences, createDraft, editDraft, getMarket, mayReadDraft, publicMarket, publish, reviewMarket,
  submitDraft, type MarketRow } from './markets/service.js';
import { validateTerms } from './markets/domain.js';
import { financialSchemas, FinancialAssetSchema, BalanceSchema, DepositSchema, WithdrawalSchema,
  ReconciliationSchema, StatementSchema, SmartAccountSchema } from './funding/contracts.js';
import { applyPartnerDeposit, createDepositIntent, createWithdrawal, cancelWithdrawal, finalizeDeposit,
  finalizeWithdrawal, markWithdrawalUncertain, publicDeposit, publicWithdrawal, submitWithdrawal,
  type PartnerVerifier } from './funding/service.js';
import { walletBalances } from './financial/ledger.js';
import { reconcile } from './financial/reconciliation.js';

type Request = FastifyRequest;
type Context = { sql: Sql; actor: Account; principal: Principal; request: Request };
type Work = (context: Context) => Promise<{ status: number; body: unknown }>;
const errorResponses: Record<number, TSchema> = Object.fromEntries([400,401,403,404,409,413,415,422,429,500,503]
  .map(code => [code, Type.Ref(ErrorSchema)]));
function contract(id: string, tag: string, summary: string, description: string, response: TSchema,
  options: { body?: TSchema; params?: TSchema; querystring?: TSchema; headers?: TSchema; status?: number; public?: boolean; roles?: string[]; command?: boolean } = {}): FastifySchema {
  return { operationId: id, tags: [tag], summary, description,
    security: options.public ? [] : [{ bearerAuth: [] }],
    ...(options.roles ? { 'x-required-roles': options.roles } : {}),
    ...(options.command ? { headers: IdempotencyHeaders } : options.headers ? {headers:options.headers} : {}),
    ...(options.body ? { body: options.body } : {}), ...(options.params ? { params: options.params } : {}),
    ...(options.querystring ? { querystring: options.querystring } : {}),
    response: { [options.status ?? 200]: response, ...errorResponses } } as FastifySchema;
}

export async function buildApp(db: Database, cfg: Config, authOverride?: Authenticator, partnerVerifier?: PartnerVerifier) {
  if (cfg.environment === 'production' && (cfg.authMode !== 'oidc' || authOverride)) throw new Error('Production requires the configured OIDC verifier');
  if (cfg.environment === 'production' && cfg.financialMode !== 'disabled') throw new Error('Financial activation requires approved adapters and governance');
  const auth = authOverride ?? oidcAuthenticator(cfg);
  const app = Fastify({ logger: cfg.logger ? { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'req.body', 'res.headers.set-cookie'] } : false,
    logController: new LogController({ disableRequestLogging: true }), requestIdHeader: false, genReqId: () => `req_${randomUUID()}`,
    bodyLimit: 32768, requestTimeout: 15000, connectionTimeout: 10000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: 'array', allErrors: false } } });
  await app.register(helmet);
  await app.register(cors, { origin: cfg.corsOrigins, credentials: false, allowedHeaders: ['Authorization','Content-Type','Idempotency-Key'],
    exposedHeaders: ['X-Request-Id','Retry-After'], methods: ['GET','POST','PUT','OPTIONS'] });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute', global: true,
    errorResponseBuilder: req => ({ code: 'RATE_LIMITED', message: 'Request limit exceeded. Retry after the indicated delay.', request_id: req.id }) });
  await app.register(swagger, { openapi: { openapi: '3.1.1',
    info: { title: 'Afridict Backend API', version: '0.3.0', description: 'Identity, governance and financial workflow API. Financial commands execute only in the isolated synthetic demo; no real payment partner, chain indexer, custody activation, trading or resolution is available. Production access requires approved adapters and governance.' },
    servers: [{ url: 'http://127.0.0.1:3000', description: 'Local development only; not a production address' }],
    tags: ['System','Identity','Compliance','Markets','Governance','Proposals','Audit','Funding','Portfolio','Finance','Synthetic'].map(name => ({ name, description: `${name} operations` })),
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
      description: 'OIDC access token verified against configured issuer, audience and JWKS. Roles come from server-owned account records. Demo mode accepts only synthetic demo.<persona> selectors; those never work in production.' } } },
  }, refResolver: { buildLocalReference: json => String(json.$id) } });
  for (const schema of [...schemas,...financialSchemas]) app.addSchema(schema);
  if (cfg.docs) await app.register(swaggerUi, { routePrefix: '/docs', staticCSP: true });
  app.addHook('onRequest', async (request, reply) => { reply.header('X-Request-Id', request.id); reply.header('Cache-Control', 'no-store'); });
  app.addHook('onResponse', async (request, reply) => {
    // Never log URL queries, payloads, provider subjects, credentials or evidence.
    request.log.info({ request_id: request.id, operation: request.routeOptions.schema?.operationId,
      status: reply.statusCode, elapsed_ms: reply.elapsedTime }, 'request completed');
  });
  app.setErrorHandler((error, request, reply) => {
    let status = 500, code = 'INTERNAL_ERROR', message = 'The request could not be completed.';
    const failure = error as { validation?: unknown; statusCode?: number; code?: string };
    if (error instanceof AppError) ({ statusCode: status, code, message } = error);
    else if (failure.validation || failure.statusCode === 400 || failure.statusCode === 413) {
      status = failure.statusCode === 413 ? 413 : 400; code = 'VALIDATION_FAILED'; message = 'The request does not satisfy the operation schema.';
    } else if (failure.statusCode === 415) { status = 415; code = 'UNSUPPORTED_MEDIA_TYPE'; message = 'Use application/json for request bodies.'; }
    else if (failure.statusCode === 429) { status = 429; code = 'RATE_LIMITED'; message = 'Request limit exceeded.'; }
    else if (['40001','40P01','55P03','57014','ECONNREFUSED','ECONNRESET','ETIMEDOUT','57P01','08006'].includes(failure.code ?? '')) {
      status = 503; code = 'DEPENDENCY_UNAVAILABLE'; message = 'The operation is temporarily unavailable. Retry commands with the same idempotency key.';
    }
    if (status >= 500) request.log.error({ request_id: request.id, code }, 'request failed');
    if (status === 401) reply.header('WWW-Authenticate', 'Bearer');
    if (status === 503) reply.header('Retry-After', '2');
    return reply.code(status).send({ code, message, request_id: request.id });
  });
  app.setNotFoundHandler((request, reply) => reply.code(404).send({ code: 'NOT_FOUND', message: 'Route not found.', request_id: request.id }));
  const principal = async (request: Request) => {
    const header = request.headers.authorization;
    requireCondition(header, 401, 'UNAUTHENTICATED', 'A valid bearer access token is required.');
    requireCondition(header.startsWith('Bearer ') && header.length <= 8192, 401, 'UNAUTHENTICATED', 'A valid bearer access token is required.');
    return auth.verify(header.slice(7));
  };
  const authenticated = async (request: Request, roles: string[] = []) => {
    const p = await principal(request); const a = await findAccount(db, p);
    if (roles.length) hasRole(a, ...roles); return { p, a };
  };
  const run = (roles: string[], work: Work) => async (request: Request, reply: import('fastify').FastifyReply) => {
    const p = await principal(request);
    let actor: Account;
    const result = await command(db, hash({ issuer: p.issuer, subject: p.subject }), String(request.headers['idempotency-key']),
      { operation: request.routeOptions.schema?.operationId, params: request.params, body: request.body ?? null },
      async sql => { actor = await findAccount(sql, p, true); if (roles.length) hasRole(actor, ...roles); },
      sql => work({ sql, actor, principal: p, request }));
    return reply.code(result.status).send(result.body);
  };
  const id = (req: Request) => (req.params as { id: string }).id;

  app.get('/health/live', { schema: contract('getLiveness','System','Check process liveness','Returns process liveness; does not prove database, partner or chain readiness.', object({ status: Type.Literal('ok') }), { public: true }) }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { schema: contract('getReadiness','System','Check database readiness','Checks connectivity and that the governance schema exists. This is not a production financial-readiness assertion.', object({ status: Type.Literal('ready') }), { public: true }) }, async () => {
    await db.query('SELECT id FROM accounts LIMIT 1'); return { status: 'ready' };
  });
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  app.post('/v1/onboarding', { schema: contract('onboardAccount','Identity','Create an account from verified identity',
    'Creates only the user role and pending eligibility. The provider subject comes from the verified token, never the body. No wallet or KYC approval is implied. Repeat onboarding with the same jurisdiction returns the account; changing jurisdiction requires a future governed workflow.', Type.Ref(AccountSchema),
    { command: true, body: object({ jurisdiction: Country }) }) }, async (request, reply) => {
    const p = await principal(request); const jurisdiction = (request.body as { jurisdiction: string }).jurisdiction;
    const result = await command(db, hash({ issuer: p.issuer, subject: p.subject }), String(request.headers['idempotency-key']),
      { operation: 'onboardAccount', body: request.body }, async () => {}, async sql => {
        const inserted = await sql.query<Account>(`INSERT INTO accounts(id,issuer,subject,jurisdiction) VALUES ($1,$2,$3,$4)
          ON CONFLICT (issuer,subject) DO NOTHING RETURNING *`, [randomUUID(), p.issuer, p.subject, jurisdiction]);
        const a = await findAccount(sql, p, true);
        requireCondition(a.jurisdiction === jurisdiction, 409, 'JURISDICTION_CONFLICT', 'The account already has a different jurisdiction.');
        if (inserted.rows.length) {
          await sql.query("INSERT INTO eligibility(account_id,status,policy_version) VALUES ($1,'pending','unreviewed')", [a.id]);
          await record(sql, { actor: a.id, authority: 'authenticated_identity', action: 'account.onboarded', resource: a.id,
            request: request.id, reason: 'Self-service onboarding', after: publicAccount(a) });
        }
        return { status: 200, body: publicAccount(a) };
      });
    return reply.code(result.status).send(result.body);
  });
  app.get('/v1/me', { schema: contract('getCurrentAccount','Identity','Get the current account','Returns the caller account and server-assigned roles; provider subject and raw identity evidence are excluded.', Type.Ref(AccountSchema)) }, async req => publicAccount((await authenticated(req)).a));
  app.get('/v1/session', { schema: contract('getSession','Identity','Inspect the authenticated session','Returns token expiry and session/recovery ownership. Sign-in, MFA, refresh, logout and recovery are owned by the configured OIDC provider; this API does not store refresh tokens. Account restrictions are checked on each request.', object({ account_id: UUID, expires_at: Timestamp, authentication: Type.String({ enum: ['oidc','synthetic_demo'] }), recovery: Type.Literal('identity_provider') })) }, async req => {
    const { a, p } = await authenticated(req); return { account_id: a.id, expires_at: p.expiresAt,
      authentication: cfg.authMode === 'demo' ? 'synthetic_demo' : 'oidc', recovery: 'identity_provider' };
  });
  app.get('/v1/eligibility', { schema: contract('getEligibility','Identity','Get current eligibility','Returns the governed eligibility decision. Trading remains disabled in this release even when eligibility is approved. Missing review defaults to pending.', Type.Ref(EligibilitySchema)) }, async req => {
    const { a } = await authenticated(req);
    const row = (await db.query<{ status: string; policy_version: string; updated_at: Date }>('SELECT * FROM eligibility WHERE account_id=$1', [a.id])).rows[0];
    return { account_id: a.id, status: row?.status ?? 'pending', policy_version: row?.policy_version ?? 'unreviewed',
      updated_at: new Date(row?.updated_at ?? a.created_at).toISOString(), trading_enabled: false,
      reason_codes: row?.status === 'eligible' ? ['TRADING_NOT_ACTIVATED'] : ['ELIGIBILITY_NOT_APPROVED','TRADING_NOT_ACTIVATED'] };
  });

  app.post('/v1/admin/accounts/:id/eligibility-reviews', { schema: contract('proposeEligibility','Compliance','Propose an eligibility decision',
    'Requires compliance_officer. Creates a pending change with evidence reference and reason. It does not grant eligibility until a different compliance actor approves. Raw KYC data is forbidden.', Type.Ref(EligibilityReviewSchema),
    { params: IdParams, command: true, status: 201, roles: ['compliance_officer'], body: object({ decision: Type.String({ enum: ['eligible','restricted'] }), policy_version: text('Approved policy registry reference.',100), evidence_ref: EvidenceRef, reason: Reason }) }) },
  run(['compliance_officer'], async ({ sql, actor, request }) => {
    const b = request.body as { decision: string; policy_version: string; evidence_ref: string; reason: string };
    requireCondition((await sql.query('SELECT id FROM accounts WHERE id=$1', [id(request)])).rows.length, 404, 'NOT_FOUND', 'Account not found.');
    requireCondition(actor.id !== id(request), 403, 'SEPARATION_OF_DUTIES', 'You cannot propose your own eligibility decision.');
    const row = (await sql.query(`INSERT INTO eligibility_reviews(id,account_id,proposer_id,decision,policy_version,evidence_ref,reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,account_id,decision,policy_version,status,created_at`,
      [randomUUID(), id(request), actor.id, b.decision, b.policy_version, b.evidence_ref, b.reason])).rows[0]!;
    await record(sql, { actor: actor.id, authority: 'compliance_officer', action: 'eligibility.proposed', resource: String(row.id),
      request: request.id, reason: b.reason, evidence: b.evidence_ref, after: row });
    return { status: 201, body: row };
  }));
  app.post('/v1/admin/eligibility-reviews/:id/decision', { schema: contract('decideEligibility','Compliance','Approve or reject an eligibility proposal',
    'Requires a compliance_officer distinct from both proposer and target account. The immutable audit records both actors. Eligibility does not activate trading or approve a jurisdiction.', Type.Ref(EligibilityReviewSchema),
    { params: IdParams, command: true, roles: ['compliance_officer'], body: object({ decision: Type.String({ enum: ['approved','rejected'] }), reason: Reason }) }) },
  run(['compliance_officer'], async ({ sql, actor, request }) => {
    const b = request.body as { decision: string; reason: string };
    const before = (await sql.query<{ id: string; account_id: string; proposer_id: string; decision: string; policy_version: string; evidence_ref: string; status: string }>('SELECT * FROM eligibility_reviews WHERE id=$1 FOR UPDATE', [id(request)])).rows[0];
    requireCondition(before, 404, 'NOT_FOUND', 'Eligibility proposal not found.');
    requireCondition(actor.id !== before.proposer_id && actor.id !== before.account_id, 403, 'SEPARATION_OF_DUTIES', 'A different compliance actor must decide this proposal.');
    requireCondition(before.status === 'pending', 409, 'VERSION_OR_STATE_CONFLICT', 'This proposal has already been decided.');
    if (b.decision === 'approved') await sql.query(`UPDATE eligibility SET status=$2,policy_version=$3,evidence_ref=$4,updated_at=now() WHERE account_id=$1`,
      [before.account_id, before.decision, before.policy_version, before.evidence_ref]);
    const row = (await sql.query(`UPDATE eligibility_reviews SET status=$2,approver_id=$3 WHERE id=$1
      RETURNING id,account_id,decision,policy_version,status,created_at`, [before.id, b.decision, actor.id])).rows[0]!;
    await record(sql, { actor: actor.id, authority: 'compliance_officer', action: 'eligibility.decided', resource: before.id,
      request: request.id, reason: b.reason, evidence: before.evidence_ref, before: { status: before.status, proposer_id: before.proposer_id }, after: row, result: b.decision });
    return { status: 200, body: row };
  }));

  const syntheticFinance=()=>requireCondition(cfg.financialMode==='synthetic',503,'FINANCIAL_INTEGRATION_PENDING',
    'Funding and withdrawal integrations are not active.');
  app.get('/v1/smart-account',{schema:contract('getSmartAccount','Portfolio','Read your embedded smart-account status',
    'Returns public address and workflow status for the caller only. Recovery remains owned by the configured identity provider; no session keys or recovery data are returned.',
    Type.Ref(SmartAccountSchema))},async req=>{
    const {a}=await authenticated(req);
    const row=(await db.query<{chain_id:string;address:string;status:string}>('SELECT chain_id::text,address,status FROM smart_accounts WHERE owner_id=$1',[a.id])).rows[0];
    requireCondition(row,404,'SMART_ACCOUNT_NOT_PROVISIONED','No smart account has been provisioned.');
    return {...row,recovery:'identity_provider',financial_mode:cfg.financialMode};
  });
  app.get('/v1/financial-assets',{schema:contract('listFinancialAssets','Funding','List configured collateral assets',
    'Shows configured asset units. funding_enabled and withdrawal_enabled are true only in the isolated synthetic demo; an approved real asset and partner are not configured.',
    object({items:Type.Array(Type.Ref(FinancialAssetSchema))}))},async req=>{
    await authenticated(req);
    const rows=(await db.query<{code:string;scale:number;synthetic:boolean}>('SELECT code,scale,synthetic FROM financial_assets WHERE approved=true ORDER BY code')).rows;
    return {items:rows.map(row=>({...row,funding_enabled:cfg.financialMode==='synthetic'&&row.synthetic,
      withdrawal_enabled:cfg.financialMode==='synthetic'&&row.synthetic}))};
  });
  app.post('/v1/webhooks/funding/:partnerId',{schema:contract('receiveFundingPartnerEvent','Funding','Receive a signed funding-partner event',
    'Verifies the partner signature over event ID, timestamp and canonical payload before changing state. Duplicate identical events produce one effect. This endpoint records partner confirmation only; it never credits available collateral. The adapter is unavailable until explicitly configured.',
    object({accepted:Type.Literal(true)}),{public:true,status:202,
      params:object({partnerId:Type.String({pattern:'^[a-z0-9][a-z0-9_-]{1,63}$'})}),
      headers:Type.Object({'x-partner-event-id':Type.String({minLength:1,maxLength:128,pattern:'^[A-Za-z0-9._:-]+$'}),
        'x-partner-timestamp':Type.String({pattern:'^[0-9]{10}$'}),
        'x-partner-signature':Type.String({pattern:'^sha256=[a-f0-9]{64}$'})},{additionalProperties:true}),
      body:object({event_type:Type.Literal('deposit.confirmed'),occurred_at:Timestamp,intent_id:UUID,
        partner_reference:Type.String({minLength:1,maxLength:200}),asset:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),amount_minor:Uint})})},
    async(request,reply)=>{
      requireCondition(partnerVerifier,503,'PARTNER_ADAPTER_UNAVAILABLE','The funding partner adapter is not configured.');
      const params=request.params as {partnerId:string},headers=request.headers as Record<string,string>,body=request.body as {
        event_type:'deposit.confirmed';occurred_at:string;intent_id:string;partner_reference:string;asset:string;amount_minor:string};
      const eventId=headers['x-partner-event-id']!,timestamp=headers['x-partner-timestamp']!,signature=headers['x-partner-signature']!;
      requireCondition(await partnerVerifier.verify({partnerId:params.partnerId,eventId,timestamp,signature,payload:body}),
        401,'INVALID_PARTNER_SIGNATURE','A valid partner signature is required.');
      await db.transaction(sql=>applyPartnerDeposit(sql,{partnerId:params.partnerId,eventId,occurredAt:body.occurred_at,
        intentId:body.intent_id,reference:body.partner_reference,asset:body.asset,amount:body.amount_minor},request.id));
      return reply.code(202).send({accepted:true});
    });
  app.get('/v1/balances',{schema:contract('listCollateralBalances','Portfolio','Read available and reserved collateral',
    'Off-chain ledger projection. Pending partner deposits do not create spendable collateral. spendable is false because trading is not active.',
    object({items:Type.Array(Type.Ref(BalanceSchema))}))},async req=>{
    const {a}=await authenticated(req); return {items:(await walletBalances(db,a.id)).map(balance=>({...balance,spendable:false}))};
  });
  app.post('/v1/deposit-intents',{schema:contract('createDepositIntent','Funding','Create a synthetic deposit intent',
    'Available only in the loopback synthetic demo. Returns no payment instructions or quote. Partner confirmation alone cannot credit available collateral. A future approved partner adapter and finalized chain observation are required.',
    Type.Ref(DepositSchema),{command:true,status:201,body:object({asset:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),
      target_minor:Uint,rail:text('Configured rail identifier, synthetic in this environment.',80)})})},
  run([],async({sql,actor,request})=>{
    syntheticFinance(); const body=request.body as {asset:string;target_minor:string;rail:string};
    return {status:201,body:await createDepositIntent(sql,{owner:actor.id,asset:body.asset,target:body.target_minor,rail:body.rail},request.id)};
  }));
  app.get('/v1/deposit-intents',{schema:contract('listDepositIntents','Funding','List your deposit workflows',
    'Pages use stable opaque ID ordering. Partner confirmed is pending, not a balance credit. Use the state to show progress, exception and retry guidance.',
    object({items:Type.Array(Type.Ref(DepositSchema)),next_cursor:Type.Union([Type.String(),Type.Null()])}),
    {querystring:object({limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:20})),cursor:Type.Optional(UUID)})})},async req=>{
    const {a}=await authenticated(req),q=req.query as {limit?:number;cursor?:string},limit=q.limit??20;
    const rows=(await db.query<Parameters<typeof publicDeposit>[0]>(`SELECT * FROM deposit_intents WHERE owner_id=$1 AND ($2::uuid IS NULL OR id<$2::uuid)
      ORDER BY id DESC LIMIT $3`,[a.id,q.cursor??null,limit+1])).rows;
    const page=rows.slice(0,limit);
    return {items:page.map(publicDeposit),next_cursor:rows.length>limit?page.at(-1)!.id:null};
  });
  app.get('/v1/deposit-intents/:id',{schema:contract('getDepositIntent','Funding','Read your deposit workflow',
    'The state is authoritative for this service workflow only; it does not prove external partner or chain finality.',
    Type.Ref(DepositSchema),{params:IdParams})},async req=>{
    const {a}=await authenticated(req),row=(await db.query<Parameters<typeof publicDeposit>[0]>('SELECT * FROM deposit_intents WHERE id=$1 AND owner_id=$2',[id(req),a.id])).rows[0];
    requireCondition(row,404,'NOT_FOUND','Deposit intent not found.'); return publicDeposit(row);
  });
  app.post('/v1/withdrawals',{schema:contract('requestWithdrawal','Funding','Reserve collateral for a synthetic withdrawal',
    'Only the synthetic demo can create this reservation. Requires approved eligibility and finalized available collateral. No external transfer is submitted. The reservation shares the same account/asset lock as CLOB, AMM and RFQ.',
    Type.Ref(WithdrawalSchema),{command:true,status:201,body:object({asset:Type.String({pattern:'^[A-Z0-9_]{2,32}$'}),
      amount_minor:Uint,destination_ref:EvidenceRef,rail:text('Configured withdrawal rail, synthetic in this environment.',80)})})},
  run([],async({sql,actor,request})=>{
    syntheticFinance(); const b=request.body as {asset:string;amount_minor:string;destination_ref:string;rail:string};
    return {status:201,body:await createWithdrawal(sql,{owner:actor.id,asset:b.asset,amount:b.amount_minor,
      destination:b.destination_ref,rail:b.rail},request.id)};
  }));
  app.get('/v1/withdrawals',{schema:contract('listWithdrawals','Funding','List your withdrawal workflows',
    'Pages use stable opaque ID ordering and return only your reservations and terminal states. Submitted or uncertain withdrawals remain held until independent finality or recovery is established.',
    object({items:Type.Array(Type.Ref(WithdrawalSchema)),next_cursor:Type.Union([Type.String(),Type.Null()])}),
    {querystring:object({limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:20})),cursor:Type.Optional(UUID)})})},async req=>{
    const {a}=await authenticated(req),q=req.query as {limit?:number;cursor?:string},limit=q.limit??20;
    const rows=(await db.query<Parameters<typeof publicWithdrawal>[0]>(`SELECT * FROM withdrawals WHERE owner_id=$1 AND ($2::uuid IS NULL OR id<$2::uuid)
      ORDER BY id DESC LIMIT $3`,[a.id,q.cursor??null,limit+1])).rows;
    const page=rows.slice(0,limit);
    return {items:page.map(publicWithdrawal),next_cursor:rows.length>limit?page.at(-1)!.id:null};
  });
  app.get('/v1/withdrawals/:id',{schema:contract('getWithdrawal','Funding','Read your withdrawal workflow',
    'Only the owner can read this workflow. An unknown or other-account ID returns not found.',Type.Ref(WithdrawalSchema),{params:IdParams})},async req=>{
    const {a}=await authenticated(req),row=(await db.query<Parameters<typeof publicWithdrawal>[0]>('SELECT * FROM withdrawals WHERE id=$1 AND owner_id=$2',[id(req),a.id])).rows[0];
    requireCondition(row,404,'NOT_FOUND','Withdrawal not found.'); return publicWithdrawal(row);
  });
  app.post('/v1/withdrawals/:id/cancel',{schema:contract('cancelWithdrawal','Funding','Cancel an unsubmitted synthetic withdrawal',
    'Only a reserved withdrawal with no external submission may be cancelled. Unknown submission status must remain reserved; never release collateral on a timeout alone.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,body:object({reason:Reason})})},
  run([],async({sql,actor,request})=>{
    syntheticFinance(); return {status:200,body:await cancelWithdrawal(sql,actor.id,id(request),request.id)};
  }));
  app.get('/v1/statements',{schema:contract('listStatementEntries','Portfolio','Read your financial journal entries',
    'Append-only entries for your own ledger accounts, ordered by journal creation time then entry ID. Exact signed direction and amount are returned; another user\'s entries are never exposed.',
    object({items:Type.Array(Type.Ref(StatementSchema))}),
    {querystring:object({limit:Type.Optional(Type.Integer({minimum:1,maximum:100,default:20}))})})},async req=>{
    const {a}=await authenticated(req),limit=(req.query as {limit?:number}).limit??20;
    const rows=(await db.query<{id:string;effect_id:string;kind:string;reference_id:string;asset:string;bucket:string;
      direction:string;amount_minor:string;created_at:Date}>(`SELECT e.id,j.effect_id,j.kind,j.reference_id,a.asset_code AS asset,a.bucket,
      CASE WHEN (a.normal_side='credit' AND e.credit>0) OR (a.normal_side='debit' AND e.debit>0)
        THEN 'increase' ELSE 'decrease' END AS direction,
      GREATEST(e.debit,e.credit)::text AS amount_minor,j.created_at FROM ledger_entries e
      JOIN ledger_accounts a ON a.id=e.account_id JOIN ledger_journals j ON j.id=e.journal_id
      WHERE a.owner_id=$1 ORDER BY j.created_at DESC,e.id DESC LIMIT $2`,[a.id,limit])).rows;
    return {items:rows.map(row=>({...row,created_at:new Date(row.created_at).toISOString()}))};
  });
  app.post('/v1/admin/reconciliation-runs',{schema:contract('runFinancialReconciliation','Finance','Compare recorded ledger, partner and chain observations',
    'Finance-only. Creates owned exceptions for mismatches. This compares stored records; independent partner statements and chain scanning are still required before real-money activation.',
    Type.Ref(ReconciliationSchema),{command:true,roles:['finance_operator'],status:201,
      body:object({asset:Type.String({pattern:'^[A-Z0-9_]{2,32}$'})})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    const asset=(request.body as {asset:string}).asset;
    return {status:201,body:await reconcile(sql,asset,actor.id,request.id)};
  }));
  app.post('/v1/admin/synthetic/deposits/:id/partner-confirm',{schema:contract('simulatePartnerDepositConfirmation','Synthetic','Simulate a matching partner deposit event',
    'Loopback demo only. Generates a synthetic verified-partner event for frontend workflow testing. This operation is unavailable in production and is not a payment integration.',
    Type.Ref(DepositSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({asset:Type.String(),amount_minor:Uint})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance(); const b=request.body as {asset:string;amount_minor:string},event=randomUUID();
    await applyPartnerDeposit(sql,{partnerId:'synthetic-demo',eventId:event,occurredAt:new Date().toISOString(),
      intentId:id(request),reference:`demo:${event}`,asset:b.asset,amount:b.amount_minor},request.id);
    const row=(await sql.query<Parameters<typeof publicDeposit>[0]>('SELECT * FROM deposit_intents WHERE id=$1',[id(request)])).rows[0]!;
    await record(sql,{actor:actor.id,authority:'synthetic_finance_operator',action:'deposit.synthetic_partner_event',resource:id(request),
      request:request.id,reason:'Frontend demonstration only',after:{state:row.state}});
    return {status:200,body:publicDeposit(row)};
  }));
  app.post('/v1/admin/synthetic/deposits/:id/finalize',{schema:contract('simulateFinalizedDeposit','Synthetic','Simulate a finalized matching chain deposit',
    'Loopback demo only. Adds a synthetic chain observation under the demo finality policy and posts the balanced ledger journal. Unavailable in production.',
    Type.Ref(DepositSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance();
    const row=(await sql.query<{owner_id:string;asset_code:string;partner_minor:string}>('SELECT * FROM deposit_intents WHERE id=$1',[id(request)])).rows[0];
    requireCondition(row,404,'NOT_FOUND','Deposit intent not found.');
    const wallet=(await sql.query<{chain_id:string;address:string}>('SELECT * FROM smart_accounts WHERE owner_id=$1',[row.owner_id])).rows[0]!;
    const digest=(suffix:string)=>`0x${createHash('sha256').update(`${id(request)}:${suffix}`).digest('hex')}`;
    return {status:200,body:await finalizeDeposit(sql,{intentId:id(request),chainId:Number(wallet.chain_id),blockNumber:'1',
      blockHash:digest('block'),transactionHash:digest('transaction'),logIndex:0,accountAddress:wallet.address,
      asset:row.asset_code,amount:row.partner_minor,finalityPolicyRef:'demo:finality-v1'},actor.id,request.id)};
  }));
  app.post('/v1/admin/synthetic/withdrawals/:id/submit',{schema:contract('simulateWithdrawalSubmission','Synthetic','Simulate withdrawal submission',
    'Loopback demo only. Marks a reserved withdrawal as submitted without moving funds. A real adapter would supply its stable provider reference.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance(); return {status:200,body:await submitWithdrawal(sql,id(request),`demo:${id(request)}`,actor.id,request.id)};
  }));
  app.post('/v1/admin/synthetic/withdrawals/:id/uncertain',{schema:contract('simulateUncertainWithdrawal','Synthetic','Simulate an unknown withdrawal result',
    'Loopback demo only. Keeps all collateral reserved while showing the frontend an external timeout or ambiguous response.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance(); return {status:200,body:await markWithdrawalUncertain(sql,id(request),actor.id,request.id)};
  }));
  app.post('/v1/admin/synthetic/withdrawals/:id/finalize',{schema:contract('simulateFinalizedWithdrawal','Synthetic','Simulate finalized withdrawal settlement',
    'Loopback demo only. Consumes the held reservation and reduces recorded escrow after a synthetic finality observation.',
    Type.Ref(WithdrawalSchema),{params:IdParams,command:true,roles:['finance_operator'],body:object({})})},
  run(['finance_operator'],async({sql,actor,request})=>{
    syntheticFinance();
    const row=(await sql.query<{owner_id:string}>('SELECT owner_id FROM withdrawals WHERE id=$1',[id(request)])).rows[0];
    requireCondition(row,404,'NOT_FOUND','Withdrawal not found.');
    const wallet=(await sql.query<{chain_id:string;address:string}>('SELECT * FROM smart_accounts WHERE owner_id=$1',[row.owner_id])).rows[0]!;
    const digest=(suffix:string)=>`0x${createHash('sha256').update(`${id(request)}:${suffix}`).digest('hex')}`;
    return {status:200,body:await finalizeWithdrawal(sql,{withdrawalId:id(request),chainId:Number(wallet.chain_id),
      blockNumber:'2',blockHash:digest('block'),transactionHash:digest('transaction'),logIndex:0,
      accountAddress:wallet.address,finalityPolicyRef:'demo:finality-v1'},actor.id,request.id)};
  }));

  app.get('/v1/market-templates', { schema: contract('listMarketTemplates','Markets','List approved market templates','Returns only approved registry entries. Production starts with no approved templates; the demo seeds explicitly synthetic templates. Template approval is an operational governance decision.', object({ items: Type.Array(object({ id: Type.String(), version: Type.Integer(), market_type: Type.String({ enum: ['binary','categorical','scalar'] }) })) }), { public: true }) }, async () => ({ items: (await db.query('SELECT id,version,market_type FROM market_templates WHERE approved=true ORDER BY id,version')).rows }));
  app.get('/v1/admin/evidence-sources', { schema: contract('listApprovedEvidenceSources','Governance','List approved evidence sources','Market creators and reviewers select primary and fallback sources from this registry. The URLs are references only and are not fetched by this API.', object({ items: Type.Array(object({ name: Type.String(), uri: Type.String() })) }),
    { roles: ['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor'] }) }, async req => {
    await authenticated(req,['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor']);
    return { items: (await db.query('SELECT name,uri FROM evidence_sources WHERE approved=true ORDER BY name,uri LIMIT 1000')).rows };
  });
  app.get('/v1/admin/policy-registry', { schema: contract('listApprovedPolicyReferences','Governance','List approved policy references','Market creators and reviewers select approved eligibility, payout, adjudication, bond and collateral references. Evidence and approval records are access-controlled outside this endpoint.', object({ items: Type.Array(object({ kind: Type.String(), policy_ref: Type.String() })) }),
    { roles: ['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor'] }) }, async req => {
    await authenticated(req,['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor']);
    return { items: (await db.query('SELECT kind,policy_ref FROM policy_registry WHERE approved=true ORDER BY kind,policy_ref LIMIT 1000')).rows };
  });
  app.get('/v1/admin/markets', { schema: contract('listMarketDrafts','Governance','List markets awaiting operations','Creators see their own markets. Reviewers and auditors see all markets. Optional state filters apply; UUID cursor ordering is stable but state changes may change later pages. Fetch a fresh first page after a review.', object({ items: Type.Array(Type.Ref(MarketSchema)), next_cursor: Type.Union([Type.String(),Type.Null()]) }),
    { roles: ['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor'],
      querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })), cursor: Type.Optional(UUID), state: Type.Optional(Type.String({ enum: ['draft','review','rejected','scheduled'] })) }) }) }, async req => {
    const { a } = await authenticated(req,['market_creator','market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor']);
    const q = req.query as { limit?: number; cursor?: string; state?: string }; const limit = q.limit ?? 20;
    const canReview = a.roles.some(r => ['market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer','auditor'].includes(r));
    const rows = (await db.query<MarketRow>(`SELECT * FROM markets WHERE ($1::uuid IS NULL OR id>$1::uuid)
      AND ($2::text IS NULL OR state=$2) AND ($3::boolean OR creator_id=$4::uuid) ORDER BY id LIMIT $5`,
      [q.cursor ?? null, q.state ?? null, canReview, a.id, limit + 1])).rows;
    const page = rows.slice(0, limit);
    return { items: page.map(publicMarket), next_cursor: rows.length > limit ? page.at(-1)!.id : null };
  });
  app.post('/v1/admin/markets', { schema: contract('createMarketDraft','Governance','Create a governed market draft','Requires market_creator. Validates structure, dates, bounded limits, approved sources, registered policies and template approval. The draft is private and cannot be published by its creator. source_proposal_id must refer to a submitted proposal with exactly matching terms.', Type.Ref(MarketSchema),
    { command: true, roles: ['market_creator'], status: 201, body: object({ terms: Type.Ref(Terms), source_proposal_id: Type.Optional(UUID) }) }) }, run(['market_creator'], async ({ sql, actor, request }) => {
      const b = request.body as { terms: MarketTerms; source_proposal_id?: string };
      return { status: 201, body: await createDraft(sql, actor, b.terms, request.id, b.source_proposal_id) };
    }));
  app.get('/v1/admin/markets/:id', { schema: contract('getMarketDraft','Governance','Inspect a market draft','Available to its creator or scoped product/legal/integrity/resolution reviewers and auditors. Public callers cannot discover draft metadata.', Type.Ref(MarketSchema), { params: IdParams }) }, async req => {
    const { a } = await authenticated(req); const m = await getMarket(db, id(req)); mayReadDraft(a, m); return publicMarket(m);
  });
  app.put('/v1/admin/markets/:id', { schema: contract('reviseMarketDraft','Governance','Revise draft or rejected market terms','Only the creator may revise an unpublished draft or rejected version. expected_version prevents lost updates. Revision increments the version and requires a fresh complete review.', Type.Ref(MarketSchema),
    { command: true, params: IdParams, roles: ['market_creator'], body: object({ expected_version: Type.Integer({ minimum: 1 }), terms: Type.Ref(Terms), reason: Reason }) }) }, run(['market_creator'], async ({ sql, actor, request }) => {
      const b = request.body as { expected_version: number; terms: MarketTerms; reason: string };
      return { status: 200, body: await editDraft(sql, actor, id(request), b.expected_version, b.terms, b.reason, request.id) };
    }));
  app.post('/v1/admin/markets/:id/submit', { schema: contract('submitMarketDraft','Governance','Submit a draft for review','Only the creator may submit the current draft version. This freezes editing until rejection; reviewers approve the same policy hash.', Type.Ref(MarketSchema),
    { command: true, params: IdParams, roles: ['market_creator'], body: VersionCommand }) }, run(['market_creator'], async ({ sql, actor, request }) => {
      const b = request.body as Static<typeof VersionCommand>; return { status: 200, body: await submitDraft(sql, actor, id(request), b.expected_version, b.reason, request.id) };
    }));
  app.post('/v1/admin/markets/:id/reviews', { schema: contract('reviewMarket','Governance','Record an independent policy review','Product requires market_approver; legal requires legal_reviewer; integrity requires integrity_reviewer; resolution requires resolution_reviewer. Creator and original proposer are excluded. One immutable decision per review type per policy version. Rejection returns the draft for revision.', Type.Ref(ReviewSchema),
    { command: true, params: IdParams, status: 201, roles: ['market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer'], body: ReviewCommand }) }, run(['market_approver','legal_reviewer','integrity_reviewer','resolution_reviewer'], async ({ sql, actor, request }) =>
      ({ status: 201, body: await reviewMarket(sql, actor, id(request), request.body as Static<typeof ReviewCommand>, request.id) })));
  app.post('/v1/admin/markets/:id/publish', { schema: contract('publishMarket','Governance','Publish reviewed market metadata','Requires market_approver, independent of creator and original proposer. All four reviews must approve this version and policy hash. Every country/category must allow publication. Publishes scheduled metadata only; no chain transaction or trading activation occurs. Published terms cannot be edited.', Type.Ref(MarketSchema),
    { command: true, params: IdParams, roles: ['market_approver'], body: VersionCommand }) }, run(['market_approver'], async ({ sql, actor, request }) => {
      const b = request.body as Static<typeof VersionCommand>; return { status: 200, body: await publish(sql, actor, id(request), b.expected_version, b.reason, request.id) };
    }));

  app.get('/v1/markets', { schema: contract('listMarkets','Markets','Browse published markets','Only published metadata is returned. Filter by country, category or structure. Opaque cursors bind filters and a publication-time snapshot; records sort by UUID ascending. Retain identical filters when following a cursor. limit may change. Newly published markets appear on a fresh first page.', object({ items: Type.Array(Type.Ref(MarketSchema)), next_cursor: Type.Union([Type.String(),Type.Null()]) }), { public: true, querystring: ListQuery }) }, async req => {
    const q = req.query as Static<typeof ListQuery>; const filters = { market_type: q.market_type ?? null, category: q.category ?? null, jurisdiction: q.jurisdiction ?? null };
    let after: string | null = null, snapshot = new Date().toISOString();
    if (q.cursor) {
      try {
        const c = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as { after: string; snapshot: string; filter: string };
        requireCondition(typeof c.after === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(c.after) &&
          typeof c.snapshot === 'string' && Number.isFinite(Date.parse(c.snapshot)) && c.filter === hash(filters), 400, 'INVALID_CURSOR', 'Cursor does not match this query.');
        after = c.after; snapshot = new Date(c.snapshot).toISOString();
      } catch { throw new AppError(400, 'INVALID_CURSOR', 'Use a cursor returned by this endpoint with the same filters.'); }
    }
    const limit = q.limit ?? 20;
    const rows = (await db.query<MarketRow>(`SELECT * FROM markets WHERE published_at IS NOT NULL AND published_at <= $1
      AND ($2::uuid IS NULL OR id > $2::uuid) AND ($3::text IS NULL OR terms->>'market_type'=$3)
      AND ($4::text IS NULL OR terms->>'category'=$4) AND ($5::text IS NULL OR (terms->'jurisdictions') ? $5)
      ORDER BY id LIMIT $6`, [snapshot, after, filters.market_type, filters.category, filters.jurisdiction, limit + 1])).rows;
    const items = rows.slice(0, limit); const last = items.at(-1);
    return { items: items.map(publicMarket), next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ after: last.id, snapshot, filter: hash(filters) })).toString('base64url') : null };
  });
  app.get('/v1/markets/:id', { schema: contract('getMarket','Markets','Read published market terms','Returns immutable published terms, policy hash and scheduling metadata. Drafts are indistinguishable from nonexistent markets. A listed market is not a claim of tradability.', Type.Ref(MarketSchema), { public: true, params: IdParams }) }, async req => {
    const m = await getMarket(db, id(req)); requireCondition(m.published_at, 404, 'NOT_FOUND', 'Market not found.'); return publicMarket(m);
  });
  app.get('/v1/markets/:id/evidence', { schema: contract('getMarketEvidencePolicy','Markets','Read published evidence requirements','Returns the published source hierarchy and resolution policy. Evidence collection and finalization are later capabilities; no evidence artifacts are fabricated.', object({ market_id: UUID, policy_hash: Type.String(), collection_status: Type.Literal('not_collected'), resolution: Terms.properties.resolution }), { public: true, params: IdParams }) }, async req => {
    const m = await getMarket(db, id(req)); requireCondition(m.published_at, 404, 'NOT_FOUND', 'Market not found.');
    return { market_id: m.id, policy_hash: m.policy_hash, collection_status: 'not_collected', resolution: m.terms.resolution };
  });

  app.post('/v1/market-proposals', { schema: contract('submitMarketProposal','Proposals','Submit an external market proposal','Requires the approved market_proposer role. Proposal submission never publishes a market or grants operator privileges. It enters the same internal draft and review process.', Type.Ref(ProposalSchema),
    { command: true, roles: ['market_proposer'], status: 201, body: object({ terms: Type.Ref(Terms) }) }) }, run(['market_proposer'], async ({ sql, actor, request }) => {
      const { terms } = request.body as { terms: MarketTerms }; validateTerms(terms); await approvedTemplate(sql, terms); await approvedReferences(sql, terms);
      const row = (await sql.query('INSERT INTO market_proposals(id,proposer_id,terms) VALUES ($1,$2,$3) RETURNING id,status,terms,created_at',
        [randomUUID(), actor.id, JSON.stringify(terms)])).rows[0]!;
      await record(sql, { actor: actor.id, authority: 'market_proposer', action: 'market.proposed', resource: String(row.id),
        request: request.id, reason: 'External market proposal', after: row }); return { status: 201, body: row };
    }));
  app.get('/v1/market-proposals/:id', { schema: contract('getMarketProposal','Proposals','Inspect a market proposal','Only the proposer, market creators, market approvers and auditors may inspect a proposal. Other callers receive not found.', Type.Ref(ProposalSchema), { params: IdParams }) }, async req => {
    const { a } = await authenticated(req); const row = (await db.query<{ proposer_id: string } & Record<string, unknown>>('SELECT * FROM market_proposals WHERE id=$1', [id(req)])).rows[0];
    requireCondition(row && (row.proposer_id === a.id || a.roles.some(r => ['market_creator','market_approver','auditor'].includes(r))), 404, 'NOT_FOUND', 'Proposal not found.'); return row;
  });
  app.post('/v1/admin/market-proposals/:id/reject', { schema: contract('rejectMarketProposal','Proposals','Reject an external proposal with an audited reason','Requires market_approver and a different person from the proposer. Rejection is terminal for this proposal; a new submission receives a new identifier. It cannot mutate an adopted or published market.', Type.Ref(ProposalSchema),
    { roles: ['market_approver'], params: IdParams, body: object({ reason: Reason, evidence_ref: EvidenceRef }), command: true }) },
  run(['market_approver'], async ({ sql, actor, request }) => {
    const b = request.body as { reason: string; evidence_ref: string };
    const before = (await sql.query<{ id: string; proposer_id: string; status: string; terms: MarketTerms; created_at: Date }>(
      'SELECT * FROM market_proposals WHERE id=$1 FOR UPDATE', [id(request)])).rows[0];
    requireCondition(before, 404, 'NOT_FOUND', 'Proposal not found.');
    requireCondition(before.proposer_id !== actor.id, 403, 'SEPARATION_OF_DUTIES', 'The proposer cannot reject their own submission.');
    requireCondition(before.status === 'submitted', 409, 'VERSION_OR_STATE_CONFLICT', 'Only a submitted proposal may be rejected.');
    const after = (await sql.query<{ id: string; status: string; terms: MarketTerms; created_at: Date }>(
      "UPDATE market_proposals SET status='rejected' WHERE id=$1 RETURNING id,status,terms,created_at", [before.id])).rows[0]!;
    await record(sql, { actor: actor.id, authority: 'market_approver', action: 'market_proposal.rejected',
      resource: before.id, request: request.id, reason: b.reason, evidence: b.evidence_ref,
      before: { status: before.status }, after: { status: after.status }, result: 'rejected' });
    return { status: 200, body: after };
  }));
  app.get('/v1/market-proposals', { schema: contract('listMarketProposals','Proposals','List governed market proposals','Proposers see only their own submissions; market creators, approvers and auditors see all. Pages sort by opaque UUID and may change when proposal status changes.', object({ items: Type.Array(Type.Ref(ProposalSchema)), next_cursor: Type.Union([Type.String(),Type.Null()]) }),
    { roles: ['market_proposer','market_creator','market_approver','auditor'],
      querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })), cursor: Type.Optional(UUID), status: Type.Optional(Type.String({ enum: ['submitted','accepted','rejected'] })) }) }) }, async req => {
    const { a } = await authenticated(req,['market_proposer','market_creator','market_approver','auditor']);
    const q = req.query as { limit?: number; cursor?: string; status?: string }; const limit = q.limit ?? 20;
    const canReview = a.roles.some(r => ['market_creator','market_approver','auditor'].includes(r));
    const rows = (await db.query<{ id: string }>(`SELECT id,status,terms,created_at FROM market_proposals
      WHERE ($1::uuid IS NULL OR id>$1::uuid) AND ($2::text IS NULL OR status=$2)
      AND ($3::boolean OR proposer_id=$4::uuid) ORDER BY id LIMIT $5`,
      [q.cursor ?? null, q.status ?? null, canReview, a.id, limit + 1])).rows;
    const page = rows.slice(0, limit);
    return { items: page, next_cursor: rows.length > limit ? page.at(-1)!.id : null };
  });
  app.get('/v1/admin/audit-events', { schema: contract('listAuditEvents','Audit','Inspect attributable governance events','Requires auditor. Returns a bounded newest-first audit page without raw identity evidence or financial secrets. Use the opaque cursor unchanged to continue.', object({ items: Type.Array(object({ id: UUID, actor_id: Type.String(), authority: Type.String(), action: Type.String(), resource_id: Type.String(), request_id: Type.String(), reason: Type.String(), evidence_ref: Type.Union([Type.String(),Type.Null()]), result: Type.String(), created_at: Timestamp })), next_cursor: Type.Union([Type.String(),Type.Null()]) }),
    { roles: ['auditor'], querystring: object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })), cursor: Type.Optional(Type.String({ maxLength: 1024 })) }) }) }, async req => {
    await authenticated(req, ['auditor']); const q = req.query as { limit?: number; cursor?: string }; const limit = q.limit ?? 20;
    let beforeTime: string | null = null, beforeId: string | null = null;
    if (q.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8')) as { time: string; id: string };
        requireCondition(Number.isFinite(Date.parse(parsed.time)) && /^[0-9a-f-]{36}$/.test(parsed.id), 400, 'INVALID_CURSOR', 'Use a cursor returned by this endpoint.');
        beforeTime = parsed.time; beforeId = parsed.id;
      } catch { throw new AppError(400, 'INVALID_CURSOR', 'Use a cursor returned by this endpoint.'); }
    }
    const rows = (await db.query<{ id: string; created_at: Date }>(`SELECT id,actor_id,authority,action,resource_id,request_id,reason,evidence_ref,result,created_at
      FROM audit_events WHERE ($1::timestamptz IS NULL OR (created_at,id) < ($1::timestamptz,$2::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $3`, [beforeTime, beforeId, limit + 1])).rows;
    const page = rows.slice(0, limit), last = page.at(-1);
    return { items: page, next_cursor: rows.length > limit && last ?
      Buffer.from(JSON.stringify({ time: new Date(last.created_at).toISOString(), id: last.id })).toString('base64url') : null };
  });
  await app.ready();
  return app;
}
