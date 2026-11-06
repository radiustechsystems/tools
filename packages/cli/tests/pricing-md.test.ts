import { describe, expect, it } from 'vitest';
import { fillPath, joinUrl, parsePricingMd, pathParams } from '../src/lib/pricingMd.js';

// The format the Radius Platform renders (crates/domain/src/pricing_md in radius-platform).
const FILE = `# Acme pricing

Machine-readable pricing for Acme's paid endpoints, by catalog. Prices are per request, in US dollars.

## Chain data

- Base URL: [Base URL]
- Payment: x402, SBC on Radius or USDC on Base

### Prices

- Request: \`ANY /price/*\`
- Price: $2.50 / request
- Payment: x402, SBC on Radius

### Quote \\*fast\\* &amp; cheap

- Request: \`GET /quote\`
- Price: $1,284.52 / request

### Transactions

- Request: \`GET, POST /tx/:hash\`
- Price: $0.000001 / request

## Weather API

- Base URL: https://weather.example/api
- Payment: x402, SBC on Radius

### Forecast

- Request: \`GET /v1/forecast/:city\`
- Price: $0.001 / request
- Free: 20 requests per 5 minutes per IP, shared with Historical data
`;

describe('pricing.md', () => {
  it('reads catalogs, routes, methods, prices, free quotas and base URLs', () => {
    const routes = parsePricingMd(FILE);
    expect(routes).toEqual([
      { catalog: 'Chain data', name: 'Prices', methods: ['ANY'], path: '/price/*', price: '$2.50', baseUrl: undefined },
      { catalog: 'Chain data', name: 'Quote *fast* & cheap', methods: ['GET'], path: '/quote', price: '$1284.52', baseUrl: undefined },
      { catalog: 'Chain data', name: 'Transactions', methods: ['GET', 'POST'], path: '/tx/:hash', price: '$0.000001', baseUrl: undefined },
      { catalog: 'Weather API', name: 'Forecast', methods: ['GET'], path: '/v1/forecast/:city', price: '$0.001', free: '20 requests per 5 minutes per IP, shared with Historical data', baseUrl: 'https://weather.example/api' },
    ]);
  });

  it('refuses a file with no routes', () => {
    expect(() => parsePricingMd('# Nothing here\n')).toThrow(/no routes found/);
  });

  it('fills path parameters, and names the missing ones', () => {
    expect(pathParams('/tx/:transfer_type/:hash')).toEqual(['transfer_type', 'hash']);
    expect(pathParams('/price/*')).toEqual(['*']);
    expect(fillPath('/tx/:transfer_type/:hash', { transfer_type: 'radius', hash: '0x01' })).toEqual({ path: '/tx/radius/0x01' });
    expect(fillPath('/q/{term}', { term: 'a b/c' })).toEqual({ path: '/q/a%20b%2Fc' });
    expect(fillPath('/price/*', { '*': 'sbc/usd' })).toEqual({ path: '/price/sbc/usd' });
    expect(fillPath('/tx/:transfer_type/:hash', { hash: '0x01' })).toEqual({ missing: ['transfer_type'] });
  });

  it('joins a base URL with a path prefix', () => {
    expect(joinUrl('https://h.example/api/', '/tx/1')).toBe('https://h.example/api/tx/1');
    expect(joinUrl('http://localhost:8788', '/wallet/0x1')).toBe('http://localhost:8788/wallet/0x1');
  });
});
