import type { Command } from 'commander';
import { resolveConfig, resolvePayNetworks, PAY_NETWORKS } from '../lib/config.js';
import { jsonStringify } from '../lib/format.js';
import { isSupportedVerb, looksLikeJson, parseHeaderArgs, readBodyArg, SUPPORTED_VERBS } from '../lib/http.js';
import { parseUnits } from 'viem';
import { resolvePrice } from 'radius-sdk';
import { readFileSync } from 'node:fs';
import type { Check, CheckStatus, SellCheckOptions, SellCheckReport } from '../lib/sellCheck.js';
import type { RouteResult, RoutesReport } from '../lib/sellCheckRoutes.js';
import type { PricingRoute } from '../lib/pricingMd.js';
import type { GlobalOptions } from '../types.js';

interface CheckOptions {
  method?: string;
  header?: string[];
  data?: string;
  price?: string;
  facilitator?: string[];
  probeHead?: boolean;
  pay?: boolean;
  threshold?: string;
  networks?: string;
  timeout?: string;
  freeRequests?: string;
  pricing?: string;
  baseUrl?: string;
  param?: string[];
}

/** Matches DEFAULT_FREE_REQUESTS in lib/sellCheck (kept here so --help needs no lazy import). */
const DEFAULT_FREE_REQUESTS = 25;
const MAX_FREE_REQUESTS = 1000;

export function registerSell(program: Command): void {
  const sell = program.command('sell').description('Tools for sellers: check what a paid endpoint asks buyers for');

  sell
    .command('check')
    .description(
      [
        'Request a paid endpoint without paying and check its 402: the x402 PAYMENT-REQUIRED offers (network, asset and',
        "decimals, amount, payTo, resource, maxTimeoutSeconds), the facilitator's /supported for each offer, any MPP",
        'challenge, and whether a radius-sdk buyer would pay it. Exit 0 when no check fails, 1 otherwise, 2 on bad flags.',
        '',
        'Free quotas: when the unpaid request is served (2xx) with RateLimit-Remaining, the route has a free quota. sell',
        'check reports it (limit, remaining, reset) and sends RateLimit-Remaining + 1 more unpaid requests to use it up and',
        `reach the 402, if that fits --free-requests (default ${DEFAULT_FREE_REQUESTS}); then it checks the 402 as usual. If it does not fit, or`,
        'with --free-requests 0, it reports the quota (warn / info) and does not check the 402. Those requests count against',
        "your own quota. A 2xx without RateLimit headers is a failure: the route is served without payment.",
        '',
        'Every route of a project: --pricing <file|url> reads a Radius Platform pricing.md and checks each listed route',
        "(each method; ANY as GET) against its own Price, in file order. Base URL comes from the catalog or --base-url",
        "(required while the file says [Base URL]); fill path parameters with --param name=value (':address' takes",
        "--param address=0x…, '*' takes --param '*=a/b'). Routes with unfilled parameters are skipped and listed. Exit 1",
        'when a route fails or none could be checked.',
        '',
        '  radius-cli sell check http://127.0.0.1:3000/api/report',
        "  radius-cli sell check http://127.0.0.1:3000/api/report --price '$0.001' --probe-head",
        '  radius-cli sell check https://api.example.com/query -X POST -d \'{"q":1}\' --facilitator https://facilitator.example',
        "  radius-cli sell check --pricing pricing.md --base-url http://localhost:8788 --param address=0x… --param hash=0x…",
        '  RADIUS_HOME=.radius radius-cli sell check https://api.example.com/r --pay --threshold 0.01   # one testnet payment',
        '  RADIUS_HOME=.radius radius-cli --password-file .radius/pw sell check https://api.example.com/r --pay --threshold 0.01',
      ].join('\n'),
    )
    .argument('[url]', 'URL of a paid route (or use --pricing)')
    .option('-X, --method <verb>', `HTTP method (${SUPPORTED_VERBS.join(', ')}; default get)`)
    .option('-H, --header <h...>', "request header, repeatable: 'Key: Value'")
    .option('-d, --data <body>', "request body (literal, '@path' for file, '-' for stdin)")
    .option('--price <usd>', "expected price per request, e.g. '$0.001': checks each offer's atomic amount with its asset's decimals")
    .option('--facilitator <url...>', "facilitator(s) the seller settles through, for /supported (default: each network's default facilitator)")
    .option('--probe-head', 'also send an unpaid HEAD and warn if it is served (HEAD can run a paid GET handler)')
    .option('--free-requests <n>', `most extra unpaid requests to spend using up a free quota before the 402 (default ${DEFAULT_FREE_REQUESTS}; 0 only reports the quota)`)
    .option('--pricing <file|url>', 'check every route listed in this pricing.md (a file, or an http(s) URL) instead of one <url>')
    .option('--base-url <url>', "with --pricing: base URL for every catalog's routes (overrides the file's Base URL)")
    .option('--param <name=value...>', "with --pricing: value for a path parameter, repeatable: --param address=0x…")
    .option('--pay', 'then make one paid request from the local wallet and check the receipt (testnet unless --network mainnet); the keystore password comes from --password-file or RADIUS_PASSWORD when stdin is not a terminal')
    .option('--threshold <decimal>', "with --pay: most to pay, in the asset's display units (required)")
    .option('--networks <list>', `with --pay: networks to pay on (${PAY_NETWORKS.join(', ')}; default radius)`)
    .option('--timeout <ms>', 'timeout for each request, in milliseconds', '15000')
    .action(async (url: string | undefined, sub: CheckOptions, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      process.exit(await runCheck(url, sub, opts));
    });
}

function usage(message: string): number {
  process.stderr.write(`sell check: ${message}\n`);
  return 2;
}

async function runCheck(url: string | undefined, sub: CheckOptions, opts: GlobalOptions): Promise<number> {
  if (sub.pricing !== undefined) {
    if (url !== undefined) return usage('pass either a <url> or --pricing, not both');
    if (sub.price !== undefined) return usage('--price does not apply with --pricing: each route is checked against its own Price');
    if (sub.method !== undefined) return usage('-X does not apply with --pricing: each route is checked with its listed methods');
    if (sub.pay) return usage('--pay does not apply with --pricing (it would pay once per route); check one route with <url> --pay');
  } else {
    if (url === undefined) return usage('missing <url> (or --pricing <file|url>)');
    if (sub.baseUrl !== undefined) return usage('--base-url only applies with --pricing');
    if (sub.param !== undefined) return usage('--param only applies with --pricing');
    try {
      new URL(url);
    } catch {
      return usage(`not a URL: ${url}`);
    }
  }
  if (sub.baseUrl !== undefined && !/^https?:\/\/[^/]/i.test(sub.baseUrl)) return usage(`--base-url must be an http(s) URL (got '${sub.baseUrl}')`);
  const params: Record<string, string> = {};
  for (const p of sub.param ?? []) {
    const eq = p.indexOf('=');
    if (eq <= 0) return usage(`--param expects name=value (got '${p}')`);
    params[p.slice(0, eq).replace(/^:/, '')] = p.slice(eq + 1);
  }
  let freeRequests: number | undefined;
  if (sub.freeRequests !== undefined) {
    freeRequests = Number(sub.freeRequests);
    if (!/^\d+$/.test(sub.freeRequests) || freeRequests > MAX_FREE_REQUESTS) return usage(`--free-requests must be an integer from 0 to ${MAX_FREE_REQUESTS} (got '${sub.freeRequests}')`);
  }
  const verb = (sub.method ?? 'get').toLowerCase();
  if (!isSupportedVerb(verb)) return usage(`unsupported method '${sub.method}' (use one of ${SUPPORTED_VERBS.join(', ')})`);
  if (sub.threshold !== undefined && !sub.pay) return usage('--threshold only applies with --pay');
  if (sub.pay && sub.threshold === undefined) return usage('--pay needs --threshold <decimal>, the most to pay');
  if (sub.threshold !== undefined) {
    try {
      if (!/^\d+(\.\d+)?$/.test(sub.threshold)) throw new Error('not a decimal');
      parseUnits(sub.threshold, 18);
    } catch {
      return usage(`--threshold must be a decimal number such as 0.01 (got '${sub.threshold}')`);
    }
  }
  if (sub.price !== undefined) {
    try {
      resolvePrice(sub.price, { address: '0x0000000000000000000000000000000000000000', decimals: 18 });
    } catch {
      return usage(`--price must be a USD amount such as '$0.001' (got '${sub.price}')`);
    }
  }
  const timeoutMs = Number(sub.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return usage(`--timeout must be a positive integer (got ${sub.timeout})`);

  // Bad flag values are usage errors (exit 2), not runtime failures.
  let headers: Headers;
  let body: Uint8Array | undefined;
  try {
    headers = parseHeaderArgs(sub.header);
    body = readBodyArg(sub.data);
  } catch (e) {
    return usage((e as Error).message);
  }
  if (body && !headers.has('content-type') && looksLikeJson(body)) headers.set('content-type', 'application/json');

  // Network flags only matter for --pay, and for the SBC address on Radius. Paying defaults to
  // testnet whatever RADIUS_NETWORK or the config file say: mainnet needs an explicit --network mainnet.
  let cfg: ReturnType<typeof resolveConfig>;
  let payNetworks: ReturnType<typeof resolvePayNetworks> | undefined;
  try {
    cfg = resolveConfig({ ...opts, network: opts.network ?? (sub.pay ? 'testnet' : undefined) });
    if (sub.pay) payNetworks = resolvePayNetworks(cfg, sub.networks);
  } catch (e) {
    return usage((e as Error).message);
  }
  let pay: SellCheckOptions['pay'];
  if (payNetworks) {
    const { assertCanUnlock, deferredAccount } = await import('../lib/account.js');
    // Fail before any request when paying would need a password prompt nobody can answer.
    try {
      assertCanUnlock(cfg, opts.privateKey);
    } catch (e) {
      return usage((e as Error).message);
    }
    pay = { networks: payNetworks, signer: await deferredAccount(cfg, opts.privateKey), threshold: sub.threshold! };
  }

  const shared = {
    headers,
    body,
    facilitators: sub.facilitator,
    facilitatorApiKey: process.env.RADIUS_FACILITATOR_API_KEY,
    radiusAssetAddress: cfg.sbcAddress,
    probeHead: sub.probeHead,
    freeRequests,
    timeoutMs,
  };

  if (sub.pricing !== undefined) {
    const { parsePricingMd } = await import('../lib/pricingMd.js');
    let routes: PricingRoute[];
    try {
      routes = parsePricingMd(await readPricing(sub.pricing, timeoutMs));
    } catch (e) {
      return usage(`--pricing ${sub.pricing}: ${(e as Error).message}`);
    }
    const { checkRoutes } = await import('../lib/sellCheckRoutes.js');
    const result = await checkRoutes(sub.pricing, routes, params, sub.baseUrl, shared, opts.json ? undefined : printRoute);
    if (opts.json) console.log(jsonStringify(result));
    else printTotals(result);
    return result.ok ? 0 : 1;
  }

  // Loaded on demand: the facilitator client and x402 decoder are only needed here.
  const { checkSeller } = await import('../lib/sellCheck.js');
  const report = await checkSeller({ ...shared, url: url!, method: verb, price: sub.price, pay });

  if (opts.json) console.log(jsonStringify(report));
  else printReport(report);
  return report.ok ? 0 : 1;
}

/** A pricing.md from an http(s) URL or a local file. */
async function readPricing(source: string, timeoutMs: number): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.1' } });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    return await res.text();
  }
  return readFileSync(source, 'utf8');
}

const MARK: Record<CheckStatus, string> = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip', info: 'info' };

function counts(s: Record<CheckStatus, number>): string {
  return `${s.pass} passed, ${s.warn} warning${s.warn === 1 ? '' : 's'}, ${s.fail} failed${s.skip ? `, ${s.skip} skipped` : ''}`;
}

function reportLines(report: SellCheckReport): string[] {
  const out: string[] = [`${report.method} ${report.url}`];
  for (const o of report.offers) {
    out.push(`  offer ${o.index}: ${o.scheme}/${o.transferMethod ?? '?'} ${o.amountFormatted ?? o.amount} on ${o.networkName ?? o.network} to ${o.payTo}`);
  }
  for (const c of report.checks as Check[]) out.push(`  ${MARK[c.status]}  ${c.id}: ${c.message}`);
  out.push(counts(report.summary));
  return out;
}

function printReport(report: SellCheckReport): void {
  process.stdout.write(`${reportLines(report).join('\n')}\n`);
}

function printRoute(r: RouteResult): void {
  const facts = [r.price ? `${r.price} / request` : undefined, r.free ? `free ${r.free}` : undefined].filter(Boolean).join(', ');
  const head = `== ${r.catalog} / ${r.name}: ${r.method} ${r.path}${facts ? ` (${facts})` : ''}`;
  if (!r.report) {
    process.stdout.write(`${head}\n  skip  ${r.skipped}\n\n`);
    return;
  }
  const verdict = r.report.ok ? 'ok' : 'FAIL';
  process.stdout.write(`${head}: ${verdict}\n${reportLines(r.report).map((l) => `  ${l}`).join('\n')}\n\n`);
}

function printTotals(result: RoutesReport): void {
  const r = result.summary.routes;
  const out = [`${r.checked + r.skipped} route${r.checked + r.skipped === 1 ? '' : 's'}: ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped`];
  for (const x of result.routes) {
    const unchecked = x.report?.freeQuota && !x.report.freeQuota.exhausted ? ': free quota not used up, 402 not checked' : '';
    out.push(`  ${x.report ? (x.report.ok ? 'ok  ' : 'FAIL') : 'skip'}  ${x.method} ${x.path}${x.url ? ` (${x.url})` : ''}${x.skipped ? `: ${x.skipped}` : unchecked}`);
  }
  out.push(`checks: ${counts(result.summary.checks)}`);
  if (r.checked === 0) out.push('no route was checked');
  process.stdout.write(`${out.join('\n')}\n`);
}
