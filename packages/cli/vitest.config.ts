import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const sdk = (p: string) => fileURLToPath(new URL(`../sdk/src/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Tests read the SDK from source so a stale packages/sdk/dist can never leak into them.
    alias: [
      { find: /^radius-sdk\/client$/, replacement: sdk('client/index.ts') },
      { find: /^radius-sdk\/signers\/proxy$/, replacement: sdk('signers/proxy.ts') },
      { find: /^radius-sdk\/hono$/, replacement: sdk('hono/index.ts') },
      { find: /^radius-sdk\/server$/, replacement: sdk('server/index.ts') },
      { find: /^radius-sdk$/, replacement: sdk('index.ts') },
    ],
  },
});
