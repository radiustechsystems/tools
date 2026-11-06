import { describe, expect, it } from 'vitest';
import type { Check } from '../src/lib/sellCheck.js';
import { githubAnnotations, isBlocking, scoreChecks } from '../src/lib/sellCheckScore.js';

const check = (id: string, status: Check['status'], extra: Partial<Check> = {}): Check => ({ id, status, message: `${id} ${status}`, ...extra });

describe('sell check score', () => {
  it('starts at 100 and costs 40 per blocking failure, 15 per other failure, 5 per warning', () => {
    const checks = [check('status', 'pass'), check('offer[0].asset', 'fail'), check('credentials.x402', 'fail'), check('cache', 'warn'), check('mpp', 'info'), check('head', 'skip')];
    expect(scoreChecks(checks, true)).toBe(40);
    expect(checks.map((c) => c.deduction)).toEqual([undefined, 40, 15, 5, undefined, undefined]);
  });

  it('classifies blocking checks, and lets a check override it', () => {
    for (const id of ['status', 'x402', 'resource', 'offer[2].facilitator', 'buyer.x402', 'buyer.mpp', 'mpp[0].challenge', 'pay', 'pay.receipt']) expect(isBlocking({ id }), id).toBe(true);
    for (const id of ['cache', 'head', 'mpp', 'mpp[1].mirror', 'offer[0].gasSponsoring', 'free-quota', 'credentials.mpp', 'discovery.paymentInfo']) expect(isBlocking({ id }), id).toBe(false);
    expect(isBlocking({ id: 'credentials.x402', blocking: true })).toBe(true);
  });

  it('scores 0 when the route does not answer 402, at most 50 when the 402 was not reached, never below 0', () => {
    expect(scoreChecks([check('status', 'fail')], false)).toBe(0);
    expect(scoreChecks([check('free-quota', 'info')], false)).toBe(50);
    expect(scoreChecks([check('free-quota', 'warn')], false)).toBe(50);
    expect(scoreChecks(['x402', 'resource', 'buyer.x402'].map((id) => check(id, 'fail')), true)).toBe(0);
  });
});

describe('GitHub Actions annotations', () => {
  it('emits ::error for failures and ::warning for warnings, escaped', () => {
    const lines = githubAnnotations([check('status', 'pass'), { id: 'offer[0].amount', status: 'fail', message: '100% off\nnext line' }, check('cache', 'warn')], 'GET https://a.example/r?x=1,2');
    expect(lines).toEqual([
      '::error title=sell check offer[0].amount%3A GET https%3A//a.example/r?x=1%2C2::100%25 off%0Anext line',
      '::warning title=sell check cache%3A GET https%3A//a.example/r?x=1%2C2::cache warn',
    ]);
  });
});
