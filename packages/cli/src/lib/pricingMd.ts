/**
 * Reading a Radius Platform pricing.md: the per-organization file that lists each catalog's paid
 * routes for agents. The shape `sell check --pricing` relies on:
 *
 *   ## <catalog>
 *   - Base URL: https://api.example.com        (the platform renders "[Base URL]" until it knows one)
 *   ### <route name>
 *   - Request: `GET /wallet/:address`           (or `GET, POST /tx/:hash`, `ANY /price/*`)
 *   - Price: $0.001 / request
 *   - Free: 10 requests per minute per IP       (optional)
 *
 * Other lines are ignored. Names are Markdown-escaped by the platform and unescaped here.
 */

export interface PricingRoute {
  catalog: string;
  name: string;
  /** Upper-case methods as listed; `ANY` stays `ANY`. */
  methods: string[];
  /** Path template, e.g. `/wallet/:address`. */
  path: string;
  /** USD price per request, e.g. `$0.001` (thousands separators removed). */
  price?: string;
  /** The `Free:` line as written, e.g. `10 requests per minute per IP`. */
  free?: string;
  /** The catalog's base URL, when it names a real one (not the `[Base URL]` placeholder). */
  baseUrl?: string;
}

/** `\*Weather\* &amp; co` as `*Weather* & co`: undo the platform's escaping of seller text. */
function unescape(text: string): string {
  return text
    .replace(/\\(.)/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/** The text of an inline code span (any fence length), or undefined. */
function codeSpan(value: string): string | undefined {
  const m = /^(`+)(.*?)\1$/.exec(value.trim());
  if (!m) return undefined;
  const inner = m[2]!;
  return inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() ? inner.slice(1, -1) : inner;
}

/** Every route in a pricing.md, in file order. Throws when the file lists none. */
export function parsePricingMd(text: string): PricingRoute[] {
  const routes: PricingRoute[] = [];
  let catalog: string | undefined;
  let baseUrl: string | undefined;
  let route: PricingRoute | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m: RegExpExecArray | null;
    if ((m = /^## (?!#)(.*)$/.exec(line))) {
      catalog = unescape(m[1]!);
      baseUrl = undefined;
      route = undefined;
    } else if ((m = /^### (?!#)(.*)$/.exec(line))) {
      route = undefined;
      if (catalog === undefined) continue;
      route = { catalog, name: unescape(m[1]!), methods: [], path: '', baseUrl };
      routes.push(route);
    } else if ((m = /^- ([A-Za-z ]+): (.*)$/.exec(line))) {
      const [, label, value] = m as unknown as [string, string, string];
      if (!route) {
        if (catalog !== undefined && label === 'Base URL') {
          const v = value.trim();
          baseUrl = /^https?:\/\//i.test(v) ? v : undefined;
        }
        continue;
      }
      if (label === 'Request') {
        const request = codeSpan(value);
        const rm = request ? /^([A-Za-z, ]+?)\s+(\S+)$/.exec(request.trim()) : null;
        if (rm) {
          route.methods = rm[1]!.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
          route.path = rm[2]!;
        }
      } else if (label === 'Price') {
        const pm = /^\$([\d,]+(?:\.\d+)?)\s*\/\s*request$/i.exec(unescape(value));
        if (pm) route.price = `$${pm[1]!.replace(/,/g, '')}`;
      } else if (label === 'Free') {
        route.free = unescape(value);
      }
    }
  }
  const complete = routes.filter((r) => r.path && r.methods.length);
  if (complete.length === 0) throw new Error('no routes found (expected "### <name>" sections with "- Request: `GET /path`" lines under "## <catalog>")');
  return complete;
}

const PARAM = /:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\}|\*/g;

/** The parameters a path template needs: `:name` / `{name}` segments, and `*` for a wildcard. */
export function pathParams(path: string): string[] {
  return [...new Set([...path.matchAll(PARAM)].map((m) => m[1] ?? m[2] ?? '*'))];
}

/** `path` with each parameter filled from `params` (values URL-encoded, except `*`), or the names that have no value. */
export function fillPath(path: string, params: Record<string, string>): { path: string } | { missing: string[] } {
  const missing = pathParams(path).filter((p) => params[p] === undefined);
  if (missing.length) return { missing };
  return {
    path: path.replace(PARAM, (_all, colon?: string, brace?: string) => {
      const name = colon ?? brace;
      return name === undefined ? params['*']! : encodeURIComponent(params[name]!);
    }),
  };
}

/** `base` + `path`, keeping any path prefix on the base (`https://h/api` + `/tx/1` is `https://h/api/tx/1`). */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}
