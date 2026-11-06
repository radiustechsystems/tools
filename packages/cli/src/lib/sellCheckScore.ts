/**
 * The `sell check` score: 0 to 100, from the checks a run produced. A seller starts at 100 and
 * loses points for each failed or warning check; a failure that stops buyers from paying (or lets
 * them in without paying) costs the most.
 *
 *   blocking failure    -40   status, x402, resource, every offer[i].* check except gasSponsoring,
 *                             buyer.*, mpp[i].challenge / network, pay, pay.receipt, and a seller that
 *                             serves the route to a malformed credential
 *   other failure       -15   e.g. a malformed credential answered 500
 *   warning              -5
 *   pass, info, skip      0
 *
 * Two caps: a route that does not answer 402 at all (the `status` check failed) scores 0, and a run
 * that never reached the 402 (a free quota that was not used up) scores at most 50, since most of
 * the seller was not checked.
 */
import type { Check } from './sellCheck.js';

export const SCORE_WEIGHTS = { blockingFail: 40, fail: 15, warn: 5 } as const;
/** The most a run that never reached the 402 can score. */
export const UNCHECKED_402_CAP = 50;

/** Checks whose failure does not stop a buyer from paying. Every other failure is blocking. */
const NON_BLOCKING = [/^cache$/, /^head$/, /^mpp$/, /^mpp\[\d+\]\.(mirror|method)$/, /^offer\[\d+\]\.gasSponsoring$/, /^free-quota$/, /^credentials\./, /^discovery\./];

export function isBlocking(check: Pick<Check, 'id' | 'blocking'>): boolean {
  if (check.blocking !== undefined) return check.blocking;
  return !NON_BLOCKING.some((re) => re.test(check.id));
}

/** Points a check costs (0 for pass, info and skip). */
export function deductionOf(check: Pick<Check, 'id' | 'status' | 'blocking'>): number {
  if (check.status === 'fail') return isBlocking(check) ? SCORE_WEIGHTS.blockingFail : SCORE_WEIGHTS.fail;
  if (check.status === 'warn') return SCORE_WEIGHTS.warn;
  return 0;
}

/**
 * The score of one run; sets `deduction` on each check that costs points. `reached402` is false
 * when the run stopped before reading a 402.
 */
export function scoreChecks(checks: Check[], reached402: boolean): number {
  let score = 100;
  for (const c of checks) {
    const d = deductionOf(c);
    if (d > 0) c.deduction = d;
    else delete c.deduction;
    score -= d;
  }
  if (checks.some((c) => c.id === 'status' && c.status === 'fail')) return 0;
  if (!reached402) score = Math.min(score, UNCHECKED_402_CAP);
  return Math.max(0, score);
}

/** Escape a GitHub Actions workflow command message (`%`, CR and LF). */
function escapeData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Escape a workflow command property value (also `:` and `,`). */
function escapeProperty(s: string): string {
  return escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * GitHub Actions annotations for the failed (`::error`) and warning (`::warning`) checks.
 * `context` (e.g. `GET https://api.example.com/r`) goes into each title.
 */
export function githubAnnotations(checks: Check[], context: string): string[] {
  const out: string[] = [];
  for (const c of checks) {
    if (c.status !== 'fail' && c.status !== 'warn') continue;
    const title = escapeProperty(`sell check ${c.id}: ${context}`);
    out.push(`::${c.status === 'fail' ? 'error' : 'warning'} title=${title}::${escapeData(c.message)}`);
  }
  return out;
}
