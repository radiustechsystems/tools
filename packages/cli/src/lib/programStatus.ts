import { writeSync } from 'node:fs';

/**
 * Program Status Protocol (OSC 7501): tells the terminal whether radius-cli is working, waiting on
 * the user, or finished, so a tab in the background can show "waiting on you" at a payment prompt.
 * Spec: https://gist.github.com/mitchellh/7acae3abd8355c1c00287d67e96c913a
 *
 * - Reports go to stderr only when it is a terminal, so `--json` output, pipes, CI logs and agents
 *   reading our output never see escape bytes. RADIUS_NO_PROGRAM_STATUS, TERM=dumb and CI turn it off.
 * - Terminals without support ignore unknown OSCs, so there is no support query.
 * - Nothing is sent until a run waits on the user or the network. When a prompt is answered the
 *   previous state comes back (or `working`, which the terminal drops at exit). Only a run that
 *   waited on the network ends with `done` or `error`, so signing or a quick read leaves no record.
 * - Never `clear`: without an id it removes every record on the terminal, other programs' included.
 * - Messages are fixed templates filled with values the CLI has validated, never server text.
 */

export type BlockedKind = 'permission' | 'question' | 'auth';
type State = 'idle' | 'working' | 'done' | 'blocked' | 'error';

export interface Report {
  state: State;
  kind?: BlockedKind;
  msg?: string;
}

const APP = 'radius-cli';
const MAX_MSG_BYTES = 2048;

/** Encode one report. */
export function formatReport({ state, kind, msg }: Report): string {
  const pairs = [`state=${state}`, `app=${APP}`];
  if (kind) pairs.push(`kind=${kind}`);
  const text = msg ? cleanMsg(msg) : '';
  if (text) pairs.push(`msg=${Buffer.from(text, 'utf8').toString('base64')}`);
  return `\x1b]7501;${pairs.join(':')}\x1b\\`;
}

/** One line, no control characters (C0, DEL, C1), at most 2048 UTF-8 bytes on a character boundary. */
export function cleanMsg(text: string): string {
  // eslint-disable-next-line no-control-regex
  let clean = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  while (Buffer.byteLength(clean, 'utf8') > MAX_MSG_BYTES) {
    clean = Array.from(clean).slice(0, -1).join('');
  }
  return clean;
}

export function isEnabled(env: NodeJS.ProcessEnv, isTTY: boolean | undefined): boolean {
  if (!isTTY) return false;
  if (env.RADIUS_NO_PROGRAM_STATUS || env.CI || env.TERM === 'dumb') return false;
  return true;
}

/** `0x1234567890…abcd` → `0x1234…abcd`. */
export function shortHex(hex: string): string {
  return hex.length > 12 ? `${hex.slice(0, 6)}…${hex.slice(-4)}` : hex;
}

function isPromptCancel(e: unknown): boolean {
  return e instanceof Error && e.name === 'ExitPromptError';
}

export class ProgramStatus {
  private enabled = false;
  private write: (chunk: string) => void = () => {};
  private current: Report | undefined;
  private worked = false;
  private cancelled = false;
  private outcome: string | undefined;

  /** Turn reporting on for this process and report the outcome at exit. Call once, from main. */
  install({
    env = process.env,
    isTTY = process.stderr.isTTY,
    write = (chunk: string) => { writeSync(2, chunk); },
    onExit = (fn: (code: number) => void) => { process.once('exit', fn); },
  }: {
    env?: NodeJS.ProcessEnv;
    isTTY?: boolean;
    write?: (chunk: string) => void;
    onExit?: (fn: (code: number) => void) => void;
  } = {}): void {
    this.enabled = isEnabled(env, isTTY);
    if (!this.enabled) return;
    this.write = write;
    // Commands leave through process.exit as well as by returning; the exit event sees both. The
    // write is synchronous because nothing asynchronous runs once the process is exiting.
    onExit((code) => this.finish(code));
  }

  /** Report `blocked` while `prompt` is open, then put back what was showing before. */
  async whileBlocked<T>(kind: BlockedKind, msg: string, prompt: () => Promise<T>): Promise<T> {
    const previous = this.current;
    this.send({ state: 'blocked', kind, msg });
    try {
      const answer = await prompt();
      this.send(previous ?? { state: 'working' });
      return answer;
    } catch (e) {
      if (isPromptCancel(e)) this.cancel('Cancelled');
      else this.send(previous ?? { state: 'working' });
      throw e;
    }
  }

  /** The run is waiting on the network: report `working`; the run then ends with `done` or `error`. */
  working(msg: string): void {
    this.worked = true;
    this.send({ state: 'working', msg });
  }

  /** The text for `done` if the run succeeds, in the past tense: `Paid 0.001 SBC`. */
  succeeded(msg: string): void {
    this.outcome = msg;
  }

  /** The user declined or cancelled: report `idle` now and nothing more at exit. */
  cancel(msg: string): void {
    this.send({ state: 'idle', msg });
    this.cancelled = true;
  }

  /** Report the run's outcome. Called from the exit hook; exported for tests. */
  finish(code: number): void {
    if (!this.worked || this.cancelled) return;
    this.send(code === 0 ? { state: 'done', msg: this.outcome } : { state: 'error' });
  }

  private send(report: Report): void {
    if (!this.enabled || this.cancelled) return;
    this.current = report;
    try {
      this.write(formatReport(report));
    } catch {
      // A status report must never break the command.
    }
  }
}

/** The process-wide reporter. `index.ts` installs it. */
export const programStatus = new ProgramStatus();
