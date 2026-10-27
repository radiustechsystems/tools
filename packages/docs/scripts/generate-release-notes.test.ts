import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  anchor,
  collectReleases,
  describe,
  emphasizeHeadline,
  escapeMdx,
  firstSentence,
  parseChangesetsVersion,
  parseNetwork,
  parsePackage,
  parseSkills,
  renderFeed,
  renderPage,
  sortReleases,
} from './generate-release-notes';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(repoRoot, path), 'utf8');

test('the first sentence ends outside code and abbreviations', () => {
  assert.equal(firstSentence('Use `a.b. c` here, e.g. now. Then more.'), 'Use `a.b. c` here, e.g. now.');
  assert.equal(firstSentence('New `radius-sdk/server` entry point:'), undefined);
  assert.equal(emphasizeHeadline('One. Two.\n  more'), '**One.** Two.\n  more');
  assert.equal(emphasizeHeadline('**Breaking:** kept as written.'), '**Breaking:** kept as written.');
});

test('MDX syntax is escaped outside code only', () => {
  assert.equal(escapeMdx('a {b} <c> `{d} <e>`'), 'a \\{b\\} &lt;c> `{d} <e>`');
  assert.equal(escapeMdx('```ts\nconst x = {a: 1} < 2\n```'), '```ts\nconst x = {a: 1} < 2\n```');
});

test('anchors match Vocs heading ids', () => {
  assert.equal(anchor('2026-10-15: radius-sdk 0.6.0'), '2026-10-15-radius-sdk-060');
  assert.equal(anchor('2026-09-28: Radius Network'), '2026-09-28-radius-network');
});

const changelog = `# radius-cli

## 0.2.0

### Major Changes

- abc1234: Removed the old command. It is gone.

### Minor Changes

- def5678: Add \`thing\`. It does more.
  - **Breaking:** a sub-change.
- 1234567: Add \`other\`.
- 2345678: Move a dependency.

  **Breaking for installs:** add it yourself.

### Patch Changes

- 7654321: Fix a crash.
- Updated dependencies [7654321]
  - radius-sdk@0.6.0

## 0.1.0

### Patch Changes

- Updated dependencies [aaaaaaa]
  - radius-sdk@0.5.0
`;

test('Changesets sections map to breaking, new and fix; dependency bumps are pulled out', () => {
  const body = changelog.split('## 0.2.0')[1]!.split('## 0.1.0')[0]!;
  const { changes, dependencies } = parseChangesetsVersion(body);
  assert.deepEqual(
    changes.map((change) => change.kind),
    ['breaking', 'breaking', 'new', 'breaking', 'fix'],
  );
  assert.equal(changes[1]!.text, 'Add `thing`. It does more.\n  - **Breaking:** a sub-change.');
  assert.deepEqual(dependencies, ['radius-sdk@0.6.0']);
});

test('only tagged package versions are listed, dated by their tag', () => {
  const releases = parsePackage('radius-cli', changelog, new Map([['radius-cli@0.1.0', '2026-09-01']]));
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.title, 'radius-cli 0.1.0');
  assert.equal(releases[0]!.date, '2026-09-01');
  assert.match(releases[0]!.body, /Uses `radius-sdk@0\.5\.0`\./);
  assert.match(releases[0]!.body, /releases\/tag\/radius-cli%400\.1\.0/);
});

test('network and skills sections parse; malformed headings fail', () => {
  const network = parseNetwork(
    '<!-- note -->\n\n## 2026-09-24 (10eea1f9)\n\n### Improvements\n\n- Faster. More.\n\n### API / RPC changes\n\n#### `eth_call` change\n\n- **Before:** x\n',
  );
  assert.equal(network[0]!.date, '2026-09-24');
  assert.deepEqual(network[0]!.headlines, ['Faster.', 'eth_call change']);
  assert.throws(() => parseNetwork('## September (abc)\n'), /heading must be/);

  const skills = parseSkills('# Title\n\n## 0.2.0 (2026-10-16)\n\n- **Breaking:** renamed.\n- Added. More.\n');
  assert.equal(skills[0]!.title, 'Radius skills 0.2.0');
  assert.deepEqual(skills[0]!.headlines, ['Breaking: renamed.', 'Added.']);
  assert.throws(() => parseSkills('## 0.2.0\n'), /heading must be/);
});

test('releases sort newest first, network before packages on the same day', () => {
  const releases = sortReleases([
    { title: 'Radius skills 0.1.0', date: '2026-10-15', body: '', headlines: [] },
    { title: 'radius-sdk 0.6.0', date: '2026-10-15', body: '', headlines: [] },
    { title: 'Radius Network', date: '2026-10-15', body: '', headlines: [] },
    { title: 'radius-cli 0.5.0', date: '2026-10-16', body: '', headlines: [] },
  ]);
  assert.deepEqual(
    releases.map((release) => release.title),
    ['radius-cli 0.5.0', 'Radius Network', 'radius-sdk 0.6.0', 'Radius skills 0.1.0'],
  );
});

test('the description names the latest release within 160 characters', () => {
  const description = describe([
    { title: 'radius-sdk 1.0.0', date: '2026-11-01', body: '', headlines: ['x'.repeat(300)] },
  ]);
  assert.ok(description.startsWith('Latest: radius-sdk 1.0.0 (2026-11-01).'));
  assert.ok(description.length <= 160);
});

test('the real sources build a page and feed with every released version', () => {
  const tags = new Map<string, string>();
  for (const [name, path] of [
    ['radius-sdk', 'packages/sdk/CHANGELOG.md'],
    ['radius-cli', 'packages/cli/CHANGELOG.md'],
  ] as const) {
    for (const [, version] of read(path).matchAll(/^## (\S+)$/gm)) tags.set(`${name}@${version}`, '2026-10-01');
  }
  const releases = collectReleases(read, tags);
  const page = renderPage(releases);
  const feed = renderFeed(releases);
  for (const tag of tags.keys()) {
    const title = tag.replace('@', ' ');
    assert.ok(page.includes(`: ${title}\n`), `${title} missing from the page`);
    assert.ok(feed.includes(`<title>${title}</title>`), `${title} missing from the feed`);
  }
  const version = JSON.parse(read('plugins/radius/.claude-plugin/plugin.json')).version;
  assert.ok(page.includes(`: Radius skills ${version}\n`));
  assert.ok(page.includes(': Radius Network\n'));
  assert.doesNotMatch(page, /Updated dependencies/);
  assert.equal((feed.match(/<entry>/g) ?? []).length, releases.length);
});

test('a checkout without release tags fails instead of dropping the packages', () => {
  assert.throws(() => collectReleases(read, new Map()), /no radius-sdk@<version> git tags found/);
});
