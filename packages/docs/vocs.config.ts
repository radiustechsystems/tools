import { defineConfig, type Config } from 'vocs/config';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import remarkGfm from 'remark-gfm';
import { remarkLlmOutput } from './docs/remark-llm-output.js';
import { rehypePageActions } from './docs/rehype-page-actions.js';
import { AREAS as AREA_LIST } from './docs/areas.js';

const SITE_BASE_URL = 'https://docs.radiustech.xyz';
const PROJECT_ROOT = findProjectRoot();
const DOCS_PAGES_DIR = join(PROJECT_ROOT, 'docs', 'pages');
const SITE_NAME = 'Radius Documentation';
const SITE_DESCRIPTION =
  'Developer documentation for the Radius Network - Stablecoin-native EVM with sub-second finality.';

type SidebarItem = {
  collapsed?: boolean;
  text: string;
  link?: string;
  items?: SidebarItem[];
};

type PageMetadata = {
  description?: string;
  title?: string;
};

type Breadcrumb = {
  name: string;
  url?: string;
};

// Three areas, each with its own sidebar. Vocs picks the sidebar whose key is the
// longest prefix of the page path, so `/` (Discover) covers everything outside
// `/build` and `/reference`. The top nav links the three areas.
const DISCOVER_SIDEBAR: SidebarItem[] = [
  { text: 'Overview', link: '/' },
  { text: 'Why Radius', link: '/why-radius' },
  { text: 'Try Radius', link: '/try' },
  {
    text: 'Architecture',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/architecture' },
      { text: 'Parallel execution', link: '/architecture/parallel-execution' },
      { text: 'Execution and compatibility', link: '/architecture/execution-and-compatibility' },
    ],
  },
  {
    text: 'Solutions',
    collapsed: false,
    items: [
      { text: 'CDNs and edge platforms', link: '/solutions/cdns' },
      { text: 'Payment providers', link: '/solutions/payment-providers' },
      { text: 'Data providers', link: '/solutions/data-providers' },
      { text: 'Web publishers', link: '/solutions/publishers' },
    ],
  },
  { text: 'Release notes', link: '/release-notes' },
];

const BUILD_SIDEBAR: SidebarItem[] = [
  { text: 'Overview', link: '/build' },
  {
    text: 'Payments',
    collapsed: false,
    items: [
      { text: 'Accept payments', link: '/build/accept-payments' },
      { text: 'Make payments', link: '/build/make-payments' },
      { text: 'Set up an agent to pay', link: '/build/make-payments/agents' },
      { text: 'x402 payments', link: '/build/x402' },
    ],
  },
  {
    text: 'Tutorials',
    collapsed: false,
    items: [
      { text: 'Sell a data lookup', link: '/build/tutorials/sell-data' },
      { text: 'Buy a data lookup', link: '/build/tutorials/buy-data' },
    ],
  },
  {
    text: 'Wallets and funds',
    collapsed: false,
    items: [
      { text: 'Create and fund a wallet', link: '/build/wallet' },
      { text: 'Claim and transact', link: '/build/claim-and-transact' },
      { text: 'Bridge stablecoins', link: '/build/bridge' },
      { text: 'Dashboard', link: '/build/dashboard' },
    ],
  },
  {
    text: 'Developer tools',
    collapsed: false,
    items: [
      { text: 'Coding assistants', link: '/build/coding-assistants' },
      { text: 'Tooling configuration', link: '/build/tooling' },
    ],
  },
  {
    text: 'Examples',
    collapsed: false,
    items: [
      { text: 'Example projects', link: '/build/examples/workshop-playground' },
      { text: 'Agent payments', link: '/build/examples/agent-payments' },
      { text: 'API metering', link: '/build/examples/real-time-api-metering' },
      { text: 'Content access', link: '/build/examples/pay-per-visit-content' },
      { text: 'Streaming payments', link: '/build/examples/streaming-payments' },
    ],
  },
];

const REFERENCE_SIDEBAR: SidebarItem[] = [
  { text: 'Overview', link: '/reference' },
  {
    text: 'Payments',
    collapsed: false,
    items: [
      { text: 'radius-sdk', link: '/reference/radius-sdk' },
      { text: 'radius-cli', link: '/reference/radius-cli' },
      { text: 'x402 facilitator API', link: '/reference/facilitator-api' },
    ],
  },
  {
    text: 'Network',
    collapsed: false,
    items: [
      { text: 'Network and RPC', link: '/reference/network' },
      { text: 'Fees', link: '/reference/fees' },
      { text: 'Contract addresses', link: '/reference/contract-addresses' },
      { text: 'Ethereum compatibility', link: '/reference/ethereum-compatibility' },
    ],
  },
  {
    text: 'JSON-RPC',
    collapsed: false,
    items: [
      { text: 'Overview', link: '/reference/json-rpc' },
      { text: 'Methods', link: '/reference/json-rpc/methods' },
    ],
  },
];

/** Areas (docs/areas.ts) with their sidebars. `link` is both the area's landing page and its sidebar key. */
const AREA_SIDEBARS: Record<(typeof AREA_LIST)[number]['link'], SidebarItem[]> = {
  '/': DISCOVER_SIDEBAR,
  '/build': BUILD_SIDEBAR,
  '/reference': REFERENCE_SIDEBAR,
};
const AREAS = AREA_LIST.map((area) => ({ ...area, sidebar: AREA_SIDEBARS[area.link] }));

const PAGE_METADATA_BY_PATH = buildPageMetadataIndex();

function findProjectRoot(): string {
  const startDirs = [process.env.INIT_CWD, process.env.PWD, process.cwd()].filter((dir): dir is string => Boolean(dir));

  for (const startDir of startDirs) {
    let currentDir = resolve(startDir);

    while (true) {
      const docsPagesDir = join(currentDir, 'docs', 'pages');
      const configPath = join(currentDir, 'vocs.config.ts');

      if (existsSync(docsPagesDir) && existsSync(configPath)) {
        return currentDir;
      }

      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  }

  throw new Error('Unable to locate project root containing docs/pages and vocs.config.ts.');
}

function normalizeCanonicalPath(path: string): string | null {
  const withoutHash = path.split('#')[0] || '/';
  const withoutQuery = withoutHash.split('?')[0] || '/';

  if (!withoutQuery.startsWith('/')) {
    return null;
  }

  // Canonicals only apply to HTML docs pages, not assets or alternate text exports.
  if (/\.[a-z0-9]+$/i.test(withoutQuery) && !withoutQuery.endsWith('.html')) {
    return null;
  }

  let normalized = withoutQuery;

  if (normalized === '/index.html') normalized = '/';
  else if (normalized.endsWith('/index.html')) normalized = normalized.slice(0, -'index.html'.length);
  else if (normalized.endsWith('.html')) normalized = normalized.slice(0, -'.html'.length);

  if (normalized !== '/' && !normalized.endsWith('/')) {
    normalized = `${normalized}/`;
  }

  return normalized;
}

function parseFrontmatter(source: string): PageMetadata {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const yaml = match[1];
  return {
    title: extractYamlValue(yaml, 'title') || undefined,
    description: extractYamlValue(yaml, 'description') || undefined,
  };
}

function extractYamlValue(yaml: string, key: string): string {
  const match = yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  return match?.[1]?.trim() || '';
}

function collectMdxFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      collectMdxFiles(fullPath, files);
      continue;
    }

    if (extname(entry) === '.mdx' || extname(entry) === '.md') {
      files.push(fullPath);
    }
  }

  return files;
}

function filePathToUrlPath(filePath: string): string {
  let urlPath =
    '/' +
    relative(DOCS_PAGES_DIR, filePath)
      .replace(/\\/g, '/')
      .replace(/\.mdx?$/, '')
      .replace(/\/index$/, '')
      .replace(/^index$/, '');

  if (urlPath === '') {
    urlPath = '/';
  }

  return normalizeCanonicalPath(urlPath) ?? '/';
}

function buildPageMetadataIndex(): Map<string, PageMetadata> {
  const metadataByPath = new Map<string, PageMetadata>();

  for (const filePath of collectMdxFiles(DOCS_PAGES_DIR)) {
    const source = readFileSync(filePath, 'utf-8');
    metadataByPath.set(filePathToUrlPath(filePath), parseFrontmatter(source));
  }

  return metadataByPath;
}

function findSidebarBreadcrumbs(
  items: SidebarItem[],
  targetPath: string,
  trail: Breadcrumb[] = [],
): Breadcrumb[] | null {
  for (const item of items) {
    const itemPath = item.link ? normalizeCanonicalPath(item.link) : null;
    // An area's "Overview" is the area crumb itself.
    const nextTrail =
      item.text === 'Overview' && trail.length === 1
        ? trail
        : [...trail, { name: item.text, ...(itemPath ? { url: `${SITE_BASE_URL}${itemPath}` } : {}) }];

    if (itemPath === targetPath) {
      return nextTrail;
    }

    if (item.items) {
      const result = findSidebarBreadcrumbs(item.items, targetPath, nextTrail);
      if (result) return result;
    }
  }

  return null;
}

function getBreadcrumbs(path: string): Breadcrumb[] | null {
  const canonicalPath = normalizeCanonicalPath(path);

  if (!canonicalPath || canonicalPath === '/') {
    return null;
  }

  const home = { name: 'Home', url: SITE_BASE_URL };
  for (const area of AREAS) {
    const areaPath = normalizeCanonicalPath(area.link);
    const areaCrumb = { name: area.text, url: `${SITE_BASE_URL}${areaPath === '/' ? '' : areaPath}` };
    const trail = findSidebarBreadcrumbs(area.sidebar, canonicalPath, [areaCrumb]);
    if (trail) return areaPath === '/' ? [home, ...trail.slice(1)] : [home, ...trail];
  }

  const pageTitle = PAGE_METADATA_BY_PATH.get(canonicalPath)?.title;
  return [home, { name: pageTitle ?? canonicalPath.replace(/^\/|\/$/g, '') }];
}

// ---------------------------------------------------------------------------
// head() / ogImageUrl
//
// Vocs serializes config functions with `Function.prototype.toString()` and
// re-creates them inside the page bundle, so they must not close over module
// scope. `headImpl` is therefore a pure function that receives everything it
// needs as `data`, and `head` is assembled with `new Function` so the
// precomputed per-page data travels with the function body.
// ---------------------------------------------------------------------------

type HeadContext = { frontmatter?: PageMetadata | undefined };
type HeadResult = Extract<ReturnType<Extract<Config<true>['head'], (...args: never[]) => unknown>>, object>;
type HeadFn = (path: string, context: HeadContext) => HeadResult;

type HeadData = {
  siteUrl: string;
  siteName: string;
  siteDescription: string;
  /** Canonical path → breadcrumb trail (Home first). */
  breadcrumbs: Record<string, Breadcrumb[]>;
};

function headImpl(path: string, context: HeadContext, data: HeadData): HeadResult {
  const withoutQuery = (path.split('#')[0] || '/').split('?')[0] || '/';
  let normalized = withoutQuery;
  if (normalized === '/index.html') normalized = '/';
  else if (normalized.endsWith('/index.html')) normalized = normalized.slice(0, -'index.html'.length);
  else if (normalized.endsWith('.html')) normalized = normalized.slice(0, -'.html'.length);
  if (normalized !== '/' && !normalized.endsWith('/')) normalized = `${normalized}/`;

  const canonical = `${data.siteUrl}${normalized}`;
  const base = {
    // Vocs emits <base href={baseUrl}> by default, which would make every relative asset load from
    // production even on previews and the GitHub Pages mirror.
    base: false as const,
    canonical,
    meta: { ogSiteName: data.siteName, ogLocale: 'en_US' },
    ...(normalized === '/404/' ? { title: `Page Not Found | ${data.siteName}` } : {}),
  };

  // Vocs renders <Head> twice per page: once in the document root (no page
  // frontmatter) and once inside the page layout (with frontmatter). Emit the
  // structured data only in the latter so each JSON-LD block appears once.
  if (!context.frontmatter) return base;

  const publisher = { '@type': 'Organization', name: 'Radius', url: 'https://radiustech.xyz' };
  const website = { '@type': 'WebSite', name: data.siteName, url: data.siteUrl };
  const title = context.frontmatter?.title;
  const description = context.frontmatter?.description ?? data.siteDescription;
  const jsonLd: Record<string, unknown>[] = [];

  if (normalized === '/') {
    jsonLd.push({
      '@context': 'https://schema.org',
      ...website,
      description,
      publisher,
      inLanguage: 'en-US',
    });
  } else if (title) {
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'TechArticle',
      headline: title,
      description,
      url: canonical,
      mainEntityOfPage: canonical,
      isPartOf: website,
      about: { '@type': 'Thing', name: 'Radius Network developer documentation' },
      author: { '@type': 'Organization', name: 'Radius' },
      publisher,
      audience: { '@type': 'Audience', audienceType: 'Developers' },
      inLanguage: 'en-US',
    });
  }

  const breadcrumbs = data.breadcrumbs[normalized];
  if (breadcrumbs && breadcrumbs.length > 0) {
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: breadcrumbs.map((crumb, index) => ({
        '@type': 'ListItem',
        position: index + 1,
        item: crumb.url ? { '@id': crumb.url, name: crumb.name } : { '@type': 'Thing', name: crumb.name },
      })),
    });
  }

  return {
    ...base,
    // Feed autodiscovery on every page: readers and agents find release notes from any docs URL.
    link: [
      {
        rel: 'alternate',
        type: 'application/atom+xml',
        title: 'Radius release notes',
        href: `${data.siteUrl}/release-notes.xml`,
      },
    ],
    script: jsonLd.map((entry) => ({
      type: 'application/ld+json',
      innerHTML: JSON.stringify(entry).replace(/</g, '\\u003c'),
    })),
  };
}

function buildHeadData(): HeadData {
  const breadcrumbs: Record<string, Breadcrumb[]> = {};
  for (const canonicalPath of PAGE_METADATA_BY_PATH.keys()) {
    const trail = getBreadcrumbs(canonicalPath);
    if (trail) breadcrumbs[canonicalPath] = trail;
  }
  return { siteUrl: SITE_BASE_URL, siteName: SITE_NAME, siteDescription: SITE_DESCRIPTION, breadcrumbs };
}

const head = new Function(
  'path',
  'context',
  `return (${headImpl.toString()})(path, context, ${JSON.stringify(buildHeadData())});`,
) as HeadFn;

export default defineConfig({
  // Production is served at the domain root. Set VOCS_BASE_PATH to serve a build under a sub-path.
  ...(process.env.VOCS_BASE_PATH ? { basePath: process.env.VOCS_BASE_PATH } : {}),
  baseUrl: SITE_BASE_URL,
  // The site is hosted statically (Workers static assets). full-static emits plain
  // HTML plus the generated Markdown twins, llms.txt and llms-full.txt; server-only features
  // (MCP, AI search, feedback, /api/og) are not available.
  renderStrategy: 'full-static',
  // Pages live in docs/pages (Vocs default is src/pages)
  srcDir: 'docs',
  // Warn about dead links instead of failing build (generated .md/.txt targets are not routes)
  checkDeadlinks: 'warn',
  title: SITE_NAME,
  description: SITE_DESCRIPTION,
  logoUrl: {
    light: '/logo-light.svg',
    dark: '/logo-dark.svg',
  },
  iconUrl: 'https://cdn.prod.website-files.com/6645121d0a02e83f84cfc6c7/685964b50e9953c9ed771b49_favicon.png',
  topNav: [
    ...AREAS.map(({ text, link }) => ({ text, link })),
    { text: 'Agent Skill', link: 'https://docs.radiustech.xyz/skills.md' },
    { text: 'Radius Network', link: 'https://network.radiustech.xyz' },
    { text: 'Testnet', link: 'https://testnet.radiustech.xyz' },
    { text: 'Contact Us', link: 'https://www.radiustech.xyz/contact' },
  ],
  // One shared card. Per-page cards (`/api/og`) need a server, which a static build lacks.
  ogImageUrl: 'https://docs.radiustech.xyz/og/radius-docs.png',
  sidebar: Object.fromEntries(AREAS.map(({ link, sidebar }) => [link, sidebar])),
  // Structured data is emitted by head() below (WebSite + TechArticle + BreadcrumbList),
  // so the built-in TechArticle-only JSON-LD is disabled to avoid duplicates.
  jsonLd: false,
  head,
  // Generated Markdown (page .md twins, llms-full.txt) gets GFM tables/footnotes plus the
  // Radius-specific transforms (constants, TransactionCost, callouts, subtitles).
  markdown: {
    rehypePlugins: [rehypePageActions],
    outputRemarkPlugins: [remarkGfm, remarkLlmOutput],
  },
  // Brand accent (Prosperous Red). All other theme tokens live in docs/pages/_root.css.
  accentColor: '#EB6359',
  socials: [
    {
      icon: 'github',
      link: 'https://github.com/radiustechsystems',
    },
    {
      icon: 'discord',
      link: 'https://discord.radiustech.xyz',
    },
    {
      icon: 'x',
      link: 'https://x.com/radiustech_xyz',
    },
  ],
});
