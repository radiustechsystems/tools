#!/usr/bin/env tsx
/**
 * generate-release-notes.ts
 *
 * Builds the release notes page and its Atom feed from four sources, newest first:
 *
 *   - release-notes/network.md: Radius Network notes, written by hand
 *   - packages/sdk/CHANGELOG.md and packages/cli/CHANGELOG.md: written by Changesets. A version is
 *     listed only once its `<package>@<version>` git tag exists (the release workflow pushes it after
 *     the npm publish), and dated by that tag
 *   - plugins/radius/CHANGELOG.md: the Radius skills, `## <version> (<YYYY-MM-DD>)` per version
 *
 * Output (both gitignored):
 *   - docs/pages/release-notes.mdx, one `## <date>: <product> <version>` section per release, so every
 *     release has a stable anchor to share. Its description names the latest release, for link
 *     previews and llms.txt.
 *   - public/release-notes.xml, an Atom feed with one entry per release.
 *
 * Usage:
 *   pnpm generate-release-notes (also run by prebuild, predev, docs:validate and docs:markdown-audit)
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dirname, '..');
const REPO_ROOT = join(PROJECT_ROOT, '..', '..');
const SITE_BASE_URL = process.env.SITE_BASE_URL ?? 'https://docs.radiustech.xyz';
const PAGE_URL = `${SITE_BASE_URL}/release-notes`;
const FEED_URL = `${SITE_BASE_URL}/release-notes.xml`;
const REPOSITORY = 'https://github.com/radiustechsystems/tools';

const PACKAGES = [
  { name: 'radius-sdk', changelog: 'packages/sdk/CHANGELOG.md' },
  { name: 'radius-cli', changelog: 'packages/cli/CHANGELOG.md' },
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChangeKind = 'breaking' | 'new' | 'fix';

export interface Change {
  kind: ChangeKind;
  /** Markdown, first line unindented, continuation lines as written (two-space indent). */
  text: string;
}

export interface Release {
  /** Display name: `Radius Network`, `radius-sdk 0.6.0`, `Radius skills 0.2.2`. */
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** Markdown under the heading. */
  body: string;
  /** One line per change, plain text, for the feed summary and the page description. */
  headlines: string[];
}

// ---------------------------------------------------------------------------
// Markdown helpers
// ---------------------------------------------------------------------------

/** The first sentence of a line, outside inline code, or undefined when it has no sentence end. */
export function firstSentence(line: string): string | undefined {
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '`') inCode = !inCode;
    if (inCode || !'.!?'.includes(char!)) continue;
    const next = line[i + 1];
    if (next !== undefined && next !== ' ') continue;
    // Abbreviations such as "e.g." and "i.e." do not end a sentence.
    if (/(?:^|\s)(?:e\.g|i\.e|vs|etc)$/i.test(line.slice(0, i))) continue;
    return line.slice(0, i + 1);
  }
  return undefined;
}

/** Bolds a change's first sentence (its headline), unless it already carries emphasis. */
export function emphasizeHeadline(text: string): string {
  const [first = '', ...rest] = text.split('\n');
  if (first.includes('**')) return text;
  const sentence = firstSentence(first);
  const bold = sentence ? `**${sentence}**${first.slice(sentence.length)}` : `**${first}**`;
  return [bold, ...rest].join('\n');
}

/** Plain text of a change's headline: no code ticks, emphasis or link targets. */
export function plainHeadline(text: string): string {
  const first = text.split('\n')[0] ?? '';
  return (firstSentence(first) ?? first)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim();
}

/** Escapes text that MDX would read as JSX or expressions, outside inline code and code fences. */
export function escapeMdx(markdown: string): string {
  let inFence = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((part) => (part.startsWith('`') ? part : part.replace(/[{}]/g, '\\$&').replace(/</g, '&lt;')))
        .join('');
    })
    .join('\n');
}

/** The heading anchor Vocs generates (GitHub slugger rules for ASCII text). */
export function anchor(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-');
}

function heading(release: Pick<Release, 'date' | 'title'>): string {
  return `${release.date}: ${release.title}`;
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Splits a document into `## ` sections: [heading text, body]. */
function sections(markdown: string): [string, string][] {
  const parts = markdown.split(/^## /m).slice(1);
  return parts.map((part) => {
    const newline = part.indexOf('\n');
    return [part.slice(0, newline).trim(), part.slice(newline + 1).trim()];
  });
}

/** Top-level list items of a block, with their indented continuation lines. */
function listItems(block: string): string[] {
  const items: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('- ')) items.push(line.slice(2));
    else if (items.length > 0) items[items.length - 1] += `\n${line}`;
  }
  return items.map((item) => item.replace(/\s+$/, ''));
}

/**
 * Headlines of a network release: each `####` heading (an API change) and the first sentence of
 * each top-level bullet outside them.
 */
function networkHeadlines(body: string): string[] {
  const headlines: string[] = [];
  let inApiChange = false;
  for (const line of body.split('\n')) {
    if (line.startsWith('#### ')) {
      inApiChange = true;
      headlines.push(plainHeadline(line.slice(5)));
    } else if (line.startsWith('### ')) {
      inApiChange = false;
    } else if (line.startsWith('- ') && !inApiChange) {
      headlines.push(plainHeadline(line.slice(2)));
    }
  }
  return headlines.filter(Boolean);
}

/** Network notes: `## <YYYY-MM-DD> (<build>)` sections, kept as written. */
export function parseNetwork(markdown: string): Release[] {
  return sections(markdown.replace(/<!--[\s\S]*?-->/g, '')).map(([title, body]) => {
    const match = title.match(/^(\d{4}-\d{2}-\d{2}) \(([0-9a-f]+)\)$/);
    if (!match) throw new Error(`release-notes/network.md: heading must be "## <YYYY-MM-DD> (<build>)": ${title}`);
    return {
      title: 'Radius Network',
      date: match[1]!,
      body: `Network build \`${match[2]}\`.\n\n${body}`,
      headlines: networkHeadlines(body),
    };
  });
}

const KIND_OF_SECTION: Record<string, ChangeKind> = {
  'Major Changes': 'breaking',
  'Minor Changes': 'new',
  'Patch Changes': 'fix',
};

const KIND_HEADING: Record<ChangeKind, string> = { breaking: 'Breaking changes', new: 'New', fix: 'Fixes' };

/** One version of a Changesets CHANGELOG.md: its changes and the workspace packages it updated. */
export function parseChangesetsVersion(body: string): { changes: Change[]; dependencies: string[] } {
  const changes: Change[] = [];
  const dependencies: string[] = [];
  for (const [title, block] of body
    .split(/^### /m)
    .slice(1)
    .map((part) => {
      const newline = part.indexOf('\n');
      return [part.slice(0, newline).trim(), part.slice(newline + 1)] as const;
    })) {
    const kind = KIND_OF_SECTION[title];
    if (!kind) throw new Error(`unknown changelog section: ${title}`);
    for (const item of listItems(block)) {
      if (item.startsWith('Updated dependencies')) {
        dependencies.push(...[...item.matchAll(/^\s+- (\S+@\S+)$/gm)].map((match) => match[1]!));
        continue;
      }
      // "<commit>: <text>"; continuation lines are indented two spaces under the item.
      const text = item.replace(/^[0-9a-f]{7,40}: /, '');
      // A minor change that says it breaks something (`**Breaking:**`, `**Breaking for installs:**`) is
      // listed with the breaking changes.
      changes.push({ kind: kind === 'new' && /\*\*Breaking\b[^*]*\*\*/.test(text) ? 'breaking' : kind, text });
    }
  }
  return { changes, dependencies };
}

function changeList(changes: Change[]): string {
  return changes.map((change) => `- ${escapeMdx(emphasizeHeadline(change.text))}`).join('\n');
}

/** Changesets CHANGELOG.md versions that have a release tag. */
export function parsePackage(name: string, markdown: string, tagDates: Map<string, string>): Release[] {
  const releases: Release[] = [];
  for (const [version, body] of sections(markdown)) {
    const tag = `${name}@${version}`;
    const date = tagDates.get(tag);
    if (!date) continue; // Not published yet (the Version Packages PR), or tags not fetched.
    const { changes, dependencies } = parseChangesetsVersion(body);
    const blocks = [
      `[npm](https://www.npmjs.com/package/${name}/v/${version}) · [GitHub release](${REPOSITORY}/releases/tag/${encodeURIComponent(tag)})`,
    ];
    for (const kind of ['breaking', 'new', 'fix'] as const) {
      const ofKind = changes.filter((change) => change.kind === kind);
      if (ofKind.length > 0) blocks.push(`### ${KIND_HEADING[kind]}\n\n${changeList(ofKind)}`);
    }
    if (dependencies.length > 0) blocks.push(`Uses ${dependencies.map((dep) => `\`${dep}\``).join(', ')}.`);
    releases.push({
      title: `${name} ${version}`,
      date,
      body: blocks.join('\n\n'),
      headlines:
        changes.length > 0 ? changes.map((change) => plainHeadline(change.text)) : [`Uses ${dependencies.join(', ')}.`],
    });
  }
  return releases;
}

/** plugins/radius/CHANGELOG.md: `## <version> (<YYYY-MM-DD>)` sections of bullets. */
export function parseSkills(markdown: string): Release[] {
  return sections(markdown).map(([title, body]) => {
    const match = title.match(/^(\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)$/);
    if (!match) throw new Error(`plugins/radius/CHANGELOG.md: heading must be "## <version> (<YYYY-MM-DD>)": ${title}`);
    const items = listItems(body);
    return {
      title: `Radius skills ${match[1]}`,
      date: match[2]!,
      body: [
        '`claude plugin update radius@tools` · [Install the skills](/build/coding-assistants)',
        items.map((item) => `- ${escapeMdx(emphasizeHeadline(item))}`).join('\n'),
      ].join('\n\n'),
      headlines: items.map(plainHeadline),
    };
  });
}

/** Newest first; on the same day, the network, then the SDK, the CLI and the skills. */
export function sortReleases(releases: Release[]): Release[] {
  const rank = (release: Release) =>
    ['Radius Network', 'radius-sdk', 'radius-cli', 'Radius skills'].findIndex((prefix) =>
      release.title.startsWith(prefix),
    );
  return [...releases].sort((a, b) => b.date.localeCompare(a.date) || rank(a) - rank(b));
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const PRODUCTS = ['Radius Network', 'radius-sdk', 'radius-cli', 'Radius skills'] as const;

/** Meta description: the latest release and its first change, within 160 characters. */
export function describe(releases: Release[]): string {
  const latest = releases[0];
  if (!latest) return 'Radius release notes: the network, radius-sdk, radius-cli and the Radius skills.';
  const description = `Latest: ${latest.title} (${latest.date}). ${latest.headlines[0] ?? ''}`.trim();
  if (description.length <= 160) return description;
  return `${description.slice(0, 157).replace(/\s+\S*$/, '')}...`;
}

export function renderPage(releases: Release[]): string {
  const latestRows = PRODUCTS.map((product) => {
    const release = releases.find((candidate) => candidate.title.startsWith(product));
    if (!release) return undefined;
    // The network has builds, not versions.
    const version = release.title.slice(product.length).trim() || `build ${release.body.match(/`([0-9a-f]+)`/)?.[1]}`;
    return `| ${product} | [${version}](#${anchor(heading(release))}) | ${release.date} |`;
  }).filter(Boolean);

  return [
    '---',
    'title: Release notes',
    `description: ${JSON.stringify(describe(releases))}`,
    '---',
    '',
    '{/* Generated by scripts/generate-release-notes.ts. Edit release-notes/network.md or a changelog instead. */}',
    '',
    '# Release notes [What changed in the Radius Network, radius-sdk, radius-cli and the Radius skills]',
    '',
    'Every release, newest first. Each heading is a link you can share. Follow new releases with the',
    `[Atom feed](${FEED_URL}), or read this page as [Markdown](${SITE_BASE_URL}/release-notes.md).`,
    '',
    '| Product | Latest | Released |',
    '| --- | --- | --- |',
    ...latestRows,
    '',
    ...releases.flatMap((release) => [`## ${heading(release)}`, '', release.body, '']),
  ].join('\n');
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderFeed(releases: Release[]): string {
  const updated = `${releases[0]?.date ?? '1970-01-01'}T00:00:00Z`;
  const entries = releases.map((release) => {
    const link = `${PAGE_URL}#${anchor(heading(release))}`;
    const id = `tag:${new URL(SITE_BASE_URL).host},${release.date}:${release.title.replace(/ /g, '-')}`;
    return [
      '  <entry>',
      `    <title>${escapeXml(release.title)}</title>`,
      `    <link href="${escapeXml(link)}"/>`,
      `    <id>${escapeXml(id)}</id>`,
      `    <updated>${release.date}T00:00:00Z</updated>`,
      `    <summary>${escapeXml(release.headlines.join('\n'))}</summary>`,
      `    <content type="text">${escapeXml(release.body.replace(/\]\(\//g, `](${SITE_BASE_URL}/`))}</content>`,
      '  </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>Radius release notes</title>',
    '  <subtitle>The Radius Network, radius-sdk, radius-cli and the Radius skills.</subtitle>',
    `  <link href="${FEED_URL}" rel="self" type="application/atom+xml"/>`,
    `  <link href="${PAGE_URL}" rel="alternate" type="text/html"/>`,
    `  <id>${PAGE_URL}</id>`,
    `  <updated>${updated}</updated>`,
    '  <author><name>Radius</name></author>',
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** `<package>@<version>` tag -> YYYY-MM-DD it was created. */
function readTagDates(): Map<string, string> {
  const output = execFileSync(
    'git',
    ['for-each-ref', '--format=%(refname:short) %(creatordate:short)', 'refs/tags/radius-*'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  return new Map(
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(' ') as [string, string]),
  );
}

export function collectReleases(read: (path: string) => string, tagDates: Map<string, string>): Release[] {
  const releases = [
    ...parseNetwork(read('packages/docs/release-notes/network.md')),
    ...PACKAGES.flatMap((pkg) => {
      const markdown = read(pkg.changelog);
      const listed = parsePackage(pkg.name, markdown, tagDates);
      if (listed.length === 0 && sections(markdown).length > 0) {
        throw new Error(
          `no ${pkg.name}@<version> git tags found: fetch tags (actions/checkout fetch-tags: true) so released versions are listed`,
        );
      }
      return listed;
    }),
    ...parseSkills(read('plugins/radius/CHANGELOG.md')),
  ];
  return sortReleases(releases);
}

function main() {
  const releases = collectReleases((path) => readFileSync(join(REPO_ROOT, path), 'utf8'), readTagDates());
  const page = join(PROJECT_ROOT, 'docs/pages/release-notes.mdx');
  const feed = join(PROJECT_ROOT, 'public/release-notes.xml');
  mkdirSync(dirname(feed), { recursive: true });
  writeFileSync(page, renderPage(releases));
  writeFileSync(feed, renderFeed(releases));
  console.log(`  ✓  ${releases.length} releases → docs/pages/release-notes.mdx, public/release-notes.xml`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
