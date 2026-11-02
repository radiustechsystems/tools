import type { Command } from 'commander';
import { resolveConfig, resolvePayNetworks, PAY_NETWORKS } from '../lib/config.js';
import { jsonStringify } from '../lib/format.js';
import { isSupportedVerb, looksLikeJson, parseHeaderArgs, readBodyArg, SUPPORTED_VERBS } from '../lib/http.js';
import { parseUnits } from 'viem';
import { resolvePrice } from 'radius-sdk';
import type { Check, CheckStatus, SellCheckOptions, SellCheckReport } from '../lib/sellCheck.js';
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
}

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
        '  radius-cli sell check http://127.0.0.1:3000/api/report',
        "  radius-cli sell check http://127.0.0.1:3000/api/report --price '$0.001' --probe-head",
        '  radius-cli sell check https://api.example.com/query -X POST -d \'{"q":1}\' --facilitator https://facilitator.example',
        '  RADIUS_HOME=.radius radius-cli sell check https://api.example.com/r --pay --threshold 0.01   # one testnet payment',
      ].join('\n'),
    )
    .argument('<url>', 'URL of a paid route')
    .option('-X, --method <verb>', `HTTP method (${SUPPORTED_VERBS.join(', ')})`, 'get')
    .option('-H, --header <h...>', "request header, repeatable: 'Key: Value'")
    .option('-d, --data <body>', "request body (literal, '@path' for file, '-' for stdin)")
    .option('--price <usd>', "expected price per request, e.g. '$0.001': checks each offer's atomic amount with its asset's decimals")
    .option('--facilitator <url...>', "facilitator(s) the seller settles through, for /supported (default: each network's default facilitator)")
    .option('--probe-head', 'also send an unpaid HEAD and warn if it is served (HEAD can run a paid GET handler)')
    .option('--pay', 'then make one paid request from the local wallet and check the receipt (testnet unless --network mainnet)')
    .option('--threshold <decimal>', "with --pay: most to pay, in the asset's display units (required)")
    .option('--networks <list>', `with --pay: networks to pay on (${PAY_NETWORKS.join(', ')}; default radius)`)
    .option('--timeout <ms>', 'timeout for each request, in milliseconds', '15000')
    .action(async (url: string, sub: CheckOptions, cmd: Command) => {
      const opts = cmd.optsWithGlobals() as GlobalOptions;
      // exitCode, not exit(): exiting right away can drop a large report still buffered for a pipe.
      process.exitCode = await runCheck(url, sub, opts);
    });
}

function usage(message: string): number {
  process.stderr.write(`sell check: ${message}\n`);
  return 2;
}

async function runCheck(url: string, sub: CheckOptions, opts: GlobalOptions): Promise<number> {
  try {
    new URL(url);
  } catch {
    return usage(`not a URL: ${url}`);
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
    const { deferredAccount } = await import('../lib/account.js');
    pay = { networks: payNetworks, signer: await deferredAccount(cfg, opts.privateKey), threshold: sub.threshold! };
  }

  // Loaded on demand: the facilitator client and x402 decoder are only needed here.
  const { checkSeller } = await import('../lib/sellCheck.js');
  const report = await checkSeller({
    url,
    method: verb,
    headers,
    body,
    price: sub.price,
    facilitators: sub.facilitator,
    facilitatorApiKey: process.env.RADIUS_FACILITATOR_API_KEY,
    radiusAssetAddress: cfg.sbcAddress,
    probeHead: sub.probeHead,
    pay,
    timeoutMs,
  });

  if (opts.json) console.log(jsonStringify(report));
  else printReport(report);
  return report.ok ? 0 : 1;
}

const MARK: Record<CheckStatus, string> = { pass: 'ok  ', warn: 'warn', fail: 'FAIL', skip: 'skip', info: 'info' };

function printReport(report: SellCheckReport): void {
  const out: string[] = [`${report.method} ${report.url}`];
  for (const o of report.offers) {
    out.push(`  offer ${o.index}: ${o.scheme}/${o.transferMethod ?? '?'} ${o.amountFormatted ?? o.amount} on ${o.networkName ?? o.network} to ${o.payTo}`);
  }
  for (const c of report.checks as Check[]) out.push(`  ${MARK[c.status]}  ${c.id}: ${c.message}`);
  const s = report.summary;
  out.push(`${s.pass} passed, ${s.warn} warning${s.warn === 1 ? '' : 's'}, ${s.fail} failed${s.skip ? `, ${s.skip} skipped` : ''}`);
  process.stdout.write(`${out.join('\n')}\n`);
}
