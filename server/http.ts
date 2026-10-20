import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname, sep } from 'node:path';
import { z } from 'zod';
import type { AppSettings } from '../shared/types.ts';
import { FlipperService } from './service.ts';
import { serverOptions, validAdminToken, validateServerAccess, type ServerOptions } from './access.ts';
import { SourceCooldownError } from './source-cooldown.ts';

const categorySchema = z.enum(['laptop','desktop','gpu']);
const memoryMinimumSchema = z.number().int().min(0).max(4096);
const memorySettingsSchema = {
  minRamGb: memoryMinimumSchema.optional(), minVramGb: memoryMinimumSchema.optional(), includeUnknownMemory: z.boolean().optional(),
};
const settingsSchema = z.object({
  ...memorySettingsSchema,
  discountPercent: z.number().finite().min(0).max(90).optional(),
  minComparables: z.number().int().min(5).max(50).optional(),
  minProfit: z.number().finite().min(0).max(1e9).optional(), minRoiPercent: z.number().finite().min(0).max(500).optional(),
  resaleFactor: z.number().finite().min(.1).max(1.5).optional(),
  costReserves: z.object({ laptop: z.number().finite().min(0).max(1e8).optional(), desktop: z.number().finite().min(0).max(1e8).optional(), gpu: z.number().finite().min(0).max(1e8).optional() }).strict().optional(),
  aiBudgetUsd: z.number().finite().min(0).max(10).optional(), scanLimit: z.number().int().min(20).max(1000).optional(),
  benchmarkLimit: z.number().int().min(20).max(200).optional(), aiEnabled: z.boolean().optional(),
  liteLlmKey: z.string().max(500).optional(),
}).strict();
const stateSchema = z.object({ saved: z.boolean().optional(), dismissed: z.boolean().optional(),
  costReserve: z.number().finite().min(0).max(1e9).nullable().optional(), expectedResale: z.number().finite().positive().max(1e10).nullable().optional() }).strict();
class HTTPError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const recoverySchema = z.object({
  budgetUsd: z.number().finite().min(0).max(10),
  cooldown: z.object({ until: z.string().datetime(), observedAt: z.string().datetime(), status: z.number().int().min(400).max(599) }).strict()
    .refine(value => Date.parse(value.until) > Date.parse(value.observedAt), 'Cooldown must end after its observation'),
  job: z.object({
    id: z.string().min(1).max(100), category: categorySchema, query: z.string().max(200), status: z.literal('failed'),
    message: z.string().max(2000), scanned: z.number().int().min(0).max(1000), target: z.number().int().min(1).max(1000),
    assessed: z.number().int().min(0).max(1000), benchmarked: z.number().int().min(0).max(1000),
    totalAvailable: z.number().int().nonnegative().nullable(), requestCount: z.number().int().nonnegative(),
    aiCostUsd: z.number().finite().nonnegative(), error: z.string().max(2000).nullable(),
    startedAt: z.string().datetime(), completedAt: z.string().datetime(), retryOf: z.string().max(100).optional(),
  }).strict(),
}).strict();

async function body(req: IncomingMessage): Promise<unknown> {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.startsWith('application/json')) throw new HTTPError(415, 'Use application/json for this request');
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > 32_000) throw new HTTPError(413, 'Request is too large'); chunks.push(bytes); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HTTPError(400, 'Invalid JSON request'); }
}
function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPError(400, parsed.error.issues.map((issue) => `${issue.path.join('.') || 'Request'}: ${issue.message}`).join('; '));
  return parsed.data;
}
function ensureWriteOrigin(req: IncomingMessage, publicOrigin: string | null): void {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HTTPError(403, 'Cross-site requests are not accepted');
  const origin = req.headers.origin;
  if (!origin) return;
  if (publicOrigin !== null) {
    if (origin !== publicOrigin) throw new HTTPError(403, 'Only the configured app origin is accepted');
    return;
  }
  let parsed: URL; try { parsed = new URL(origin); } catch { throw new HTTPError(403, 'Invalid request origin'); }
  // Vite development and the local standalone app are both loopback.
  if (!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)) throw new HTTPError(403, 'Only local app requests are accepted');
}

export function appServer(service: FlipperService, dist = resolve('dist'), options: ServerOptions = serverOptions()) {
  const access = validateServerAccess(options);
  return createServer(async (req, res) => {
    let publicReadOnly = access.hosted;
    try {
      const target = req.url ?? '/', rawPath = target.split(/[?#]/, 1)[0]!;
      if (!target.startsWith('/') || target.startsWith('//') || /\\|%(?:2f|5c|00)/i.test(rawPath)) throw new HTTPError(400, 'Invalid request path');
      let decodedPath: string;
      try { decodedPath = decodeURIComponent(rawPath); } catch { throw new HTTPError(400, 'Invalid request path'); }
      if (decodedPath.split('/').some((part) => part === '.' || part === '..') || /[\x00-\x1f\x7f]/.test(decodedPath)) throw new HTTPError(400, 'Invalid request path');
      const url = new URL(target, 'http://127.0.0.1'); let path = url.pathname;
      const adminPath = /^\/admin(?:\/|$)/.test(decodedPath);
      if (access.hosted && adminPath) {
        if (!validAdminToken(req.headers['x-flipper-admin-token'], access.adminToken!)) throw new HTTPError(403, 'Administrator access is required');
        // Only the canonical prefix is routed, so edge and application agree on the protected area.
        if (!/^\/admin(?:\/|$)/.test(path)) throw new HTTPError(400, 'Invalid administration path');
        publicReadOnly = false;
        path = path.slice('/admin'.length) || '/';
      }
      const readRequest = req.method === 'GET' || req.method === 'HEAD';
      const ensureNotInMaintenance = () => {
        const cancellingJob = req.method === 'POST' && /^\/api\/jobs\/[^/]+\/cancel$/.test(path);
        if (!cancellingJob && service.store.deploymentMaintenanceActive()) throw new HTTPError(503, 'Deployment is in progress; try again shortly');
      };
      const mutationBody = async () => {
        const data = await body(req);
        // A body can arrive after deployment started; freeze that mutation too.
        ensureNotInMaintenance(); return data;
      };
      if (!readRequest) {
        if (publicReadOnly) throw new HTTPError(403, 'This public app is read-only; administrator access is required');
        ensureWriteOrigin(req, access.publicOrigin);
        ensureNotInMaintenance();
      }
      if (path === '/healthz' && readRequest) return json(res, { status: 'ok', revision: access.revision });
      if (publicReadOnly && (path === '/api' || path.startsWith('/api/'))) {
        const allowed = ['/api/bootstrap', '/api/listings'].includes(path) || /^\/api\/listings\/[^/]+$/.test(path);
        if (!allowed) throw new HTTPError(404, 'API route not found');
        if (path === '/api/listings' && url.searchParams.get('view') === 'saved') throw new HTTPError(403, 'Saved listings require administrator access');
      }
      if (path === '/api/bootstrap' && readRequest) return json(res, publicReadOnly ? service.publicBootstrap() : service.bootstrap());
      if (path === '/api/schedule' && readRequest) return json(res, service.scheduleStatus());
      if (path === '/api/schedule' && req.method === 'POST') {
        const { enabled } = parse(z.object({ enabled: z.boolean() }).strict(), await mutationBody());
        return json(res, service.configureDailyScans(enabled));
      }
      if (path === '/api/scan-retries' && req.method === 'POST') {
        const data = parse(recoverySchema, await mutationBody());
        if (data.budgetUsd > service.store.getSettings().aiBudgetUsd) throw new HTTPError(400, 'Recovery cannot increase the configured manual budget');
        return json(res, { retry: service.recoverScanRetry(data.job, data.budgetUsd, data.cooldown) }, 201);
      }
      const retryCancel = path.match(/^\/api\/scan-retries\/([^/]+)\/cancel$/);
      if (retryCancel && req.method === 'POST') return json(res, { retry: service.cancelScanRetry(retryCancel[1]!) });
      if (path === '/api/listings' && readRequest) {
        const category = parse(categorySchema, url.searchParams.get('category') ?? 'laptop');
        for (const name of ['minRamGb', 'minVramGb']) if (url.searchParams.has(name)) {
          parse(z.string().trim().min(1).transform(Number).pipe(memoryMinimumSchema), url.searchParams.get(name));
        }
        if (url.searchParams.has('includeUnknownMemory')) parse(z.enum(['true', 'false']), url.searchParams.get('includeUnknownMemory'));
        return json(res, publicReadOnly ? service.publicListings(category, url.searchParams) : service.listings(category, url.searchParams));
      }
      if (path === '/api/refresh' && req.method === 'POST') {
        const data = parse(z.object({ category: categorySchema, query: z.string().max(200).optional(), limit: z.number().int().min(1).max(1000).optional(), ...memorySettingsSchema }).strict(), await mutationBody());
        return json(res, { job: service.refresh(data.category, data.query ?? '', data.limit, data.minRamGb, data.minVramGb, data.includeUnknownMemory) }, 202);
      }
      if (path === '/api/jobs/active' && readRequest) return json(res, { job: service.activeJob() });
      if (path === '/api/deployment' && readRequest) return json(res, service.deploymentStatus());
      const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(\/cancel)?$/);
      if (jobMatch) {
        const job = jobMatch[2] && req.method === 'POST' ? service.cancelJob(jobMatch[1]!) : readRequest ? service.getJob(jobMatch[1]!) : null;
        if (!job) throw new HTTPError(404, 'Job not found'); return json(res, { job });
      }
      const listingMatch = path.match(/^\/api\/listings\/([^/]+)(?:\/(state|analyze))?$/);
      if (listingMatch) {
        const id = decodeURIComponent(listingMatch[1]!);
        if (!listingMatch[2] && readRequest) { const item = publicReadOnly ? service.publicDetail(id) : service.detail(id); if (!item) throw new HTTPError(404, 'Listing not found'); return json(res, item); }
        if (listingMatch[2] === 'state' && req.method === 'POST') { const item = service.state(id, parse(stateSchema, await mutationBody())); if (!item) throw new HTTPError(404, 'Listing not found'); return json(res, item); }
        if (listingMatch[2] === 'analyze' && req.method === 'POST') { if (!service.detail(id)) throw new HTTPError(404, 'Listing not found'); return json(res, { job: service.analyze(id) }, 202); }
      }
      if (path === '/api/searches' && req.method === 'POST') {
        const data = parse(z.object({ name: z.string().trim().min(1).max(100), category: categorySchema, query: z.string().max(200), district: z.string().max(100).default(''), mode: z.enum(['buy','resale']).default('buy'), maxPrice: z.number().finite().positive().nullable().default(null), ...memorySettingsSchema, opportunities: z.boolean().default(false) }).strict(), await mutationBody());
        const settings = service.store.getSettings();
        return json(res, { search: service.store.saveSearch({ ...data,
          minRamGb: data.minRamGb ?? settings.minRamGb, minVramGb: data.minVramGb ?? settings.minVramGb,
          includeUnknownMemory: data.includeUnknownMemory ?? settings.includeUnknownMemory }) }, 201);
      }
      const searchMatch = path.match(/^\/api\/searches\/([^/]+)$/);
      if (searchMatch && req.method === 'DELETE') { service.store.deleteSearch(searchMatch[1]!); return json(res, { ok: true }); }
      if (path === '/api/settings' && req.method === 'POST') {
        if (service.activeJob()) throw new HTTPError(409, 'Wait for or cancel the active refresh before changing settings');
        const { liteLlmKey, ...updates } = parse(settingsSchema, await mutationBody());
        const current = service.store.getSettings();
        const settings: AppSettings = { ...current, ...updates, costReserves: { ...current.costReserves, ...updates.costReserves } };
        service.store.saveSettings(settings);
        if (liteLlmKey !== undefined) service.store.saveKey(liteLlmKey);
        service.clearAIStatus(); return json(res, service.bootstrap());
      }
      if (path === '/api/ai/test' && req.method === 'POST') return json(res, { results: await service.testAI() });
      if (path === '/api' || path.startsWith('/api/')) throw new HTTPError(404, 'API route not found');
      if (!['GET','HEAD'].includes(req.method ?? '')) throw new HTTPError(405, 'Method not allowed');
      const decoded = decodeURIComponent(path); const candidate = resolve(dist, '.' + decoded);
      if (candidate !== dist && !candidate.startsWith(dist + sep)) throw new HTTPError(403, 'Invalid path');
      const file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : extname(decoded) ? '' : resolve(dist, 'index.html');
      if (!file || !existsSync(file)) throw new HTTPError(404, 'Build the app with npm run build first');
      const contentTypes: Record<string,string> = { '.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon' };
      res.writeHead(200, { 'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream', 'X-Content-Type-Options':'nosniff',
        'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Request failed';
      const cooldown = !publicReadOnly && error instanceof SourceCooldownError ? error.cooldown : null;
      if (cooldown) res.setHeader('Retry-After', String(Math.max(0, Math.ceil((Date.parse(cooldown.until) - Date.now()) / 1000))));
      const status = error instanceof HTTPError ? error.status : cooldown ? 429 : !publicReadOnly && message === 'Deployment is in progress; try again shortly' ? 503
        : !publicReadOnly && /already running|already queued|active refresh|Wait for/.test(message) ? 409 : 500;
      json(res, { error: publicReadOnly && !(error instanceof HTTPError) ? 'The request could not be completed' : message,
        ...(cooldown ? { retryAt: cooldown.until } : {}) }, status);
    }
  });
}
