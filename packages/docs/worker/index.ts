// Worker entry for the docs site. Static assets (dist/public) are served by Workers static assets;
// only the paths in `assets.run_worker_first` (wrangler.jsonc) reach this code:
// - /api/try/*: the backend for the interactive "Try Radius" components, a testnet seller and a faucet proxy.
// - Agent-facing files (Markdown twins, llms.txt, skills, robots.txt, sitemaps): served unchanged from
//   static assets, with one log line each so Workers Logs show which agents fetch them.
import { Hono } from 'hono';
import { radiusPayments, type RadiusPaymentVariables } from 'radius-sdk/hono';
import { radiusTestnet } from 'radius-sdk';
import { TRY_ROUTES as ROUTES } from '../docs/components/try/routes';

type Env = {
  Bindings: { TRY_PAY_TO: `0x${string}`; ASSETS: Fetcher };
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

// Agents fetch these files without running the page's analytics script, so this log line is the only
// record of them. No IP address, query string or body is logged.
async function serveAgentFile(request: Request, env: Env['Bindings']): Promise<Response> {
  const res = await env.ASSETS.fetch(request);
  console.log(
    JSON.stringify({
      message: 'agent file',
      path: new URL(request.url).pathname,
      method: request.method,
      status: res.status,
      userAgent: request.headers.get('user-agent'),
      referer: request.headers.get('referer'),
      country: request.cf?.country,
      asOrganization: request.cf?.asOrganization,
    }),
  );
  return res;
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith('/api/try/')) return app.fetch(request, env, ctx);
    return serveAgentFile(request, env);
  },
} satisfies ExportedHandler<Env['Bindings']>;
