/**
 * `sell check` discovery lint: does the seller's OpenAPI document list the priced route, and does
 * the operation say it is paid, at the price the 402 asks?
 *
 * It follows the convention the Radius Platform reads when it proposes endpoints from a seller's
 * OpenAPI document, one per operation:
 *
 *   x-radius-price   the price per call in USD, as a decimal string such as "0.001"
 *   x-radius-free    the operation is free
 *   a 402 response   the operation is paid at the project's default price
 *
 * An operation with none of these is read as free. `x-payment-info`, which some x402 discovery
 * tools read and which has no ratified schema, is only a fallback read when present: its protocols
 * and its price are compared when they can be read without guessing the unit (a `$`-prefixed USD
 * string, `{ amount, currency: "USD" }`, or an atomic amount with the asset address). It is never
 * required.
 */
import { resolvePrice, type PaymentNetwork, type Price } from 'radius-sdk';
import type { CheckStatus } from './sellCheck.js';

/** A parsed OpenAPI document and where it came from (sell check --openapi <file>). */
export interface OpenApiSource {
  source: string;
  document: unknown;
}

type Loaded = { ok: true; source: string; document: unknown } | { ok: false; source: string; reason: string };
export type OpenApiCache = Map<string, Promise<Loaded>>;

export interface DiscoveryOffer {
  network: PaymentNetwork | undefined;
  asset: string;
  amount: unknown;
}

export interface DiscoveryInput {
  url: string;
  method: string;
  /** Undefined: `/openapi.json` on the URL's origin. A string: that URL. */
  source: string | OpenApiSource | undefined;
  x402Offers: DiscoveryOffer[];
  hasMpp: boolean;
  fetch: typeof globalThis.fetch;
  cache?: OpenApiCache;
}

export interface DiscoveryCheck {
  id: string;
  status: CheckStatus;
  message: string;
}

const ATOMIC = /^[0-9]+$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function load(url: string, fetchFn: typeof globalThis.fetch): Promise<Loaded> {
  let res: Response;
  try {
    res = await fetchFn(new Request(url, { headers: { accept: 'application/json' } }));
  } catch (e) {
    return { ok: false, source: url, reason: `request failed: ${(e as Error).message}` };
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, source: url, reason: `answered ${res.status}` };
  try {
    return { ok: true, source: url, document: JSON.parse(text) };
  } catch {
    return { ok: false, source: url, reason: `answered ${res.status} but not with JSON` };
  }
}

/** `/a/{id}/b` as a regular expression over a request path. */
function templateRegex(template: string): RegExp {
  const parts = template.split(/(\{[^}/]+\})/).map((p) => (/^\{[^}/]+\}$/.test(p) ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return new RegExp(`^${parts.join('')}$`);
}

/** Path prefixes the document's `servers` put in front of its paths ('' when it names none). */
function serverPrefixes(doc: Record<string, unknown>, docUrl: string, requestUrl: URL): string[] {
  const prefixes = new Set<string>();
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  for (const s of servers) {
    if (!isRecord(s) || typeof s.url !== 'string') continue;
    try {
      const u = new URL(s.url.replace(/\{[^}]*\}/g, 'x'), /^https?:/i.test(docUrl) ? docUrl : requestUrl.href);
      prefixes.add(u.pathname.replace(/\/+$/, ''));
    } catch {
      /* unusable server URL */
    }
  }
  prefixes.add('');
  return [...prefixes];
}

/** The operation of `doc` that serves `method requestUrl`, and the path template that matched. */
function findOperation(doc: Record<string, unknown>, docUrl: string, method: string, requestUrl: URL): { template: string; operation?: Record<string, unknown> } | undefined {
  const paths = doc.paths as Record<string, unknown>;
  const templates = Object.keys(paths);
  for (const prefix of serverPrefixes(doc, docUrl, requestUrl)) {
    if (!requestUrl.pathname.startsWith(prefix)) continue;
    const rel = requestUrl.pathname.slice(prefix.length) || '/';
    // A literal path wins over a template (OpenAPI path matching).
    const template = templates.find((t) => t === rel) ?? templates.find((t) => t.includes('{') && templateRegex(t).test(rel));
    if (!template) continue;
    const item = paths[template];
    const operation = isRecord(item) ? item[method.toLowerCase()] : undefined;
    return { template, operation: isRecord(operation) ? operation : undefined };
  }
  return undefined;
}

/** Protocol names `x-payment-info` lists, lower case; undefined when it lists none. */
function declaredProtocols(info: Record<string, unknown>): string[] | undefined {
  const p = info.protocols ?? info.protocol;
  const names: string[] = [];
  const nameOf = (v: unknown) => {
    if (typeof v === 'string') names.push(v);
    else if (isRecord(v)) {
      const n = v.protocol ?? v.name ?? v.type;
      if (typeof n === 'string') names.push(n);
      else if (Object.keys(v).length === 1) names.push(Object.keys(v)[0]!);
    }
  };
  if (Array.isArray(p)) p.forEach(nameOf);
  else if (typeof p === 'string') nameOf(p);
  else if (isRecord(p)) names.push(...Object.keys(p));
  else return undefined;
  return names.map((n) => n.toLowerCase());
}

type DeclaredPrice = { usd: string } | { atomic: string; asset?: string };

/** The price `x-payment-info` declares, when it can be read without guessing its unit. */
function declaredPrice(info: Record<string, unknown>): DeclaredPrice | undefined {
  const price = info.price;
  if (typeof price === 'string' && /^\$\s*\d/.test(price.trim())) return { usd: price.trim().replace(/^\$\s*/, '$') };
  const holder = isRecord(price) ? price : info;
  const amount = holder.amount;
  const currency = holder.currency ?? holder.asset;
  const amountText = typeof amount === 'number' ? String(amount) : typeof amount === 'string' ? amount.trim() : undefined;
  if (amountText === undefined) return undefined;
  if (typeof currency === 'string' && /^usd$/i.test(currency) && /^\d+(\.\d+)?$/.test(amountText)) return { usd: `$${amountText}` };
  if (typeof currency === 'string' && /^0x[0-9a-fA-F]{40}$/.test(currency) && ATOMIC.test(amountText)) return { atomic: amountText, asset: currency };
  return undefined;
}

function matchesOffer(price: DeclaredPrice, offer: DiscoveryOffer): boolean {
  if (typeof offer.amount !== 'string' || !ATOMIC.test(offer.amount)) return false;
  if ('atomic' in price) {
    if (price.asset && price.asset.toLowerCase() !== offer.asset.toLowerCase()) return false;
    return BigInt(price.atomic) === BigInt(offer.amount);
  }
  if (!offer.network || !/^0x[0-9a-fA-F]{40}$/.test(offer.asset)) return false;
  try {
    return BigInt(resolvePrice(price.usd as Price, { address: offer.asset as `0x${string}`, decimals: offer.network.asset.decimals }).amount) === BigInt(offer.amount);
  } catch {
    return false;
  }
}

/** The discovery checks for one priced route (ids `discovery.*`). */
export async function lintOpenApi(input: DiscoveryInput): Promise<DiscoveryCheck[]> {
  const out: DiscoveryCheck[] = [];
  const add = (id: string, status: CheckStatus, message: string) => out.push({ id: `discovery.${id}`, status, message });
  const requestUrl = new URL(input.url);
  const explicit = input.source !== undefined;
  let loaded: Loaded;
  if (typeof input.source === 'object') loaded = { ok: true, source: input.source.source, document: input.source.document };
  else {
    const docUrl = typeof input.source === 'string' ? input.source : new URL('/openapi.json', requestUrl).href;
    let p = input.cache?.get(docUrl);
    if (!p) {
      p = load(docUrl, input.fetch);
      input.cache?.set(docUrl, p);
    }
    loaded = await p;
  }
  if (!loaded.ok) {
    if (explicit) add('openapi', 'warn', `OpenAPI document ${loaded.source} ${loaded.reason}`);
    else add('openapi', 'info', `no OpenAPI document at ${loaded.source} (${loaded.reason}): agents that discover paid routes from OpenAPI will not find this one. Optional; pass --openapi <url|file> if it is published elsewhere`);
    return out;
  }
  const doc = loaded.document;
  if (!isRecord(doc) || !(typeof doc.openapi === 'string' || typeof doc.swagger === 'string') || !isRecord(doc.paths)) {
    add('openapi', 'warn', `${loaded.source} is not an OpenAPI document (no openapi version or paths object)`);
    return out;
  }
  const found = findOperation(doc, loaded.source, input.method, requestUrl);
  if (!found) {
    add('route', 'warn', `${loaded.source} lists no path for ${requestUrl.pathname}: agents that discover paid routes from OpenAPI will not find this one`);
    return out;
  }
  if (!found.operation) {
    add('route', 'warn', `${loaded.source} lists ${found.template} but no ${input.method} operation on it`);
    return out;
  }
  add('route', 'pass', `${loaded.source} lists ${input.method} ${found.template}`);
  const op = `${input.method} ${found.template}`;
  const operation = found.operation;
  const problems: string[] = [];
  const notes: string[] = [];

  // The Radius convention: x-radius-free, x-radius-price, or a documented 402 response.
  const free = operation['x-radius-free'];
  const isFree = free === true || free === 'true';
  if (isFree) problems.push('it is marked x-radius-free, but the route answers 402 (the Radius Platform would list it as free)');
  const radiusPrice = operation['x-radius-price'];
  const responses = isRecord(operation.responses) ? operation.responses : {};
  let documentedPaid = false;
  if (radiusPrice !== undefined) {
    documentedPaid = true;
    const usd = typeof radiusPrice === 'number' && Number.isFinite(radiusPrice) && radiusPrice >= 0 ? String(radiusPrice) : typeof radiusPrice === 'string' ? radiusPrice.trim() : undefined;
    if (usd === undefined || !/^\d+(\.\d+)?$/.test(usd)) problems.push(`its x-radius-price ${JSON.stringify(radiusPrice)} is not a decimal USD string such as "0.001"`);
    else if (input.x402Offers.length === 0) notes.push(`x-radius-price ${usd} USD (not compared: the 402 has no x402 offer)`);
    else if (input.x402Offers.some((o) => matchesOffer({ usd: `$${usd}` }, o))) notes.push(`x-radius-price ${usd} USD matches the 402`);
    else problems.push(`its x-radius-price ${usd} USD matches no x402 offer in the 402`);
  } else if (Object.prototype.hasOwnProperty.call(responses, '402')) {
    documentedPaid = true;
    notes.push('documents a 402 response (priced at the project default price; add x-radius-price to state the price)');
  }

  // Fallback: x-payment-info is read when present, never required.
  const info = operation['x-payment-info'];
  if (info !== undefined) {
    const before = problems.length;
    if (!isRecord(info)) problems.push('its x-payment-info is not an object');
    else {
      documentedPaid = true;
      const protocols = declaredProtocols(info);
      if (protocols) {
        const listed = protocols.join(', ') || '(none)';
        if (input.x402Offers.length > 0 && !protocols.includes('x402')) problems.push(`its x-payment-info lists protocols ${listed}, but the 402 offers x402`);
        if (input.hasMpp && !protocols.includes('mpp')) problems.push(`its x-payment-info lists protocols ${listed}, but the 402 offers MPP`);
        if (protocols.includes('mpp') && !input.hasMpp) problems.push('its x-payment-info lists mpp, but the 402 has no MPP challenge');
        if (protocols.includes('x402') && input.x402Offers.length === 0) problems.push('its x-payment-info lists x402, but the 402 has no x402 offer');
      }
      const price = declaredPrice(info);
      if (price && input.x402Offers.length > 0) {
        const shown = 'usd' in price ? price.usd : `${price.atomic} atomic units${price.asset ? ` of ${price.asset}` : ''}`;
        if (!input.x402Offers.some((o) => matchesOffer(price, o))) problems.push(`its x-payment-info price ${shown} matches no x402 offer in the 402`);
      }
      if (problems.length === before) notes.push('x-payment-info agrees with the 402');
    }
  }

  if (!documentedPaid && !isFree) {
    problems.push('it has neither x-radius-price nor a documented 402 response, so OpenAPI readers such as the Radius Platform treat it as free (add "x-radius-price": "<USD per call>" or a 402 response)');
  } else if (!isFree && radiusPrice === undefined && !Object.prototype.hasOwnProperty.call(responses, '402') && problems.length === 0) {
    // Only x-payment-info: fine for tools that read it, but the Radius Platform does not.
    notes.push('the Radius Platform does not read x-payment-info; add x-radius-price or a 402 response for it');
  }
  if (problems.length) add('price', 'warn', `${op} disagrees with the 402: ${problems.join('; ')}`);
  else add('price', 'pass', `${op} is documented as paid: ${notes.join('; ')}`);
  return out;
}
