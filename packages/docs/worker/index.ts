// Worker entry for the docs site. Static assets (dist/public) are served by Workers static assets;
// only the paths in `assets.run_worker_first` (wrangler.jsonc) reach this code:
// - /api/try/*: the backend for the interactive "Try Radius" components, a testnet seller and a faucet proxy.
// - Pages and agent-facing files (Markdown twins, llms.txt, skills, robots.txt, sitemaps): served from
//   static assets, with Markdown for requests that prefer it, recording agent requests in Workers Logs
//   and Analytics Engine. Scripts, styles and images stay asset-first.
import { Hono } from 'hono';
import { radiusPayments, type RadiusPaymentVariables } from 'radius-sdk/hono';
import { radiusTestnet } from 'radius-sdk';
import { TRY_ROUTES as ROUTES } from '../docs/components/try/routes';

type Env = {
  Bindings: { TRY_PAY_TO: `0x${string}`; ASSETS: Fetcher; AGENT_FETCHES: AnalyticsEngineDataset };
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

// Files written for agents.
const AGENT_FILE = /\.md$|^\/(?:llms\.txt|llms-full\.txt|robots\.txt|sitemap\.xml|sitemap\.txt)$/;

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

// Serves pages and agent files from static assets, records the requests agents make, and serves
// a page's Markdown twin to requests that prefer Markdown.
//
// Browsers are counted by Cloudflare Web Analytics, which only sees clients that run its script, so
// this is the only record of agents: a Workers Logs line (kept 3 to 7 days, for debugging) and an
// Analytics Engine data point (for weekly KPIs). A request is recorded when it negotiated Markdown or
// carries no `Sec-Fetch-Mode` header: every current browser sends that header, on page loads and on
// the page's own fetches (PageActions prefetches each page's `.md` twin), and HTTP clients and agent
// fetch tools don't. No IP address, query string or body is recorded.
async function serveStatic(request: Request, env: Env['Bindings']): Promise<Response> {
  const url = new URL(request.url);
  const isPage = PAGE.test(url.pathname);
  let res: Response | undefined;
  let negotiated = false;
  if (isPage && prefersMarkdown(request.headers.get('accept'))) {
    const twin = await env.ASSETS.fetch(new Request(new URL(markdownTwin(url.pathname), url), request));
    if (twin.ok) {
      res = twin;
      negotiated = true;
    }
  }
  res ??= await env.ASSETS.fetch(request);
  if (isPage) res = varyOnAccept(res);

  const servedToAgent = negotiated || !request.headers.has('sec-fetch-mode');
  if ((isPage || AGENT_FILE.test(url.pathname)) && servedToAgent) record(request, res, env);
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
  };
  console.log(JSON.stringify({ message: 'agent fetch', ...entry }));
  // Column order is the query schema for the `docs_agent_fetches` dataset: keep it append-only.
  // blob1 path, blob2 method, blob3 user agent, blob4 referer, blob5 country, blob6 AS organization,
  // blob7 host (filter on docs.radiustech.xyz: previews write here too), blob8 content type served
  // (`text/markdown` on a page path means the agent negotiated Markdown); double1 HTTP status.
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
    ],
    doubles: [entry.status],
  });
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith('/api/try/')) return app.fetch(request, env, ctx);
    return serveStatic(request, env);
  },
} satisfies ExportedHandler<Env['Bindings']>;
