#!/usr/bin/env tsx
/**
 * postbuild-analytics.ts
 *
 * Adds the PostHog loader to every built HTML page, just before `</head>`.
 *
 * It is injected after `vocs build` rather than rendered by Vocs (`head` in vocs.config.ts) so
 * that it sits outside React's tree. Ad blockers with HTML filtering (uBlock Origin on Firefox,
 * for example) delete inline scripts that mention PostHog before the page is parsed. A tag React
 * rendered and then can't find fails hydration (React error #418), and React re-renders the whole
 * page on the client. React skips `<head>` tags it didn't render, so a removed loader changes
 * nothing for readers who block it, and a blocked array.js only leaves the stub queueing calls.
 * Nothing on the site calls PostHog, so no feature depends on it loading.
 *
 * Events go to the "Radius Platform" PostHog project (688196), the same project as
 * app.radiustech.xyz, through t.radiustech.xyz, PostHog's managed reverse proxy. The project API
 * key is public: it can only send events. The loader runs only on the production host, so local
 * runs, Worker previews and other mirrors of the build send nothing.
 *
 * Runs automatically via the `postbuild` script.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const PROJECT_ROOT = join(import.meta.dirname ?? dirname(new URL(import.meta.url).pathname), '..');
const OUT_DIR = process.env.VOCS_OUT_DIR ?? join(PROJECT_ROOT, 'dist', 'public');

const POSTHOG = {
  key: 'phc_D6W25w2AujhkbjqD7m5KZyJRhT4423LzdD7bb8NLW7Jg',
  productionHost: 'docs.radiustech.xyz',
  options: {
    api_host: 'https://t.radiustech.xyz',
    ui_host: 'https://us.posthog.com',
    // Pins PostHog's default behavior (pageviews on every history change, which suits Vocs's
    // client-side navigation) so a new array.js doesn't change what we collect.
    defaults: '2026-08-30',
    // Anonymous readers stay events only; no person profiles.
    person_profiles: 'identified_only',
  },
  // Separates docs events from the console's (`source: web`) in the shared project.
  properties: { source: 'docs', surface: 'docs' },
};

// PostHog's loader stub, verbatim from the project's snippet. It queues calls until array.js loads.
const POSTHOG_STUB = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}p||((p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){p=null},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r));var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="init capture register register_once register_for_session unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group identify setPersonProperties setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroups onFeatureFlags addFeatureFlagsHandler onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;

/** Marks the injected tag, so a second run (or a stale dist) never adds it twice. */
const MARKER = 'data-radius-analytics';

const SCRIPT = [
  `<script ${MARKER}>`,
  // try/catch: an error in the loader (a blocker's broken `window.posthog` shim, say) must not
  // surface as an uncaught error on the page.
  `try{if(location.hostname===${JSON.stringify(POSTHOG.productionHost)}){`,
  POSTHOG_STUB,
  `posthog.init(${JSON.stringify(POSTHOG.key)},${JSON.stringify(POSTHOG.options)});`,
  `posthog.register(${JSON.stringify(POSTHOG.properties)});`,
  `}}catch(e){}`,
  `</script>`,
].join('');

function collectHtml(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectHtml(full, files);
    else if (entry.endsWith('.html')) files.push(full);
  }
  return files;
}

let injected = 0;
for (const file of collectHtml(OUT_DIR)) {
  const html = readFileSync(file, 'utf-8');
  if (html.includes(MARKER)) continue;
  const end = html.indexOf('</head>');
  if (end === -1) throw new Error(`${file} has no </head>; cannot add the analytics loader.`);
  writeFileSync(file, html.slice(0, end) + SCRIPT + html.slice(end));
  injected++;
}

console.log(`  ✓  PostHog loader added to ${injected} HTML page(s)`);
