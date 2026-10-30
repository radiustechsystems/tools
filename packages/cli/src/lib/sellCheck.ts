/**
 * `radius-cli sell check`: audit a seller's unpaid 402 the way a buyer and a facilitator will
 * read it, without paying (unless asked to). Every decoding and validation step reuses the code
 * buyers run: `@x402/core/http` (the decoder radius-sdk itself uses) for `PAYMENT-REQUIRED`,
 * radius-sdk's network presets, amounts and MPP parser, its facilitator client for `/supported`,
 * and its paying fetch, both to ask "would a radius-sdk buyer pay this?" and for `--pay`.
 */
import { decodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentRequired, PaymentRequirements, SupportedResponse } from '@x402/core/types';
import { generatePrivateKey } from 'viem/accounts';
import { isAddress, maxUint256, zeroAddress, type LocalAccount } from 'viem';
import {
  chainIdFromCaip2,
  formatAmount,
  parseMppChallenges,
  presetForChainId,
  PRESET_NETWORKS,
  resolveNetwork,
  resolvePrice,
  type MppChallenge,
  type PaymentNetwork,
  type Price,
} from 'radius-sdk';
import { createRadiusFetch, getPaymentReceipt, RadiusPaymentError, type PaymentOffer, type PaymentProtocol, type PaymentReceipt } from 'radius-sdk/client';
import { RadiusFacilitatorClient } from 'radius-sdk/server';
import { decidePayment } from './payPolicy.js';

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip' | 'info';

export interface Check {
  /** Stable id, e.g. `status`, `offer[0].asset`, `mpp[0].mirror`, `pay.receipt`. */
  id: string;
  status: CheckStatus;
  message: string;
}

export interface OfferSummary {
  index: number;
  scheme: string;
  network: string;
  networkName?: string;
  asset: string;
  amount: string;
  amountFormatted?: string;
  payTo: string;
  transferMethod?: string;
  maxTimeoutSeconds?: number;
}

export interface SellCheckReport {
  url: string;
  method: string;
  /** True when no check failed (warnings allowed). */
  ok: boolean;
  status: number | null;
  x402Version?: number;
  resource?: PaymentRequired['resource'];
  offers: OfferSummary[];
  mpp: { realm: string; method: string; intent: string; chainId?: unknown; amount?: unknown; currency?: unknown; recipient?: unknown; expires?: string }[];
  /** Facilitators whose `/supported` was read, by URL. */
  facilitators: Record<string, { ok: boolean; kinds?: string[]; extensions?: string[]; error?: string }>;
  payment?: { paid: boolean; status: number; protocol?: string; network?: string; amount?: string; payTo?: string; txHash?: string; payer?: string };
  /** Present when unpaid requests were served free under a rate-limit (free quota) before any 402. */
  freeQuota?: FreeQuota;
  checks: Check[];
  summary: Record<CheckStatus, number>;
}

/** What the RateLimit headers of the free (2xx) unpaid answers said, and how many there were. */
export interface FreeQuota {
  /** `RateLimit-Limit`: requests per window. */
  limit?: number;
  /** `RateLimit-Remaining` on the last free answer. */
  remaining?: number;
  /** `RateLimit-Reset` on the last free answer, in seconds. */
  resetSeconds?: number;
  /** Unpaid requests answered 2xx before the 402 (or before giving up). */
  served: number;
  /** True when a later unpaid request answered 402. */
  exhausted: boolean;
}

/** Default for `freeRequests`: the most extra unpaid requests spent working through a free quota. */
export const DEFAULT_FREE_REQUESTS = 25;

export interface SellCheckOptions {
  url: string;
  /** HTTP method of the paid route (default GET). */
  method?: string;
  headers?: Headers;
  body?: Uint8Array;
  /** Expected price per request, e.g. "$0.001" (USD, converted with each network's asset decimals). */
  price?: string;
  /** Facilitator base URLs to read `/supported` from (their kinds are merged); default: each offer network's default facilitator. */
  facilitators?: string[];
  /** Sent as `x-api-key` to the facilitators (as radius-sdk sellers send `facilitator.apiKey`). */
  facilitatorApiKey?: string;
  /** Payment asset address on Radius networks, when it is not SBC's default (radius-cli's `--sbc`). */
  radiusAssetAddress?: `0x${string}`;
  /** Also send an unpaid HEAD and warn when it is served. */
  probeHead?: boolean;
  /**
   * When the unpaid request is served (2xx) with RateLimit headers that show a free quota, send up
   * to this many more unpaid requests to use it up and reach the 402 (default 25). Sent only when
   * `RateLimit-Remaining` fits: remaining + 1 requests. 0 reports the quota without spending it.
   */
  freeRequests?: number;
  /** Make one paid request. */
  pay?: {
    networks: PaymentNetwork[];
    signer: LocalAccount | `0x${string}`;
    /** Most to pay, in the asset's display units (like `wallet pay --threshold`). */
    threshold: string;
  };
  /** Request timeout for the seller and the facilitators (default 15 s). */
  timeoutMs?: number;
  /** Timeout for the paid request of `--pay` (default: four times `timeoutMs`, at least 60 s): the seller settles before it answers. */
  paidTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const ATOMIC = /^[0-9]+$/;
const KNOWN_SCHEMES = new Set(['exact', 'upto']);
const TRANSFER_METHODS = new Set(['eip3009', 'permit2']);
/** A per-request price above this many display units (USD for every preset) is more likely a decimals mistake than a real price. */
const SUSPICIOUS_DISPLAY_AMOUNT = 1000n;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Two atomic amount strings are the same number ("01000" equals "1000"); anything else is unequal. */
function sameAtomic(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && ATOMIC.test(a) && ATOMIC.test(b) && BigInt(a) === BigInt(b);
}

/**
 * An x402 challenge in the JSON body of a 402, read as radius-sdk's buyer does (`readChallenge` in
 * radius-sdk/client): the x402 v1 body, or, off-spec but seen in the wild, a v2 body.
 */
function readBodyChallenge(body: Uint8Array): PaymentRequired | undefined {
  if (body.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body));
    if (isRecord(parsed) && (parsed.x402Version === 1 || parsed.x402Version === 2)) return parsed as unknown as PaymentRequired;
  } catch {
    /* not JSON */
  }
  return undefined;
}

function addressEq(a: unknown, b: unknown): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

/** The network an offer's CAIP-2 id (or x402 v1 name) refers to, among the SDK presets. */
function presetFor(id: unknown): PaymentNetwork | undefined {
  if (typeof id !== 'string') return undefined;
  return presetForChainId(chainIdFromCaip2(id)) ?? PRESET_NETWORKS.find((n) => n.v1Names.includes(id));
}

function transferMethodOf(version: number, req: PaymentRequirements): string {
  if (req.scheme === 'upto') return 'permit2';
  if (version === 1) return 'eip3009';
  const m = req.extra?.assetTransferMethod;
  return typeof m === 'string' ? m : 'eip3009';
}

/** `scheme/method@network (v2)` for messages and the report. */
function kindLabel(k: { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> }): string {
  const method = typeof k.extra?.assetTransferMethod === 'string' ? `/${k.extra.assetTransferMethod}` : '';
  return `${k.scheme}${method}@${k.network} (v${k.x402Version})`;
}

/** Same scheme/host/path/query, ignoring a trailing `#fragment` and default ports. */
function compareUrls(requested: string, resource: string): 'same' | 'scheme-only' | 'different' {
  let a: URL;
  let b: URL;
  try {
    a = new URL(requested);
    b = new URL(resource);
  } catch {
    return 'different';
  }
  const rest = (u: URL) => `${u.host}${u.pathname}${u.search}`;
  if (rest(a) !== rest(b)) return 'different';
  return a.protocol === b.protocol ? 'same' : 'scheme-only';
}

/** `price` in `asset`'s atomic units (SDK conversion), or the reason it has none (e.g. more decimals than the asset). */
function expectedAmount(price: string, asset: { address: `0x${string}`; decimals: number }): string | Error {
  try {
    return resolvePrice(price as Price, asset).amount;
  } catch (e) {
    return e as Error;
  }
}

const INTEGER = /^\s*(\d+)\s*$/;

/**
 * The `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` headers (IETF httpapi
 * ratelimit-headers, as separate fields), or their common `X-RateLimit-*` forms; undefined when
 * there is no `Remaining`, which is what tells a free quota from a route that is simply free.
 */
export function readRateLimit(headers: Headers): { limit?: number; remaining: number; resetSeconds?: number } | undefined {
  const num = (name: string) => {
    const m = INTEGER.exec(headers.get(`ratelimit-${name}`) ?? headers.get(`x-ratelimit-${name}`) ?? '');
    return m ? Number(m[1]) : undefined;
  };
  const remaining = num('remaining');
  if (remaining === undefined) return undefined;
  return { limit: num('limit'), remaining, resetSeconds: num('reset') };
}

function quotaText(q: { limit?: number; remaining?: number; resetSeconds?: number }): string {
  const parts = [q.limit !== undefined ? `limit ${q.limit}` : undefined, q.remaining !== undefined ? `${q.remaining} remaining` : undefined, q.resetSeconds !== undefined ? `resets in ${q.resetSeconds} s` : undefined];
  return parts.filter(Boolean).join(', ');
}

function withTimeout(fetchFn: typeof globalThis.fetch, ms: number): typeof globalThis.fetch {
  return (input, init) => fetchFn(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) });
}

export async function checkSeller(options: SellCheckOptions): Promise<SellCheckReport> {
  const method = (options.method ?? 'GET').toUpperCase();
  const timeoutMs = options.timeoutMs ?? 15_000;
  const baseFetch = withTimeout(options.fetch ?? globalThis.fetch, timeoutMs);
  const checks: Check[] = [];
  const add = (id: string, status: CheckStatus, message: string) => checks.push({ id, status, message });
  const report: SellCheckReport = { url: options.url, method, ok: false, status: null, offers: [], mpp: [], facilitators: {}, checks, summary: { pass: 0, warn: 0, fail: 0, skip: 0, info: 0 } };
  const finish = (): SellCheckReport => {
    for (const c of checks) report.summary[c.status]++;
    report.ok = report.summary.fail === 0;
    return report;
  };

  const request = () => {
    const hasBody = options.body !== undefined && method !== 'GET' && method !== 'HEAD';
    return new Request(options.url, { method, headers: options.headers, body: hasBody ? (options.body as BodyInit) : undefined, redirect: 'manual' });
  };

  // 1. The unpaid request must be refused with a 402.
  let first: Response;
  try {
    first = await baseFetch(request());
  } catch (e) {
    add('status', 'fail', `request failed: ${(e as Error).message}`);
    return finish();
  }
  // 1a. A free quota: the route is paid, but the first unpaid requests in each window are served.
  // The RateLimit headers say so; use the quota up (bounded) to reach the 402, or report it.
  const isServed = (r: Response) => r.status >= 200 && r.status < 300;
  let quota = isServed(first) ? readRateLimit(first.headers) : undefined;
  if (quota) {
    const budget = options.freeRequests ?? DEFAULT_FREE_REQUESTS;
    const free: FreeQuota = { ...quota, served: 1, exhausted: false };
    report.freeQuota = free;
    const seen = () => `unpaid ${method} answered ${first.status} with RateLimit headers (${quotaText(free)}): a free quota`;
    if (budget === 0) {
      add('free-quota', 'info', `${seen()}, not used up (--free-requests 0), so the 402 was not checked`);
      report.status = first.status;
      return finish();
    }
    if (quota.remaining + 1 > budget) {
      add('free-quota', 'warn', `${seen()}; reaching the 402 takes ${quota.remaining + 1} more unpaid requests, more than --free-requests ${budget}, so the 402 was not checked (raise --free-requests, or wait for the reset)`);
      report.status = first.status;
      return finish();
    }
    for (let sent = 0; sent < budget && quota && isServed(first); sent++) {
      await first.arrayBuffer().catch(() => undefined);
      try {
        first = await baseFetch(request());
      } catch (e) {
        add('status', 'fail', `request ${free.served + 1} failed: ${(e as Error).message}`);
        return finish();
      }
      quota = isServed(first) ? readRateLimit(first.headers) : undefined;
      if (isServed(first)) {
        free.served++;
        if (quota) Object.assign(free, quota);
      }
    }
    free.exhausted = first.status === 402;
    if (free.exhausted) add('free-quota', 'info', `free quota: ${free.served} unpaid ${method} request${free.served === 1 ? ' was' : 's were'} served (${quotaText(free)}), then 402`);
    else if (isServed(first)) {
      add('free-quota', 'warn', `${seen()}; still served after ${free.served} unpaid requests (--free-requests ${budget}), so the 402 was not checked`);
      report.status = first.status;
      return finish();
    }
  }
  const firstBody = new Uint8Array(await first.arrayBuffer());
  report.status = first.status;
  if (first.status !== 402) {
    const why = isServed(first)
      ? "the route is served without payment and without RateLimit headers, so it is not a free quota: check that the seller's paid routes include it, with the same method and path"
      : first.status >= 300 && first.status < 400
        ? `redirected to ${first.headers.get('location') ?? '(no Location)'}; check the final URL`
        : first.status === 429
          ? `rate limited${first.headers.get('retry-after') ? ` (Retry-After ${first.headers.get('retry-after')})` : ''}; wait and run it again`
          : 'expected 402 Payment Required';
    add('status', 'fail', `unpaid ${method} answered ${first.status}: ${why}`);
    return finish();
  }
  add('status', 'pass', `unpaid ${method} answers 402${report.freeQuota ? ` once the free quota is used up` : ''}`);
  const cacheControl = first.headers.get('cache-control') ?? '';
  if (/no-store/i.test(cacheControl)) add('cache', 'pass', 'the 402 is marked Cache-Control: no-store');
  else add('cache', 'warn', `the 402 has Cache-Control "${cacheControl}"; a shared cache could serve a stale challenge`);
  /** The 402 again, for the SDK buyer to parse (each Response body is read once). */
  const replay402 = () => new Response(firstBody, { status: first.status, headers: first.headers });

  // 2. The x402 challenge.
  let pr: PaymentRequired | undefined;
  let challengeFromBody = false;
  const header = first.headers.get('payment-required');
  if (!header) {
    // radius-sdk's buyer also reads a challenge from the JSON body (x402 v1, or an off-spec v2 body).
    pr = readBodyChallenge(firstBody);
    challengeFromBody = pr !== undefined;
    if (!pr) add('x402', 'fail', 'no PAYMENT-REQUIRED header and no x402 challenge in the JSON body: x402 v2 buyers find no offer (radius-sdk sellers always send one)');
  } else {
    try {
      pr = decodePaymentRequiredHeader(header);
    } catch (e) {
      add('x402', 'fail', `PAYMENT-REQUIRED does not decode: ${(e as Error).message}`);
    }
  }
  if (pr !== undefined && !isRecord(pr)) {
    add('x402', 'fail', 'PAYMENT-REQUIRED decodes but is not a JSON object');
    pr = undefined;
  }

  // Facilitator `/supported` answers, fetched once per URL.
  const supportedCache = new Map<string, Promise<SupportedResponse>>();
  const supportedFrom = (network: PaymentNetwork, url: string) => {
    let p = supportedCache.get(url);
    if (!p) {
      p = Promise.resolve().then(() => new RadiusFacilitatorClient(network, { url, apiKey: options.facilitatorApiKey, timeoutMs }).getSupported());
      supportedCache.set(url, p);
      p.then(
        (s) => { report.facilitators[url] = { ok: true, kinds: s.kinds.map(kindLabel), extensions: s.extensions }; },
        (e: unknown) => { report.facilitators[url] = { ok: false, error: e instanceof Error ? e.message : String(e) }; },
      );
    }
    return p;
  };
  /** Kinds and extensions every facilitator that would settle `network` lists, or why none could be read. */
  const facilitatorFor = async (network: PaymentNetwork): Promise<{ urls: string[]; kinds: SupportedResponse['kinds']; extensions: string[] } | { error: string; skip?: boolean }> => {
    const urls = options.facilitators?.length ? options.facilitators : network.facilitatorUrl ? [network.facilitatorUrl] : [];
    if (urls.length === 0) return { error: `${network.name} has no default facilitator; pass --facilitator <url> (the one your seller settles through)`, skip: true };
    const settled = await Promise.allSettled(urls.map((u) => supportedFrom(network, u)));
    const ok = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    if (ok.length === 0) {
      const reasons = settled.map((s, i) => `${urls[i]}: ${s.status === 'rejected' ? (s.reason instanceof Error ? s.reason.message : String(s.reason)) : ''}`);
      return { error: `could not read /supported (${reasons.join('; ')})` };
    }
    return { urls, kinds: ok.flatMap((s) => s.kinds), extensions: [...new Set(ok.flatMap((s) => s.extensions ?? []))] };
  };

  const offerNetworks: PaymentNetwork[] = [];
  /** The well-formed (object) offers of the challenge, for the MPP mirror check. */
  const x402Offers: PaymentRequirements[] = [];
  if (pr) {
    const version = pr.x402Version as number;
    if (version !== 2) add('x402', version === 1 ? 'warn' : 'fail', `x402Version ${String(version)}: radius-sdk sellers speak v2`);
    const accepts: unknown[] = Array.isArray(pr.accepts) ? pr.accepts : [];
    if (accepts.length === 0) add('x402', 'fail', `${challengeFromBody ? 'The challenge' : 'PAYMENT-REQUIRED'} decodes but lists no offers (accepts is ${Array.isArray(pr.accepts) ? 'empty' : 'not an array'})`);
    else if (challengeFromBody && version === 2) add('x402', 'warn', `x402 v2 challenge found in the JSON body, not the PAYMENT-REQUIRED header: radius-sdk buyers accept it, spec-following v2 buyers read only the header; ${accepts.length} offer${accepts.length === 1 ? '' : 's'}`);
    else if (version === 2) add('x402', 'pass', `PAYMENT-REQUIRED decodes: x402 v2, ${accepts.length} offer${accepts.length === 1 ? '' : 's'}`);
    else if (challengeFromBody) add('x402', 'info', `x402 v${String(version)} challenge read from the JSON body, as radius-sdk buyers do; ${accepts.length} offer${accepts.length === 1 ? '' : 's'}`);
    report.x402Version = version;
    report.resource = pr.resource;

    // 3. The resource the challenge was issued for.
    const resourceUrl = pr.resource?.url;
    if (typeof resourceUrl !== 'string') {
      add('resource', version === 2 ? 'fail' : 'skip', 'challenge names no resource.url');
    } else {
      const cmp = compareUrls(options.url, resourceUrl);
      if (cmp === 'same') add('resource', 'pass', `resource.url is the requested URL`);
      else if (cmp === 'scheme-only') add('resource', 'warn', `resource.url ${resourceUrl} differs from ${options.url} only in scheme; behind a TLS proxy, make the app see the public URL (X-Forwarded-Proto / trust proxy)`);
      else add('resource', 'fail', `resource.url ${resourceUrl} is not the requested URL ${options.url}: the challenge is bound to another resource`);
    }

    const sponsoringDeclared = isRecord(pr.extensions) && 'eip2612GasSponsoring' in pr.extensions;

    // 4. Each offer.
    for (const [i, offer] of accepts.entries()) {
      const at = `offer[${i}]`;
      if (!isRecord(offer)) {
        add(at, 'fail', `offer ${i} is not an object (${offer === null ? 'null' : Array.isArray(offer) ? 'array' : typeof offer}); buyers skip it`);
        continue;
      }
      const req = offer as unknown as PaymentRequirements;
      x402Offers.push(req);
      const network = presetFor(req.network);
      const amountRaw = version === 1 ? (req as unknown as { maxAmountRequired?: unknown }).maxAmountRequired : req.amount;
      const transfer = transferMethodOf(version, req);
      const summary: OfferSummary = {
        index: i, scheme: String(req.scheme), network: String(req.network), networkName: network?.name, asset: String(req.asset),
        amount: String(amountRaw), payTo: String(req.payTo), transferMethod: transfer,
        maxTimeoutSeconds: typeof req.maxTimeoutSeconds === 'number' ? req.maxTimeoutSeconds : undefined,
      };
      report.offers.push(summary);

      if (KNOWN_SCHEMES.has(req.scheme) && !(req.scheme === 'upto' && version !== 2)) add(`${at}.scheme`, 'pass', `scheme ${req.scheme}`);
      else add(`${at}.scheme`, 'fail', `scheme ${String(req.scheme)}@v${version} is not one radius-sdk buyers pay (exact, or upto on v2)`);

      if (!network) {
        add(`${at}.network`, 'fail', `unknown network ${String(req.network)} (radius-sdk knows ${PRESET_NETWORKS.map((n) => `${n.network} ${n.name}`).join(', ')})`);
      } else {
        add(`${at}.network`, 'pass', `network ${req.network} (${network.name}${network.testnet ? ', testnet' : ''})`);
        if (!offerNetworks.includes(network)) offerNetworks.push(network);
      }

      // The asset is the network's payment asset, so buyers sign the right EIP-712 domain.
      const expected = network
        ? network.radius && options.radiusAssetAddress ? { ...network.asset, address: options.radiusAssetAddress } : network.asset
        : undefined;
      if (expected) {
        if (addressEq(req.asset, expected.address)) add(`${at}.asset`, 'pass', `asset ${expected.symbol} ${expected.address}`);
        else add(`${at}.asset`, 'fail', `asset ${String(req.asset)} is not ${expected.symbol} on ${network!.name} (${expected.address}); buyers refuse it (asset_mismatch)`);
        if (version === 2 && req.scheme === 'exact') {
          const name = req.extra?.name;
          const ver = req.extra?.version;
          if ((name === undefined || name === expected.name) && (ver === undefined || ver === expected.version)) {
            add(`${at}.domain`, 'pass', `EIP-712 domain "${expected.name}" v${expected.version}`);
          } else {
            add(`${at}.domain`, 'fail', `extra.name/version "${String(name)}" v${String(ver)} do not match ${expected.symbol}'s EIP-712 domain "${expected.name}" v${expected.version}; signatures will not verify`);
          }
        }
      } else add(`${at}.asset`, 'skip', 'asset not checked: unknown network');

      // Amount: an atomic integer; against --price when given (the decimals check), else a sanity bound.
      if (typeof amountRaw !== 'string' || !ATOMIC.test(amountRaw)) {
        add(`${at}.amount`, 'fail', `amount ${JSON.stringify(amountRaw)} is not an atomic integer string`);
      } else if (expected) {
        const atomic = BigInt(amountRaw);
        const display = formatAmount(atomic, expected.decimals, expected.symbol);
        summary.amountFormatted = display;
        const want = options.price === undefined ? undefined : expectedAmount(options.price, expected);
        if (want instanceof Error) {
          add(`${at}.amount`, 'fail', `--price ${options.price} cannot be priced in ${expected.symbol}: ${want.message}`);
        } else if (want !== undefined) {
          if (atomic === BigInt(want)) add(`${at}.amount`, 'pass', `amount ${amountRaw} = ${display}, the expected ${options.price} at ${expected.decimals} decimals`);
          else {
            const ratio = BigInt(want) > 0n && atomic % BigInt(want) === 0n ? atomic / BigInt(want) : 0n;
            const exp = ratio > 1n && /^10*$/.test(ratio.toString()) ? ratio.toString().length - 1 : 0;
            const hint = exp > 0 ? `; that is ${options.price} at ${expected.decimals + exp} decimals, but ${expected.symbol} has ${expected.decimals}` : '';
            add(`${at}.amount`, 'fail', `amount ${amountRaw} (${display}) is not ${want}, the expected ${options.price} in ${expected.symbol}${hint}`);
          }
        } else if (atomic === 0n) {
          add(`${at}.amount`, 'warn', 'amount is 0');
        } else if (atomic > SUSPICIOUS_DISPLAY_AMOUNT * 10n ** BigInt(expected.decimals)) {
          add(`${at}.amount`, 'warn', `amount ${amountRaw} is ${display} per request; check the asset's decimals (${expected.decimals}), or pass --price to check it exactly`);
        } else add(`${at}.amount`, 'pass', `amount ${amountRaw} = ${display}`);
      } else add(`${at}.amount`, ATOMIC.test(String(amountRaw)) ? 'skip' : 'fail', `amount ${String(amountRaw)} (decimals unknown)`);

      if (typeof req.payTo === 'string' && isAddress(req.payTo, { strict: false }) && !addressEq(req.payTo, zeroAddress)) add(`${at}.payTo`, 'pass', `payTo ${req.payTo}`);
      else add(`${at}.payTo`, 'fail', `payTo ${JSON.stringify(req.payTo)} is not a usable address`);

      const t = req.maxTimeoutSeconds;
      if (typeof t !== 'number' || !Number.isInteger(t) || t <= 0) add(`${at}.maxTimeoutSeconds`, 'fail', `maxTimeoutSeconds ${JSON.stringify(t)} is not a positive integer`);
      else if (t < 30) add(`${at}.maxTimeoutSeconds`, 'warn', `maxTimeoutSeconds ${t}: a buyer has under 30 s to sign and send the payment`);
      else if (t > 3600) add(`${at}.maxTimeoutSeconds`, 'warn', `maxTimeoutSeconds ${t}: signed payments stay redeemable for over an hour (radius-sdk buyers clamp to 600)`);
      else add(`${at}.maxTimeoutSeconds`, 'pass', `maxTimeoutSeconds ${t}`);

      if (version === 2 && req.scheme === 'exact' && !TRANSFER_METHODS.has(transfer)) {
        add(`${at}.transferMethod`, 'fail', `assetTransferMethod ${transfer} is not eip3009 or permit2`);
      } else if (req.scheme === 'upto' && !(typeof req.extra?.facilitatorAddress === 'string' && isAddress(req.extra.facilitatorAddress, { strict: false }))) {
        add(`${at}.transferMethod`, 'fail', 'upto offer names no extra.facilitatorAddress for the Permit2 witness');
      } else add(`${at}.transferMethod`, 'pass', `transfer method ${transfer}`);

      // 5. The facilitator settles this kind of payment.
      if (!network) {
        add(`${at}.facilitator`, 'skip', 'facilitator not checked: unknown network');
        continue;
      }
      const fac = await facilitatorFor(network);
      if ('error' in fac) {
        add(`${at}.facilitator`, fac.skip ? 'skip' : 'fail', fac.error);
        continue;
      }
      const onNetwork = fac.kinds.filter((k) => k.network === req.network);
      const match = onNetwork.find((k) => k.x402Version === version && k.scheme === req.scheme && (version === 1 || req.scheme === 'upto' || ((k.extra?.assetTransferMethod as string | undefined) ?? 'eip3009') === transfer));
      const where = fac.urls.join(', ');
      if (match) add(`${at}.facilitator`, 'pass', `${where} supports ${kindLabel(match)}`);
      else if (onNetwork.length === 0) add(`${at}.facilitator`, 'fail', `${where} does not support ${req.network} at all (lists ${fac.kinds.map(kindLabel).join(', ') || 'nothing'})`);
      else add(`${at}.facilitator`, 'fail', `${where} does not support ${req.scheme}/${transfer} v${version} on ${req.network} (lists ${onNetwork.map(kindLabel).join(', ')})`);
      if (sponsoringDeclared && transfer === 'permit2' && !fac.extensions.includes('eip2612GasSponsoring')) {
        add(`${at}.gasSponsoring`, 'warn', `the 402 declares eip2612GasSponsoring but ${where} does not list it; first-time Permit2 payers will be rejected`);
      }
    }
  }

  // 6. MPP challenges (`WWW-Authenticate: Payment`), whoever serves them.
  const mppChallenges: MppChallenge[] = parseMppChallenges(first.headers.get('www-authenticate'));
  if (mppChallenges.length === 0) {
    add('mpp', 'info', 'no MPP challenge (WWW-Authenticate: Payment): buyers can pay over x402 only. MPP is optional and enabled in the seller\'s payment setup (with radius-sdk: mpp: { secretKey } in radiusPayments() or radius-sdk/hono)');
  } else {
    add('mpp', 'pass', `${mppChallenges.length} MPP challenge${mppChallenges.length === 1 ? '' : 's'}`);
  }
  for (const [i, c] of mppChallenges.entries()) {
    const at = `mpp[${i}]`;
    const r = c.request as { amount?: unknown; currency?: unknown; recipient?: unknown; methodDetails?: { chainId?: unknown; decimals?: unknown } };
    const chainId = r.methodDetails?.chainId;
    report.mpp.push({ realm: c.realm, method: c.method, intent: c.intent, chainId, amount: r.amount, currency: r.currency, recipient: r.recipient, expires: c.expires });
    if (c.method !== 'evm' || c.intent !== 'charge') {
      add(`${at}.method`, 'info', `MPP ${c.method}/${c.intent} is not an evm charge; radius-sdk buyers skip it`);
      continue;
    }
    const network = typeof chainId === 'number' ? presetForChainId(chainId) : undefined;
    if (!network) {
      add(`${at}.network`, 'fail', `unknown chainId ${JSON.stringify(chainId)}`);
      continue;
    }
    const asset = network.radius && options.radiusAssetAddress ? { ...network.asset, address: options.radiusAssetAddress } : network.asset;
    const problems: string[] = [];
    if (!addressEq(r.currency, asset.address)) problems.push(`currency ${String(r.currency)} is not ${asset.symbol} (${asset.address})`);
    if (r.methodDetails?.decimals !== undefined && r.methodDetails.decimals !== asset.decimals) problems.push(`decimals ${String(r.methodDetails.decimals)}, but ${asset.symbol} has ${asset.decimals}`);
    if (typeof r.amount !== 'string' || !ATOMIC.test(r.amount)) problems.push(`amount ${JSON.stringify(r.amount)} is not an atomic integer string`);
    else if (options.price !== undefined) {
      const want = expectedAmount(options.price, asset);
      if (want instanceof Error) problems.push(`--price ${options.price} cannot be priced in ${asset.symbol}: ${want.message}`);
      else if (!sameAtomic(r.amount, want)) problems.push(`amount ${r.amount} is not the expected ${options.price}`);
    }
    if (typeof r.recipient !== 'string' || !isAddress(r.recipient, { strict: false })) problems.push(`recipient ${JSON.stringify(r.recipient)} is not an address`);
    const expires = c.expires ? Date.parse(c.expires) : Number.NaN;
    if (!Number.isFinite(expires)) problems.push('no expires');
    else if (expires <= Date.now()) problems.push(`expired at ${c.expires}`);
    if (problems.length) add(`${at}.challenge`, 'fail', `MPP challenge on ${network.name}: ${problems.join('; ')}`);
    else add(`${at}.challenge`, 'pass', `MPP evm charge ${formatAmount(BigInt(r.amount as string), asset.decimals, asset.symbol)} on ${network.name} to ${String(r.recipient)}, expires ${c.expires}`);
    // radius-sdk sellers mirror an x402 offer exactly; a challenge that mirrors none prices the route differently per protocol.
    if (pr) {
      if (x402Offers.length === 0) add(`${at}.mirror`, 'skip', 'no well-formed x402 offer to compare with');
      else {
        // v1 offers name the amount `maxAmountRequired` and the network by alias ("base"); compare the same facts.
        const v1 = pr.x402Version === 1;
        const mirrored = x402Offers.some((a) => presetFor(a.network)?.network === network.network && addressEq(a.asset, r.currency) && addressEq(a.payTo, r.recipient) &&
          sameAtomic(v1 ? (a as unknown as { maxAmountRequired?: unknown }).maxAmountRequired : a.amount, r.amount));
        add(`${at}.mirror`, mirrored ? 'pass' : 'warn', mirrored ? 'mirrors an x402 offer (amount, asset, recipient, network)' : 'matches no x402 offer: the route costs something different over MPP');
      }
    }
  }

  // 7. Would radius-sdk's own buyer pay it? (It parses and selects; a random key, declined before signing.)
  const mppNetworks = mppChallenges
    .map((c) => (c.request.methodDetails as { chainId?: unknown } | undefined)?.chainId)
    .map((id) => (typeof id === 'number' ? presetForChainId(id) : undefined))
    .filter((n): n is PaymentNetwork => !!n);
  for (const protocol of ['x402', 'mpp'] as PaymentProtocol[]) {
    if (protocol === 'x402' && !pr) continue;
    if (protocol === 'mpp' && mppChallenges.length === 0) continue;
    const nets = [...new Set(protocol === 'x402' ? offerNetworks : mppNetworks)];
    if (nets.length === 0) {
      add(`buyer.${protocol}`, 'skip', `radius-sdk buyer not tried: no ${protocol} offer on a known network`);
      continue;
    }
    const selected = await sdkSelects(protocol, nets.map((n) => (n.radius && options.radiusAssetAddress ? resolveNetwork(n, { asset: { address: options.radiusAssetAddress } }) : n)), options.url, request, replay402);
    if ('offer' in selected) add(`buyer.${protocol}`, 'pass', `a radius-sdk buyer would pay ${selected.offer.amountFormatted} on ${selected.offer.network.name} (${selected.offer.transferMethod})`);
    else add(`buyer.${protocol}`, 'fail', `a radius-sdk buyer refuses it: ${selected.code}: ${selected.message}`);
  }

  // 8. HEAD: x402 route verbs match exactly, so a router answering HEAD with the GET handler runs it unpaid.
  if (options.probeHead) {
    try {
      const head = await baseFetch(new Request(options.url, { method: 'HEAD', headers: options.headers, redirect: 'manual' }));
      if (head.status >= 200 && head.status < 300) add('head', 'warn', `unpaid HEAD answered ${head.status}: the paid handler probably ran without payment (declare a HEAD route, or refuse HEAD before the handler)`);
      else add('head', 'pass', `unpaid HEAD answered ${head.status}`);
    } catch (e) {
      add('head', 'warn', `HEAD request failed: ${(e as Error).message}`);
    }
  }

  // 9. One real payment.
  if (options.pay) {
    if (checks.some((c) => c.status === 'fail')) add('pay', 'skip', 'not paying: fix the failed checks first');
    else await payOnce(options, method, add, report, timeoutMs);
  }

  return finish();
}

/** What radius-sdk's buyer selects from the 402 (declining before it signs anything), or its refusal. */
async function sdkSelects(
  protocol: PaymentProtocol,
  networks: PaymentNetwork[],
  url: string,
  request: () => Request,
  replay402: () => Response,
): Promise<{ offer: PaymentOffer } | { code: string; message: string }> {
  let offer: PaymentOffer | undefined;
  const probe = createRadiusFetch({
    networks,
    protocols: [protocol],
    signer: generatePrivateKey(),
    maxPerRequest: { amount: maxUint256.toString() },
    preferFunded: false,
    fetch: async () => replay402(),
    onPaymentRequired: (o) => {
      offer = o;
      return false;
    },
  });
  try {
    await probe(request());
  } catch (e) {
    if (offer) return { offer };
    if (e instanceof RadiusPaymentError) return { code: e.code, message: e.message };
    return { code: 'error', message: (e as Error).message };
  }
  return { code: 'error', message: `no payment was proposed for ${url}` };
}

async function payOnce(options: SellCheckOptions, method: string, add: (id: string, status: CheckStatus, message: string) => void, report: SellCheckReport, timeoutMs: number): Promise<void> {
  const pay = options.pay!;
  let offer: PaymentOffer | undefined;
  let refused: string | undefined;
  // The paid leg settles on chain before the seller answers, so it gets a longer budget than an unpaid request.
  const paidTimeoutMs = options.paidTimeoutMs ?? Math.max(timeoutMs * 4, 60_000);
  const unpaidFetch = withTimeout(options.fetch ?? globalThis.fetch, timeoutMs);
  const paidFetch = withTimeout(options.fetch ?? globalThis.fetch, paidTimeoutMs);
  let paymentSent = false;
  const timedFetch: typeof globalThis.fetch = (input, init) => {
    // The same test radius-sdk's fetch uses to recognise a request that already carries a payment.
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const carriesPayment = headers.has('payment-signature') || headers.has('x-payment') || /^payment\s/i.test(headers.get('authorization') ?? '');
    if (carriesPayment) {
      paymentSent = true;
      return paidFetch(input, init);
    }
    return unpaidFetch(input, init);
  };
  const payFetch = createRadiusFetch({
    networks: pay.networks,
    signer: pay.signer,
    maxPerRequest: { amount: maxUint256.toString() },
    fetch: timedFetch,
    onPaymentRequired: async (o) => {
      offer = o;
      const decision = decidePayment({ threshold: pay.threshold, yes: true }, BigInt(o.amount), o.network.asset.decimals, false);
      if (decision !== 'auto-pay') {
        refused = `offer of ${o.amountFormatted} exceeds --threshold ${pay.threshold}`;
        return false;
      }
      const balance = await payFetch.on(o.network).balance();
      if (balance.atomic < BigInt(o.amount)) {
        refused = `insufficient balance on ${o.network.name}: need ${o.amountFormatted}, have ${balance.formatted}`;
        return false;
      }
      return true;
    },
  });
  const hasBody = options.body !== undefined && method !== 'GET' && method !== 'HEAD';
  let res: Response;
  try {
    res = await payFetch(options.url, { method, headers: options.headers, body: hasBody ? (options.body as BodyInit) : undefined });
  } catch (e) {
    // After the payment header went out, anything but a clean rejection leaves the outcome unknown.
    const rejected = e instanceof RadiusPaymentError && (e.code === 'declined' || e.code === 'payment_rejected');
    const maybeSettled = paymentSent && !refused && !rejected
      ? `; the payment was sent and may have settled (no transaction hash was received): check the buyer wallet and the seller's facilitator before paying again${offer ? ` (offer: ${offer.amountFormatted} to ${offer.payTo} on ${offer.network.name})` : ''}`
      : '';
    if (refused) add('pay', 'fail', `not paid: ${refused}`);
    else if (e instanceof RadiusPaymentError) add('pay', 'fail', `payment failed: ${e.code}: ${e.message}${maybeSettled}`);
    else add('pay', 'fail', `payment failed: ${(e as Error).message}${maybeSettled}`);
    return;
  }
  await res.arrayBuffer().catch(() => undefined);
  const receipt: PaymentReceipt | undefined = offer ? getPaymentReceipt(res, offer.network) : undefined;
  report.payment = {
    paid: res.ok && receipt?.success === true, status: res.status, protocol: offer?.protocol, network: offer?.network.network,
    amount: offer?.amountFormatted, payTo: offer?.payTo, txHash: receipt?.transaction, payer: receipt?.payer,
  };
  if (!res.ok) add('pay', 'fail', `paid request answered ${res.status}${receipt?.success ? ` (settled: ${receipt.transaction ?? 'no tx'}; a paid failure to reconcile)` : ''}`);
  else add('pay', 'pass', `paid request answered ${res.status} after paying ${offer?.amountFormatted ?? '?'} over ${offer?.protocol ?? '?'}`);
  if (receipt?.success && receipt.transaction) add('pay.receipt', 'pass', `receipt: transaction ${receipt.transaction}${receipt.explorerUrl ? ` (${receipt.explorerUrl})` : ''}`);
  else if (receipt) add('pay.receipt', 'fail', `receipt reports no successful settlement${receipt.errorReason ? ` (${receipt.errorReason})` : ''}`);
  else add('pay.receipt', 'fail', 'no PAYMENT-RESPONSE or Payment-Receipt header on the paid response: HTTP success is not payment proof');
}
