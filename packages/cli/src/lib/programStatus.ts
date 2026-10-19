/**
 * Program Status Protocol (OSC 7501): tells the terminal whether radius-cli is working, waiting on
 * the user, or finished, so a tab in the background can show "waiting on you" at a payment prompt.
 * Spec: https://gist.github.com/mitchellh/7acae3abd8355c1c00287d67e96c913a
 *
 * Reports go to stderr only when it is a terminal, so `--json` output, pipes, CI logs and agents
 * reading our output never see escape bytes. Terminals without support ignore unknown OSCs, so
 * there is no support query. Nothing is sent until a run waits on the user or the network: a quick
 * read leaves no record behind, and a run that reported something ends with `done` or `error`.
 */

export type BlockedKind = 'permission' | 'question' | 'auth';

type State = 'idle' | 'working' | 'done' | 'blocked' | 'error';

interface Report {
  state: State;
  kind?: BlockedKind;
  msg?: string;
}

export interface StatusStream {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

const APP = 'radius-cli';
// The spec caps a decoded msg at 2048 bytes; ours are fixed templates far below it.
const MAX_MSG_CHARS = 200;

/** Encode one report. Exported for tests. */
export function encodeReport({ state, kind, msg }: Report): string {
  const pairs = [`state=${state}`, `app=${APP}`];
  if (kind) pairs.push(`kind=${kind}`);
  if (msg) pairs.push(`msg=${Buffer.from(oneLine(msg), 'utf8').toString('base64')}`);
  return `\x1b]7501;${pairs.join(':')}\x1b\\`;
}

/** Strip control characters (C0, DEL, C1) and cut to one short line. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\x00-\x1f\x7f-\x9f]+/g, ' ').trim();
  return clean.length > MAX_MSG_CHARS ? `${clean.slice(0, MAX_MSG_CHARS - 1)}…` : clean;
}

export function statusEnabled(stream: StatusStream, env: NodeJS.ProcessEnv): boolean {
  if (!stream.isTTY) return false;
  if (env.RADIUS_NO_PROGRAM_STATUS) return false;
  if (env.TERM === 'dumb') return false;
  return true;
}

export class ProgramStatus {
  private readonly enabled: boolean;
  private reported = false;

  constructor(
    private readonly stream: StatusStream = process.stderr,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.enabled = statusEnabled(stream, env);
  }

  /** The run is waiting on the network: a transaction, a settlement, a faucet drip. */
  working(msg?: string): void {
    this.send({ state: 'working', msg });
  }

  /** The run is waiting on the user. Call `working()`, `idle()` or `finish()` once they answer. */
  blocked(kind: BlockedKind, msg: string): void {
    this.send({ state: 'blocked', kind, msg });
  }

  /** The user cancelled or declined; nothing is in progress. */
  idle(msg?: string): void {
    if (this.reported) this.send({ state: 'idle', msg });
  }

  /** Final report just before exit, only if the run reported anything before. */
  finish(ok: boolean, msg?: string): void {
    if (this.reported) this.send({ state: ok ? 'done' : 'error', msg });
  }

  /**
   * Wrap a prompt: report `blocked` while it is open, then `working` once answered. A cancelled
   * prompt (Ctrl-C) reports `idle` and rethrows.
   */
  async whileBlocked<T>(kind: BlockedKind, msg: string, prompt: () => Promise<T>): Promise<T> {
    this.blocked(kind, msg);
    try {
      const answer = await prompt();
      this.working();
      return answer;
    } catch (e) {
      this.idle();
      throw e;
    }
  }

  private send(report: Report): void {
    if (!this.enabled) return;
    this.reported = true;
    this.stream.write(encodeReport(report));
  }
}

/** The process-wide reporter on stderr. */
export const programStatus = new ProgramStatus();
