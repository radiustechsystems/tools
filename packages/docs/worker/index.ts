// Worker entry for the docs site. Static assets (dist/public) are served by Workers static assets;
// only the paths in `assets.run_worker_first` (wrangler.jsonc) reach this code:
// - /api/try/*: the backend for the interactive "Try Radius" components, a testnet seller and a faucet proxy.
// - Pages and agent-facing files (Markdown twins, llms.txt, skills, robots.txt, sitemaps): served from
//   static assets, with Markdown for requests that prefer it, recording agent requests in Workers Logs
//   and Analytics Engine. Scripts, styles and images stay asset-first. Agent requests first pass the
//   Radius Platform policy of RADIUS_PROJECT_ID, which allows, denies, rate-limits or charges them.
import { Hono } from 'hono';
import { createHandle, syncPolicy, type RadiusEnv } from '@radiustech/platform-sdk';
import { radiusPayments, type RadiusPaymentVariables } from 'radius-sdk/hono';
import { radiusTestnet } from 'radius-sdk';
import { TRY_ROUTES as ROUTES } from '../docs/components/try/routes';

// Counts the policy's free quotas and rate limits, and claims payments so one isn't used twice.
export { RadiusCounter } from '@radiustech/platform-sdk/limiters/do';

type Env = {
  Bindings: RadiusEnv & { TRY_PAY_TO: `0x${string}`; ASSETS: Fetcher; AGENT_FETCHES: AnalyticsEngineDataset };
  Variables: RadiusPaymentVariables;
};

const FAUCET_URL = radiusTestnet.faucetUrl as string;

const app = new Hono<Env>();

app.get('/api/try/info', (c) =>
  c.json({
    network: radiusTestnet.name,
    caip2: radiusTestnet.network,
    payTo: c.env.TRY_PAY_TO,
    routes: Object.entries(ROUTES).map(([route, spec]) => ({ route, ...spec })),
  }),
);

// The faucet API sends no CORS headers, so the browser calls it through this same-origin proxy.
// The components pass `faucetUrl: <origin>/api/try/faucet` to radius-sdk, so fund() works unchanged.
app.on(['GET', 'POST'], '/api/try/faucet/*', async (c) => {
  const upstream = new URL(FAUCET_URL + c.req.path.slice('/api/try/faucet'.length));
  upstream.search = new URL(c.req.url).search;
  const res = await fetch(upstream, {
    method: c.req.method,
    headers: { accept: 'application/json', ...(c.req.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
    body: c.req.method === 'POST' ? await c.req.text() : undefined,
  });
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  });
});

app.use(
  '/api/try/*',
  radiusPayments<Env>({
    network: 'testnet',
    payTo: (c) => c.env.TRY_PAY_TO,
    routes: ROUTES,
  }),
);

app.get('/api/try/hello', (c) => c.json({ message: 'Hello, world!' }));

app.notFound((c) => c.json({ error: 'not found' }, 404));

// Files written for agents and feed readers.
const AGENT_FILE = /\.md$|^\/(?:llms\.txt|llms-full\.txt|robots\.txt|sitemap\.xml|sitemap\.txt|release-notes\.xml)$/;

// A page URL: no file extension in the last segment (`/`, `/build/`, `/build/x402`).
const PAGE = /(?:^|\/)[^/.]*$/;

// Whether the request asks for Markdown over HTML, e.g. `Accept: text/markdown` or
// `Accept: text/markdown, text/html;q=0.9`. Agents that ask this way get the page's Markdown twin.
function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let markdown = 0;
  let html = 0;
  for (const part of accept.split(',')) {
    const [type = '', ...params] = part.trim().toLowerCase().split(';');
    const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
    const quality = q ? Number(q.slice(2)) || 0 : 1;
    if (type.trim() === 'text/markdown') markdown = Math.max(markdown, quality);
    if (type.trim() === 'text/html') html = Math.max(html, quality);
  }
  return markdown > 0 && markdown >= html;
}

// The Markdown twin of a page URL, as scripts/postbuild-static-markdown.ts writes it:
// `/` -> `/index.md`, `/build/` and `/build` -> `/build.md`.
function markdownTwin(pathname: string): string {
  return `${pathname.replace(/\/+$/, '') || '/index'}.md`;
}

function varyOnAccept(res: Response): Response {
  const varied = new Response(res.body, res);
  varied.headers.append('vary', 'Accept');
  return varied;
}

// Verified bots (Cloudflare's `cf.verifiedBotCategory`) that pass the policy untouched: search
// engines, so the docs stay indexed, and link unfurls, uptime checks and webhooks. AI crawlers,
// AI search, AI assistants and SEO tools are gated like any other agent.
const UNGATED_BOTS = new Set(['Search Engine Crawler', 'Page Preview', 'Monitoring & Analytics', 'Webhooks']);

// The id of the policy rule that decided each gated request, for `record()`. Keyed by the request
// object `serveSite` hands the gate, so nothing outlives the request.
const decidedBy = new WeakMap<Request, string>();

// Enforces the project's policy, synced from the platform into RADIUS_POLICY by the cron trigger.
const radius = createHandle<Env['Bindings']>({
  onDecision: (decision, request) => decidedBy.set(request, decision.rule ?? ''),
});

// Serves pages and agent files, records the requests agents make, and gates agents with the policy.
//
// Browsers are counted by Cloudflare Web Analytics, which only sees clients that run its script, so
// this is the only record of agents: a Workers Logs line (kept 3 to 7 days, for debugging) and an
// Analytics Engine data point (for weekly KPIs). A request is from an agent when it prefers Markdown
// for a page or carries no `Sec-Fetch-Mode` header: every current browser sends that header, on page
// loads and on the page's own fetches (PageActions prefetches each page's `.md` twin), and HTTP
// clients and agent fetch tools don't. No IP address, query string or body is recorded.
//
// Only agents meet the policy: people reading the docs in a browser are never counted or charged.
// The recorded status is the policy's answer when it refused the request (402, 404, 429).
async function serveSite(request: Request, env: Env['Bindings'], ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const isPage = PAGE.test(url.pathname);
  const fromAgent =
    !request.headers.has('sec-fetch-mode') || (isPage && prefersMarkdown(request.headers.get('accept')));
  const gated = fromAgent && !UNGATED_BOTS.has(String(request.cf?.verifiedBotCategory ?? ''));
  const res = gated
    ? await radius(request, env, (forwarded) => serveStatic(forwarded, env), ctx)
    : await serveStatic(request, env);
  if ((isPage || AGENT_FILE.test(url.pathname)) && fromAgent) record(request, res, env);
  return res;
}

// Serves pages and agent files from static assets, and a page's Markdown twin to requests that
// prefer Markdown.
async function serveStatic(request: Request, env: Env['Bindings']): Promise<Response> {
  const url = new URL(request.url);
  const isPage = PAGE.test(url.pathname);
  let res: Response | undefined;
  if (isPage && prefersMarkdown(request.headers.get('accept'))) {
    const twin = await env.ASSETS.fetch(new Request(new URL(markdownTwin(url.pathname), url), request));
    if (twin.ok) res = twin;
  }
  res ??= await env.ASSETS.fetch(request);
  if (isPage) res = varyOnAccept(res);
  return res;
}

function record(request: Request, res: Response, env: Env['Bindings']) {
  const url = new URL(request.url);
  const entry = {
    path: url.pathname,
    method: request.method,
    status: res.status,
    userAgent: request.headers.get('user-agent') ?? '',
    referer: request.headers.get('referer') ?? '',
    country: String(request.cf?.country ?? ''),
    asOrganization: String(request.cf?.asOrganization ?? ''),
    host: url.hostname,
    contentType: (res.headers.get('content-type') ?? '').split(';')[0]!.trim(),
    ...identitySignals(request),
    rule: decidedBy.get(request) ?? '',
  };
  console.log(JSON.stringify({ message: 'agent fetch', ...entry }));
  // Column order is the query schema for the `docs_agent_fetches` dataset: keep it append-only.
  // blob1 path, blob2 method, blob3 user agent, blob4 referer, blob5 country, blob6 AS organization,
  // blob7 host (filter on docs.radiustech.xyz: previews write here too), blob8 content type served
  // (`text/markdown` on a page path means the agent negotiated Markdown), blob9 Cloudflare's verified
  // bot category, blob10 Cloudflare's signed-agent flag (`true`, `false`, or empty when the zone has no
  // Bot Management), blob11 the `Signature-Agent` header (Web Bot Auth; empty when absent), blob12 the
  // id of the policy rule that decided the request (empty when it wasn't gated or no rule matched);
  // double1 HTTP status.
  // The path is the index (sampling key).
  env.AGENT_FETCHES.writeDataPoint({
    indexes: [entry.path.slice(0, 96)],
    blobs: [
      entry.path,
      entry.method,
      entry.userAgent.slice(0, 512),
      entry.referer.slice(0, 512),
      entry.country,
      entry.asOrganization,
      entry.host,
      entry.contentType,
      entry.verifiedBotCategory,
      entry.signedAgent,
      entry.signatureAgent,
      entry.rule,
    ],
    doubles: [entry.status],
  });
}

// Who the agent says it is, and what Cloudflare vouches for. `botManagement` is only set with
// Cloudflare Bot Management, so its fields may be missing on this zone: that's what this records.
function identitySignals(request: Request) {
  const cf = request.cf as { verifiedBotCategory?: unknown; botManagement?: { signedAgent?: unknown } } | undefined;
  const signed = cf?.botManagement?.signedAgent;
  return {
    verifiedBotCategory: String(cf?.verifiedBotCategory ?? ''),
    signedAgent: typeof signed === 'boolean' ? String(signed) : '',
    signatureAgent: (request.headers.get('signature-agent') ?? '').slice(0, 256),
  };
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith('/api/try/')) return app.fetch(request, env, ctx);
    return serveSite(request, env, ctx);
  },
  // The cron in wrangler.jsonc: copies the project's policy into RADIUS_POLICY when it changed. Without the
  // RADIUS_API_KEY secret there is nothing to sync, and agent requests stay ungated.
  scheduled(_controller, env, ctx) {
    if (!env.RADIUS_API_KEY) return;
    ctx.waitUntil(syncPolicy(env).catch((error: unknown) => console.error('radius: policy sync failed:', error)));
  },
} satisfies ExportedHandler<Env['Bindings']>;
