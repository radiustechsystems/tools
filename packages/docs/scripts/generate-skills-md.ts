#!/usr/bin/env tsx
/**
 * generate-skills-md.ts
 *
 * Reads every .md file from each skill of the Claude Code plugins in this repo and concatenates
 * them into a single <skill-name>.md per skill, aligned with the AgentSkills.io specification
 * (https://agentskills.io/specification):
 *
 *   - YAML frontmatter: name and description from the skill's SKILL.md, license, and
 *     metadata (plugin version, homepage, repository)
 *   - Table of contents
 *   - Full concatenated skill content with heading bumps and link rewriting
 *
 * Source: the repo root's .claude-plugin/marketplace.json lists the plugins; each plugin's
 * `source` directory holds .claude-plugin/plugin.json and skills/<skill-name>/.
 *
 * Output lands in public/skills/<skill-name>.md so Vite serves
 * each as a static asset in dev and copies them to dist/public/ at build time.
 *
 * It also writes the Agent Skills Discovery index (v0.2.0,
 * https://github.com/cloudflare/agent-skills-discovery-rfc) to public/.well-known/agent-skills/index.json,
 * with a copy of each skill beside it at public/.well-known/agent-skills/<name>/ (SKILL.md at the RFC's
 * conventional location, plus the references and scripts it links to; evaluations stay out). Each
 * `skill-md` entry points at that SKILL.md and carries the SHA-256 of its bytes, so a published index and
 * the files it describes always come from the same build.
 *
 * Usage:
 *   npx tsx scripts/generate-skills-md.ts
 *
 * Adding a new skill: add plugins/<plugin>/skills/<skill-name>/SKILL.md and rebuild; no code changes required.
 *
 * Spec reference:
 *   Required frontmatter: name, description
 *   Optional frontmatter: license, compatibility, metadata, allowed-tools
 *   Body: no format restrictions — write whatever helps agents perform the task
 *   Progressive disclosure: metadata (~100 tokens) → instructions (<5000 tokens) → resources (as needed)
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve, basename } from 'node:path';
import { parse } from 'yaml';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname));
const REPO_ROOT = join(PROJECT_ROOT, '..');

/** Root of the monorepo, which holds the Claude Code plugins and their skills. */
const SKILLS_SOURCE_DIR = join(REPO_ROOT, '..', '..');

/** Marketplace manifest listing all plugins */
const MARKETPLACE_JSON_PATH = join(SKILLS_SOURCE_DIR, '.claude-plugin', 'marketplace.json');

const PUBLIC_DIR = join(REPO_ROOT, 'public');

/** Output base: each skill writes to SKILLS_OUTPUT_BASE/<skill-name>.md */
const SKILLS_OUTPUT_BASE = join(PUBLIC_DIR, 'skills');

/** Canonical GitHub URL for the repo holding the skills */
const SKILLS_REPO_URL = 'https://github.com/radiustechsystems/tools';

/** Agent Skills Discovery directory, served at /.well-known/agent-skills/ (the index and a SKILL.md per skill). */
const AGENT_SKILLS_URL_PATH = '/.well-known/agent-skills';
const AGENT_SKILLS_DIR = join(PUBLIC_DIR, ...AGENT_SKILLS_URL_PATH.split('/').filter(Boolean));
const AGENT_SKILLS_INDEX_PATH = join(AGENT_SKILLS_DIR, 'index.json');

/** Schema URI of the Agent Skills Discovery index format (RFC v0.2.0). */
const AGENT_SKILLS_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';

// ---------------------------------------------------------------------------
// Marketplace manifest (read from .claude-plugin/marketplace.json)
// ---------------------------------------------------------------------------

interface MarketplacePlugin {
  name: string;
  version: string;
  description: string;
  license?: string;
  homepage?: string;
  repository?: string;
  author?: { name: string };
  source?: string;
}

interface MarketplaceManifest {
  name?: string;
  owner?: { name: string };
  metadata?: { version?: string; description?: string };
  plugins: MarketplacePlugin[];
}

function readMarketplaceManifest(): MarketplaceManifest {
  if (!existsSync(MARKETPLACE_JSON_PATH)) {
    throw new Error(`Required marketplace manifest not found: ${MARKETPLACE_JSON_PATH}`);
  }
  return JSON.parse(readFileSync(MARKETPLACE_JSON_PATH, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Skill file ordering
// ---------------------------------------------------------------------------

/**
 * Explicit file order per skill name.
 * SKILL.md is always first (it's the entry point / overview).
 * Reference files are ordered by topic progression.
 *
 * Skills NOT listed here default to: SKILL.md first, then references/*.md alphabetically.
 * Any .md files found but NOT in the explicit list are appended alphabetically so
 * nothing is silently dropped.
 */
const SKILL_FILE_ORDER: Record<string, string[]> = {
  'dripping-faucet': [
    'faucet-api.md', // API Reference first
    'SKILL.md',
  ],
  'radius-dev': [
    'SKILL.md', // entry point, lives in skill root
    'typescript-viem.md', // lives in references/
    'events-viem.md',
    'smart-contracts.md',
    'wallet-integration.md',
    'micropayments.md',
    'security.md',
    'gotchas.md',
    'resources.md',
  ],
  'sell-api': [
    'SKILL.md',
    'frameworks.md',
    'publishers.md',
    'protocols.md',
    'networks-facilitators.md',
    'settlement.md',
    'gotchas.md',
  ],
};

/** Return the preferred file order for a skill, defaulting to SKILL.md-first. */
function getFileOrder(skillName: string): string[] {
  return SKILL_FILE_ORDER[skillName] ?? ['SKILL.md'];
}

/**
 * Resolve the full path for a skill filename.
 * SKILL.md lives in the skill root; everything else lives in references/.
 */
function resolveSkillFile(skillRoot: string, refsDir: string, filename: string): string {
  if (filename === 'SKILL.md') {
    return join(skillRoot, filename);
  }
  return join(refsDir, filename);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip YAML frontmatter (--- ... ---) from skill markdown files. */
function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  if (match) {
    return content.slice(match[0].length);
  }
  return content;
}

/** Extract the first H1 heading from content, or derive from filename. */
function extractTitle(content: string, filename: string): string {
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  // Fallback: derive from filename
  return filename
    .replace(/\.md$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Generate a GitHub-style anchor slug from a heading string. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
}

/**
 * Bump all markdown heading levels by `n` so individual file H1s don't
 * collide with the top-level skills.md structure.
 *
 * Lines inside fenced code blocks (``` or ~~~) are left untouched so
 * bash comments like `# Chain ID` aren't turned into headings.
 */
function bumpHeadings(md: string, n: number): string {
  const lines = md.split('\n');
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // Toggle code-block state on fence open/close
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    if (inCodeBlock) continue;

    // Bump heading level for lines outside code blocks
    lines[i] = lines[i].replace(/^(#{1,6})\s/, (_match, hashes: string) => {
      const newLevel = Math.min(hashes.length + n, 6);
      return '#'.repeat(newLevel) + ' ';
    });
  }

  return lines.join('\n');
}

/**
 * Rewrite relative markdown links between skill files to in-document
 * anchors, since everything is concatenated into one file.
 *
 * For example: [gotchas.md](gotchas.md) → [Production Gotchas](#production-gotchas)
 * And: [gotchas.md](gotchas.md#1-sbc-uses-6-decimals-not-18) → [Production Gotchas](#1-sbc-uses-6-decimals-not-18)
 */
function rewriteInternalLinks(
  md: string,
  fileTitleMap: Map<string, string>,
  sourceFile: string,
  skillRoot: string,
): string {
  return md.replace(
    /\[([^\]]*)\]\(([^\s)#]+)(#[^)]+)?\)/g,
    (_match, linkText: string, filename: string, anchor?: string) => {
      if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(filename)) return _match;

      const target = resolve(dirname(sourceFile), filename);
      const name = basename(target);
      const title = fileTitleMap.get(name);
      if (title && target === resolveSkillFile(skillRoot, join(skillRoot, 'references'), name)) {
        return `[${linkText}](${anchor ?? `#${slugify(title)}`})`;
      }

      // Scripts, templates and other skills are not concatenated into this file.
      // Link to their source rather than an unserved /skills/references/ path.
      const sourcePath = relative(SKILLS_SOURCE_DIR, target);
      if (!existsSync(target) || sourcePath.startsWith('..')) {
        throw new Error(`Unresolvable skill link ${filename} in ${sourceFile}`);
      }
      return `[${linkText}](${SKILLS_REPO_URL}/blob/main/${sourcePath}${anchor ?? ''})`;
    },
  );
}

// ---------------------------------------------------------------------------
// AgentSkills.io-compliant frontmatter generation
//
// Spec: https://agentskills.io/specification
//   Required: name, description
//   Optional: license, compatibility, metadata, allowed-tools
//
// Non-standard fields (version, homepage, user-invocable) belong in metadata.
// ---------------------------------------------------------------------------

/** Read `description` from the skill's SKILL.md frontmatter, the same text agents see when loading the skill. */
function readSkillDescription(skillName: string, skillRoot: string): string {
  const raw = readFileSync(join(skillRoot, 'SKILL.md'), 'utf-8');
  const frontmatter = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? '';
  const description: unknown = parse(frontmatter)?.description;
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`[${skillName}] SKILL.md has no description in its frontmatter`);
  }
  return description.replace(/\s+/g, ' ').trim();
}

/** Build AgentSkills.io-compliant YAML frontmatter for a skill. */
function generateFrontmatter(skillName: string, plugin: MarketplacePlugin, description: string): string {
  // Validate description length (spec limit: 1024 chars)
  if (description.length > 1024) {
    console.warn(`  ⚠  [${skillName}] Description is ${description.length} chars (max 1024)`);
  }

  // metadata: arbitrary key-value mapping (spec-compliant extension point)
  const metadata = JSON.stringify({
    version: plugin.version,
    homepage: plugin.homepage ?? 'https://docs.radiustech.xyz/',
    repository: plugin.repository ?? SKILLS_REPO_URL,
    'user-invocable': 'true',
  });

  // Wrap the description as a YAML folded block scalar (>)
  const descLines = description.match(/.{1,78}(\s|$)/g) ?? [description];

  return [
    '---',
    `name: ${skillName}`,
    `description: >`,
    ...descLines.map((line) => `  ${line.trimEnd()}`),
    `license: ${plugin.license ?? 'MIT'}`,
    `metadata: ${metadata}`,
    '---',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Per-skill processor
// ---------------------------------------------------------------------------

/**
 * Resolve the skills of a marketplace plugin: each subdirectory of <source>/skills/ is one skill.
 * Version, homepage and repository come from <source>/.claude-plugin/plugin.json.
 */
function resolvePluginSkills(
  plugin: MarketplacePlugin,
): Array<{ name: string; root: string; plugin: MarketplacePlugin }> {
  if (!plugin.source) throw new Error(`Plugin ${plugin.name} has no source in marketplace.json`);
  const pluginDir = join(SKILLS_SOURCE_DIR, plugin.source.replace(/^\.\//, ''));
  const pluginJson = JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf-8'));
  const merged: MarketplacePlugin = { ...plugin, ...pluginJson };
  const bundleSkillsDir = join(pluginDir, 'skills');
  const skillDirs = readdirSync(bundleSkillsDir)
    .filter((d) => statSync(join(bundleSkillsDir, d)).isDirectory())
    .sort();

  if (skillDirs.length === 0) {
    throw new Error(`No skill directories found under ${bundleSkillsDir}`);
  }

  return skillDirs.map((name) => ({ name, root: join(bundleSkillsDir, name), plugin: merged }));
}

/**
 * Generate public/skills/<skillName>.md for a single skill.
 * Returns the number of sections written.
 */
function processSkill(plugin: MarketplacePlugin, skillName: string, skillRoot: string): number {
  const refsDir = join(skillRoot, 'references');

  if (!existsSync(skillRoot)) {
    throw new Error(`[${skillName}] Skill directory not found: ${skillRoot}`);
  }

  // 1. Discover all .md files across skillRoot and skillRoot/references/
  const rootFiles = readdirSync(skillRoot).filter((f) => f.endsWith('.md') && statSync(join(skillRoot, f)).isFile());
  const refFiles = existsSync(refsDir)
    ? readdirSync(refsDir).filter((f) => f.endsWith('.md') && statSync(join(refsDir, f)).isFile())
    : [];
  const allFiles = [...new Set([...rootFiles, ...refFiles])];

  if (allFiles.length === 0) {
    throw new Error(`[${skillName}] No .md files found in ${skillRoot}`);
  }

  // 2. Order files: explicit list first (filtered to existing), then any extras alphabetically
  const explicitOrder = getFileOrder(skillName);
  const explicitSet = new Set(explicitOrder);
  const extras = allFiles.filter((f) => !explicitSet.has(f)).sort();
  const orderedFiles = [...explicitOrder.filter((f) => allFiles.includes(f)), ...extras];

  // 3. Read all files and build title map for link rewriting
  const fileContents = new Map<string, string>();
  const fileTitleMap = new Map<string, string>();

  for (const filename of orderedFiles) {
    const raw = readFileSync(resolveSkillFile(skillRoot, refsDir, filename), 'utf-8');
    const stripped = stripFrontmatter(raw).trim();
    const title = extractTitle(stripped, filename);
    fileContents.set(filename, stripped);
    fileTitleMap.set(filename, title);
  }

  // 4. Build frontmatter
  const description = readSkillDescription(skillName, skillRoot);
  const frontmatter = generateFrontmatter(skillName, plugin, description);

  // 5. Build preamble
  const skillTitle = fileTitleMap.get('SKILL.md') ?? skillName;
  const skillPath = relative(SKILLS_SOURCE_DIR, join(skillRoot, 'SKILL.md'));
  const preamble = `# ${skillTitle}

> ${description}

**Progressive disclosure:** This file is the expanded reference (all ${orderedFiles.length} skill modules concatenated). For the entry-point used by agent skill loading, see [\`SKILL.md\`](${SKILLS_REPO_URL}/blob/main/${skillPath}) in the plugin repository. Agents load \`SKILL.md\` at activation and read referenced modules on demand.`;

  // 6. Build table of contents
  const tocLines: string[] = ['## Table of contents', ''];
  for (const filename of orderedFiles) {
    const title = fileTitleMap.get(filename)!;
    tocLines.push(`- [${title}](#${slugify(title)})`);
  }
  tocLines.push('');

  // 7. Concatenate all files with heading bumps and link rewriting
  const sections: string[] = [];

  for (const filename of orderedFiles) {
    const content = fileContents.get(filename)!;

    // Bump headings: file H1 → H2, file H2 → H3, etc.
    const bumped = bumpHeadings(content, 1);

    // Rewrite internal links to in-document anchors
    const rewritten = rewriteInternalLinks(
      bumped,
      fileTitleMap,
      resolveSkillFile(skillRoot, refsDir, filename),
      skillRoot,
    );

    sections.push(rewritten);
  }

  // 8. Assemble final document
  const parts: string[] = [frontmatter, '', preamble.trim(), '', tocLines.join('\n'), '---', ''];

  for (let i = 0; i < sections.length; i++) {
    parts.push(sections[i]);
    if (i < sections.length - 1) {
      parts.push('');
      parts.push('---');
      parts.push('');
    }
  }

  const output = parts.join('\n') + '\n';

  // 9. Write output
  const outputPath = join(SKILLS_OUTPUT_BASE, `${skillName}.md`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, output, 'utf-8');

  const sizeKb = (Buffer.byteLength(output, 'utf-8') / 1024).toFixed(1);
  console.log(
    `  ✓  skills/${skillName}.md (${sizeKb} KB, ${orderedFiles.length} section${orderedFiles.length !== 1 ? 's' : ''})`,
  );
  console.log(`  ✓  [${skillName}] description: ${description.length}/1024 chars`);
  console.log(`  →  public/skills/${skillName}.md`);

  return orderedFiles.length;
}

// ---------------------------------------------------------------------------
// Agent Skills Discovery index (/.well-known/agent-skills/index.json)
// ---------------------------------------------------------------------------

interface AgentSkillsIndexEntry {
  name: string;
  type: 'skill-md';
  description: string;
  url: string;
  digest: string;
}

/** Skill subdirectories that are not part of the skill agents load. */
const SKILL_DIRS_NOT_PUBLISHED = new Set(['evaluations']);

/** Copy a directory tree, skipping the subdirectories in `SKILL_DIRS_NOT_PUBLISHED` at any depth. */
function copySkillTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from).sort()) {
    const source = join(from, entry);
    if (statSync(source).isDirectory()) {
      if (!SKILL_DIRS_NOT_PUBLISHED.has(entry)) copySkillTree(source, join(to, entry));
    } else {
      writeFileSync(join(to, entry), readFileSync(source));
    }
  }
}

/**
 * Publish a skill under public/.well-known/agent-skills/<name>/ (its SKILL.md with the reference files
 * and scripts it links to, so relative links resolve) and build its index entry. `url` is path-absolute
 * (the RFC resolves it against the index URL), so it points at this same build on every host, previews
 * included; `digest` is the SHA-256 of the exact SKILL.md bytes copied.
 */
function agentSkillsIndexEntry(skillName: string, skillRoot: string): AgentSkillsIndexEntry {
  const copyDir = join(AGENT_SKILLS_DIR, skillName);
  rmSync(copyDir, { recursive: true, force: true });
  copySkillTree(skillRoot, copyDir);
  const bytes = readFileSync(join(copyDir, 'SKILL.md'));
  return {
    name: skillName,
    type: 'skill-md',
    description: readSkillDescription(skillName, skillRoot),
    url: `${AGENT_SKILLS_URL_PATH}/${skillName}/SKILL.md`,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/** Write the index: skills sorted by name, fixed key order and a trailing newline, so builds are reproducible. */
function writeAgentSkillsIndex(entries: AgentSkillsIndexEntry[]): void {
  const names = entries.map((entry) => entry.name);
  const duplicate = names.find((name, i) => names.indexOf(name) !== i);
  if (duplicate) throw new Error(`Skill ${duplicate} appears in more than one plugin`);
  mkdirSync(AGENT_SKILLS_DIR, { recursive: true });
  const stale = readdirSync(AGENT_SKILLS_DIR).filter((entry) => entry !== 'index.json' && !names.includes(entry));
  for (const entry of stale) rmSync(join(AGENT_SKILLS_DIR, entry), { recursive: true, force: true });
  const skills = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const index = { $schema: AGENT_SKILLS_SCHEMA, skills };
  writeFileSync(AGENT_SKILLS_INDEX_PATH, JSON.stringify(index, null, 2) + '\n', 'utf-8');
  console.log(
    `  ✓  .well-known/agent-skills/index.json (${skills.length} skill${skills.length !== 1 ? 's' : ''}, skills published beside it)`,
  );
}

// ---------------------------------------------------------------------------
// Main script entry
// ---------------------------------------------------------------------------

function main(): void {
  try {
    const startTime = performance.now();

    console.log('Generating per-skill skills.md files (AgentSkills.io format) ...');

    // Read the marketplace manifest to get the canonical plugin list
    const manifest = readMarketplaceManifest();

    if (manifest.plugins.length === 0) {
      throw new Error('No plugins found in marketplace.json');
    }

    console.log(`  Found ${manifest.plugins.length} plugin(s) in marketplace.json`);

    let totalSkills = 0;
    let totalSections = 0;
    const indexEntries: AgentSkillsIndexEntry[] = [];

    for (const plugin of manifest.plugins) {
      for (const { name, root, plugin: skillPlugin } of resolvePluginSkills(plugin)) {
        console.log(`\n  Processing: ${name} v${skillPlugin.version}`);
        const sections = processSkill(skillPlugin, name, root);
        totalSkills++;
        totalSections += sections;
        indexEntries.push(agentSkillsIndexEntry(name, root));
      }
    }

    console.log('');
    writeAgentSkillsIndex(indexEntries);

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

    console.log('');
    console.log(`Generated ${totalSkills} skill(s) (${totalSections} total sections) in ${elapsed}s`);
  } catch (error) {
    console.error('');
    console.error(`✗  Skills generation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
