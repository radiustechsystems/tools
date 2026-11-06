import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

const docsRoot = join(import.meta.dirname, '..');
const repoRoot = join(docsRoot, '..', '..');
const plugin = JSON.parse(readFileSync(join(repoRoot, 'plugins/radius/.claude-plugin/plugin.json'), 'utf8'));
const repository = 'https://github.com/radiustechsystems/tools';

const generate = () =>
  execFileSync(process.execPath, ['--import', 'tsx', join(import.meta.dirname, 'generate-skills-md.ts')]);
generate();

function frontmatter(markdown: string) {
  return parse(markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)![1]);
}

for (const name of ['radius-dev', 'dripping-faucet', 'x402', 'sell-api']) {
  test(`${name}: published description and links survive flattening`, () => {
    const source = join(repoRoot, 'plugins/radius/skills', name, 'SKILL.md');
    const output = readFileSync(join(docsRoot, 'public/skills', `${name}.md`), 'utf8');
    const metadata = frontmatter(output);
    const description = frontmatter(readFileSync(source, 'utf8')).description.replace(/\s+/g, ' ').trim();
    assert.equal(metadata.description.trim(), description);
    assert.ok(description.length > 20 && description.length <= 1024);
    assert.equal(metadata.name, name);
    assert.equal(metadata.metadata.version, plugin.version);
    assert.equal(metadata.metadata.repository, repository);
    assert.ok(output.includes(`](${repository}/blob/main/plugins/radius/skills/${name}/SKILL.md)`));

    for (const [, target] of output.matchAll(/\]\(([^\s)]+)\)/g)) {
      assert.match(target, /^(?:#|\/|[a-z][a-z\d+.-]*:)/i, `relative link left in ${name}: ${target}`);
      const prefix = `${repository}/blob/main/`;
      if (target.startsWith(prefix)) {
        assert.ok(existsSync(join(repoRoot, target.slice(prefix.length).split('#')[0])), target);
      }
    }
  });
}

test('flat references use local anchors; scripts and other skills keep source links', () => {
  const read = (name: string) => readFileSync(join(docsRoot, 'public/skills', `${name}.md`), 'utf8');
  assert.ok(read('dripping-faucet').includes('[references/faucet-api.md](#'));
  assert.ok(
    read('radius-dev').includes(
      `[scripts/radius-wallet-bootstrap.mjs](${repository}/blob/main/plugins/radius/skills/radius-dev/scripts/radius-wallet-bootstrap.mjs)`,
    ),
  );
  assert.ok(
    read('x402').includes(
      `[micropayments.md](${repository}/blob/main/plugins/radius/skills/radius-dev/references/micropayments.md)`,
    ),
  );
});

const indexPath = join(docsRoot, 'public/.well-known/agent-skills/index.json');
const marketplace = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'));

test('agent-skills index lists every skill with the SHA-256 of its SKILL.md', () => {
  const raw = readFileSync(indexPath, 'utf8');
  assert.ok(raw.endsWith('}\n'), 'index ends with one trailing newline');
  const index = JSON.parse(raw);
  assert.deepEqual(Object.keys(index), ['$schema', 'skills']);
  assert.equal(index.$schema, 'https://schemas.agentskills.io/discovery/0.2.0/schema.json');

  const expected: string[] = [];
  const sources = new Map<string, string>();
  for (const { source } of marketplace.plugins) {
    const skillsDir = join(repoRoot, source, 'skills');
    for (const name of readdirSync(skillsDir).filter((d) => statSync(join(skillsDir, d)).isDirectory())) {
      expected.push(name);
      sources.set(name, `${source.replace(/^\.\//, '')}/skills/${name}/SKILL.md`);
    }
  }
  const names = index.skills.map((skill: { name: string }) => skill.name);
  assert.deepEqual(names, [...expected].sort(), 'every skill listed once, sorted by name');

  for (const skill of index.skills) {
    assert.deepEqual(Object.keys(skill), ['name', 'type', 'description', 'url', 'digest']);
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.equal(skill.type, 'skill-md');
    const path = sources.get(skill.name)!;
    assert.equal(skill.url, `https://raw.githubusercontent.com/radiustechsystems/tools/main/${path}`);
    const bytes = readFileSync(join(repoRoot, path));
    assert.equal(skill.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.match(skill.digest, /^sha256:[0-9a-f]{64}$/);
    const description = frontmatter(bytes.toString('utf8')).description.replace(/\s+/g, ' ').trim();
    assert.equal(skill.description, description);
    assert.ok(skill.description.length <= 1024);
  }
});

test('agent-skills index is byte-identical across runs', () => {
  const first = readFileSync(indexPath);
  generate();
  assert.ok(first.equals(readFileSync(indexPath)));
});
