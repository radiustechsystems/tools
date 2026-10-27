<!--
Fill in every section. Write "None" rather than deleting a section, so a
reviewer can tell "nothing here" from "forgot". HTML comments like this one
do not render; leave them in or delete them.
Agents: AGENTS.md rules still apply. Never paste private keys, RADIUS_*
secrets, API keys or funded wallet addresses into this description.
-->

## What and why

<!--
One or two sentences on the change, then the reason for it. Link the issue
(Linear ENG-xxxx or GitHub). A reviewer who reads only this section should
know whether the PR is worth their time.
-->

## Risk tier

<!--
Tick exactly one. The highest tier any changed file reaches wins. When
unsure between two tiers, pick the higher one.

The tier sets how many author/reviewer cycles the PR needs before a human
merges it. One cycle = a review pass (Claude Code Review, /code-review, or a
person) followed by the author's fixes. A cycle is "clean" when it leaves no
blocking (red) findings.
-->

- [ ] **T0 Trivial**: typos, comments, docs prose with no code samples, test-only or eval-wording changes. Needs 1 clean cycle, any maintainer merges.
- [ ] **T1 Contained**: internal refactor with no public API change, new tests, docs pages with code samples, skill corrections (plugin patch bump), dev tooling. Needs 1 clean cycle and 1 human approval.
- [ ] **T2 User-facing**: public SDK or CLI API or output change, new skill capability (plugin minor bump), dependency or peer-dependency change, changes to an eval's pass criteria, persisted-state formats. Needs 2 clean cycles in a row, the `eval-loop` skill where it applies, and approval from a package owner.
- [ ] **T3 Money and trust**: anything on the payment path (signing, amount or decimal math, payment verification, settlement, nonces, permits, sponsored approvals, chain IDs or token addresses), key or secret handling, `release.yml` or npm publishing, workflow `permissions:` or secrets, `docs-deploy.yml`. Needs clean cycles until a full pass finds nothing new, a `/security-review` run, approval from a package owner, and no auto-merge.

<!-- If you picked a tier lower than a file's obvious tier, say why here. -->

## Blast radius

<!-- Tick everything this PR changes, and who it reaches once released. -->

- [ ] `packages/sdk`: every app and agent on `radius-sdk` after the next npm release
- [ ] `packages/cli`: every `radius-cli` user after the next npm release
- [ ] `packages/docs`: docs.radiustech.xyz, its `.md` twins and `llms.txt` (humans and agents) after the next deploy
- [ ] `plugins/radius` or `.claude-plugin/`: installed plugin users after they update, plus Codex users of `npx skills add`
- [ ] `evaluations/` or `plugins/radius/evals`: what we treat as passing
- [ ] `.github/workflows`, `scripts/`, root config: CI, release and every contributor
- [ ] Other:

**Breaking for any of the above?** <!-- No / Yes: who breaks and what they must do. -->

## Risk

<!--
What is most likely to go wrong, and what is the worst thing that could go
wrong? Be concrete: "a buyer on CLI <= x.y could overpay when ...", not
"low risk". Include:
- assumptions you could not verify (testnet behavior, facilitator responses,
  upstream @x402 versions)
- anything that reads or writes persisted state (transfer checkpoints,
  stores, config files) and whether old data still loads
- money: can this move, lock or misreport funds? If yes, the tier is T3.
-->

## How to revert

<!--
Write the exact steps for this PR. Pick the lines that apply and fill them in:

- Before release: `git revert -m 1 <merge sha>`. Reverting also removes the
  changeset, so nothing ships.
- After an npm release: npm versions cannot be taken back. Revert, add a
  patch changeset, merge the Version Packages PR. If the bad version is
  harmful, a person with npm rights runs
  `npm deprecate <pkg>@<version> "<reason>"`.
- Plugin: revert the skill change AND bump `plugin.json` again. Users only
  receive the revert through a higher version.
- Docs: revert, then run "Deploy docs" from Actions, or deploy a branch cut
  from `docs-live`.
- Workflows or release: revert, and say whether any run of the bad version
  needs cleanup (tags, GitHub Releases, npm dist-tags).
- Irreversible: say so plainly (published package, onchain transaction,
  data migrated in place) and what the mitigation is.
-->

## Verification

<!--
List each command you ran and its result. Paste failure output, do not
summarize it. Strike through or explain anything from AGENTS.md
"Before you finish" that applied but you did not run.
-->

```text

```

**Not verified:** <!-- What you could not test, and why. "None" is a claim; make it only if true. -->

## Repo rules

<!-- Tick the ones that apply; leave the rest unticked. -->

- [ ] `packages/sdk` or `packages/cli` changed: a changeset is included, and `CHANGELOG.md` and package versions are untouched
- [ ] SDK or CLI behavior changed: `packages/docs` is updated in this PR, and the skills under `plugins/radius/skills` that cover it were audited
- [ ] A skill names a new SDK or CLI API: that version is already on npm, and the skill states the minimum version
- [ ] A skill, the plugin manifest or the plugin README changed: `plugins/radius/.claude-plugin/plugin.json` is bumped (patch for corrections, minor for new capabilities)
- [ ] Skill examples write prices as decimal strings (`'0.001'`) and amounts as amount plus asset (`0.001 SBC`), with no `$`
- [ ] No test, eval or example in this PR spends from a funded wallet, and no secret appears in code, logs or this description

## Review notes

<!--
Where should a reviewer look first? Name the file and line where the risk
lives, any decision you want challenged, and anything that looks wrong but is
deliberate.
-->

## Authorship

<!--
Human, agent, or both. For agent-authored PRs: the session link, and the
review cycles so far, e.g. "Cycle 1: 3 findings, fixed in abc123. Cycle 2:
clean." Update this as cycles happen so the tier requirement is visible.
-->
