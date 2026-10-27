# Radius developer docs

Source of [docs.radiustech.xyz](https://docs.radiustech.xyz), built with [Vocs](https://vocs.dev). The site imports `radius-sdk` from this workspace and publishes the skills in `plugins/radius/skills` at `/skills/<name>.md`.

## Commands

Run from `packages/docs` (Node 22.15+, pnpm). Build the SDK once first: `pnpm --filter radius-sdk build` (the docs resolve it from its `dist/`).

| Command                    | Description                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| `pnpm dev`                 | Development server at `http://localhost:5173` (pages only, no `/api/try`)      |
| `pnpm build`               | Generate skills and sitemap, build to `dist/public`, mirror Markdown twins     |
| `pnpm wrangler dev`        | After a build: serve the site and the Worker (`/api/try/*`) like production    |
| `pnpm typecheck:docs`      | Type-check the site, scripts and Worker                                        |
| `pnpm docs:validate`       | Frontmatter, links, headings and JSON blocks in `docs/pages`                   |
| `pnpm docs:markdown-audit` | Fail if an MDX component would be left unrendered in agent Markdown            |
| `pnpm docs:agent-check`    | After a build: fail on unparsed callouts or `.md` links with no file           |
| `pnpm docs:sitemap-check`  | After a build: validate `sitemap.xml`                                          |
| `pnpm fetch-cost`          | Refresh the fee constants in `docs/constants.ts` (the deploy workflow does it) |

CI (`.github/workflows/docs.yml`) runs format, lint, typecheck, the validators and the build on every pull request that touches the docs, the SDK or the skills, and uploads a preview version of the Worker for same-repo pull requests.

## Hosting and releases

The site is a Cloudflare Worker (`wrangler.jsonc`): Workers static assets serve `dist/public`, including `public/_redirects` and `public/_headers` (`noindex` on `workers.dev` hosts, so previews and the pre-cutover site stay out of search results), and `worker/index.ts` handles `/api/try/*`, the backend of the interactive "Try Radius" components (a testnet faucet proxy and priced testnet routes built with `radius-sdk/hono`). Pages and the agent-facing files (`*.md`, `llms.txt`, `llms-full.txt`, `robots.txt`, sitemaps) also pass through the Worker, which serves them from static assets, gives a page's Markdown twin to requests that ask for `text/markdown`, and records agent requests in Workers Logs and the `docs_agent_fetches` Analytics Engine dataset: browser analytics never see agents. Scripts, styles and images stay asset-first.

Production follows releases, not `main`, so the docs never describe a package version that is not on npm. `.github/workflows/docs-deploy.yml` builds and deploys, then moves the `docs-live` tag to the deployed commit:

- `release.yml` runs it after every npm publish.
- For a docs-only release, run "Deploy docs" from the Actions tab. It refuses while changesets for `radius-sdk` or `radius-cli` are pending, because the docs on `main` may then describe unpublished code.
- For an urgent fix while package changes are pending, branch from `docs-live`, commit the fix, run "Deploy docs" on that branch, and merge the same fix to `main`.

`git diff docs-live main -- packages/docs` shows what is not live yet. Docs-only pull requests need no changeset. Document `radius-sdk` and `radius-cli` changes in the same pull request as the code, so they ship together.

## Adding New Pages

To add new documentation:

1. Create a new `.mdx` file in `docs/pages/` or a subdirectory
2. Add frontmatter metadata (required for non-index pages):

   ```markdown
   ---
   title: My Page Title
   description: Brief description for SEO, social cards, and llms.txt
   sitemap:
     priority: 0.9 # Optional: Override default priority (0.0-1.0)
     changefreq: weekly # Optional: Override default changefreq
     exclude: false # Optional: Exclude from sitemap entirely
   ---
   ```

   `title` and `description` are the single source for the page's HTML metadata **and** its entry in `llms.txt`. Pages are listed in `llms.txt` in sidebar order.

   **Sitemap configuration** is optional; `scripts/generate-sitemap.ts` assigns defaults by section and takes `lastmod` from git history.

3. Write your content in Markdown or MDX format
4. Update `vocs.config.ts` sidebar if you want the page in navigation (this also sets its position in `llms.txt`)
5. Run `pnpm dev` to preview locally
6. If the page uses a custom component as a standalone tag (`<MyComponent />`), give the component a `toMarkdown` hook (see `docs/components/FeatureCards.tsx`) and run `pnpm docs:markdown-audit`

## LLM-Friendly Documentation

Plain-text documentation is available by adding `.md` to any docs URL (for example, `/reference/fees.md`). Every page also has "View as Markdown" and "Copy for LLM" buttons below its title.

### Generated by Vocs

Vocs generates these from the same MDX/Markdown pages humans read ([agent support docs](https://vocs.dev/features/agent-support)):

- **`/llms.txt`** — Index of pages with one-line summaries ([llms.txt spec](https://llmstxt.org/)), ordered by the sidebar
- **`/llms-full.txt`** — All doc pages combined into one file
- **`/<path>.md`** — Markdown twin of every page (written to `dist/public/assets/md/` and mirrored to the pretty URL by `scripts/postbuild-static-markdown.ts`, because the site is hosted statically)

### Keeping generated Markdown clean

Vocs converts the MDX AST, not the rendered React tree. Two mechanisms keep the output readable:

- **`toMarkdown` hooks** on components used as standalone tags (`<FeatureCards />`, `<GetStartedRow />`). Keep the content in a colocated `*-data.ts` module so HTML and Markdown share one source.
- **`docs/remark-llm-output.ts`**, an output-only remark plugin that resolves `{CONSTANT}` expressions, renders `<TransactionCost />` as its static value, converts plain HTML JSX and `:::note` callouts, and splits `# Title [Subtitle]` headings.

Run `pnpm docs:markdown-audit` (also in CI) to catch components that would otherwise leak into agent Markdown as raw JSX.

## License

MIT
