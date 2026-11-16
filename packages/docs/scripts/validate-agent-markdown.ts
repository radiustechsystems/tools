#!/usr/bin/env tsx
/**
 * validate-agent-markdown.ts
 *
 * Checks the agent-facing Markdown in a built site (default `dist/public`):
 *
 *   1. No page twin contains an unparsed callout (`:::note`, or `\:::note` once
 *      escaped). Callout titles must use the `:::note[Title]` form.
 *   2. Every `.md` link on this site, in the twins, `llms.txt` and
 *      `llms-full.txt`, resolves to a file in the build.
 *
 * Twins are the mirrored `/<path>.md` files written by
 * `scripts/postbuild-static-markdown.ts`. Generated skills (`/skills/`, the
 * SKILL.md copies under `/.well-known/`) and the Vocs source copies
 * (`/assets/md/`) are not twins and are skipped.
 *
 * Usage: tsx scripts/validate-agent-markdown.ts [buildDir]
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname ?? __dirname, '..');
const DOCS_BASE_URL = 'https://docs.radiustech.xyz';
const SKIPPED_DIRS = new Set(['assets', 'skills', '.well-known']);

const UNPARSED_CALLOUT = /^\\?:::/m;
const SITE_MD_LINK = new RegExp(
  `\\]\\((?:${DOCS_BASE_URL.replace(/\./g, '\\.')})?(/[^)\\s#]*\\.md)(?:#[^)\\s]*)?\\)`,
  'g',
);

function collectTwins(dir: string, root: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (dir === root && SKIPPED_DIRS.has(entry)) continue;
      collectTwins(full, root, files);
    } else if (entry.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

function main() {
  const buildDir = join(PROJECT_ROOT, process.argv[2] ?? 'dist/public');
  if (!existsSync(buildDir)) {
    console.error(`❌ Build output not found at ${buildDir}. Run \`pnpm build\` first.`);
    process.exit(1);
  }

  const twins = collectTwins(buildDir, buildDir);
  const llmsFiles = ['llms.txt', 'llms-full.txt']
    .map((name) => join(buildDir, name))
    .filter((file) => existsSync(file));
  const errors: string[] = [];

  for (const file of twins) {
    const content = readFileSync(file, 'utf8');
    const match = content.match(UNPARSED_CALLOUT);
    if (match) {
      const line = content.slice(0, match.index).split('\n').length;
      errors.push(`${relative(buildDir, file)}:${line}: unparsed callout; use :::note[Title]`);
    }
  }

  for (const file of [...twins, ...llmsFiles]) {
    for (const [, path] of readFileSync(file, 'utf8').matchAll(SITE_MD_LINK)) {
      if (!existsSync(join(buildDir, path))) {
        errors.push(`${relative(buildDir, file)}: link to ${path} has no file`);
      }
    }
  }

  if (errors.length > 0) {
    console.error(`❌ ${errors.length} agent Markdown problem(s):`);
    for (const error of [...new Set(errors)]) console.error(`   ${error}`);
    process.exit(1);
  }

  console.log(`✅ Agent Markdown validated: ${twins.length} twins, ${llmsFiles.length} llms files`);
}

main();
