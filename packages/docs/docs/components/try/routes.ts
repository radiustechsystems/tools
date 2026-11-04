/**
 * Priced testnet routes for the "Try Radius" components. worker/index.ts charges for them under the
 * Radius Platform policy of the docs project, so the price is not defined here: the API quotes it
 * in its 402 response.
 */
export const TRY_ROUTES = {
  'GET /api/try/hello': { description: 'A Hello, world! message' },
} as const;
