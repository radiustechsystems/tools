/**
 * `sell check --pricing`: run `checkSeller` on every paid route a pricing.md lists, each against
 * its own catalog price, and total the results.
 */
import { checkSeller, type CheckStatus, type SellCheckOptions, type SellCheckReport } from './sellCheck.js';
import { fillPath, joinUrl, type PricingRoute } from './pricingMd.js';
import { isSupportedVerb } from './http.js';

export interface RouteResult {
  catalog: string;
  name: string;
  method: string;
  path: string;
  price?: string;
  free?: string;
  /** The URL checked; absent when the route was skipped. */
  url?: string;
  /** Why the route was not checked. */
  skipped?: string;
  report?: SellCheckReport;
}

export interface RoutesReport {
  source: string;
  /** True when at least one route was checked and none failed. */
  ok: boolean;
  routes: RouteResult[];
  summary: { routes: { checked: number; passed: number; failed: number; skipped: number }; checks: Record<CheckStatus, number> };
}

export type RouteCheckOptions = Omit<SellCheckOptions, 'url' | 'method' | 'price' | 'pay'>;

/**
 * Check each route in turn (in file order, so shared free quotas are used up predictably). A route
 * listing several methods is checked once per method; `ANY` is checked with GET. `baseUrl`
 * overrides every catalog's Base URL.
 */
export async function checkRoutes(
  source: string,
  routes: PricingRoute[],
  params: Record<string, string>,
  baseUrl: string | undefined,
  options: RouteCheckOptions,
  onResult?: (r: RouteResult) => void,
): Promise<RoutesReport> {
  const results: RouteResult[] = [];
  const checks: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0, info: 0 };
  for (const route of routes) {
    for (const listed of route.methods) {
      const method = listed === 'ANY' ? 'GET' : listed;
      const result: RouteResult = { catalog: route.catalog, name: route.name, method, path: route.path, price: route.price, free: route.free };
      results.push(result);
      const base = baseUrl ?? route.baseUrl;
      const filled = fillPath(route.path, params);
      if (!isSupportedVerb(method)) result.skipped = `method ${method} is not one sell check sends`;
      else if (!base) result.skipped = `catalog "${route.catalog}" has no Base URL; pass --base-url <url>`;
      else if ('missing' in filled) result.skipped = `no value for ${filled.missing.map((p) => (p === '*' ? '*' : `:${p}`)).join(', ')}; pass ${filled.missing.map((p) => `--param '${p}=…'`).join(' ')}`;
      else if (!route.price) result.skipped = 'no price on the Price line';
      else {
        result.url = joinUrl(base, filled.path);
        result.report = await checkSeller({ ...options, url: result.url, method, price: route.price });
        for (const c of result.report.checks) checks[c.status]++;
      }
      onResult?.(result);
    }
  }
  const checked = results.filter((r) => r.report);
  const failed = checked.filter((r) => !r.report!.ok).length;
  return {
    source,
    ok: checked.length > 0 && failed === 0,
    routes: results,
    summary: { routes: { checked: checked.length, passed: checked.length - failed, failed, skipped: results.length - checked.length }, checks },
  };
}
