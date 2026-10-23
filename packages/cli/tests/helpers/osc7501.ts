/**
 * Conformance checks for the OSC 7501 Program Status Protocol, as radius-cli uses it.
 * Spec: https://www.superlogical.com/rex/docs/build/program-status
 * Spec revision checked against: 0.4 (2026-10-10). When you re-read the spec, update this line, so a
 * later reader can tell whether it has moved. CI never fetches it.
 *
 * Stricter than the spec, on purpose, because radius-cli promises more: only the keys state, app,
 * kind and msg; canonical padded base64; ST written as ESC \ (the spec also allows BEL); `blocked`
 * never the last report; nothing after a cancel's `idle`; a run that waited on the network always
 * ends with done, error or idle. A failure here is a CLI bug or a deliberate change to what the CLI
 * promises, not necessarily a spec violation.
 */

export interface ParsedReport {
  state: string;
  app?: string;
  kind?: string;
  /** Decoded message, or undefined when the report has none. */
  msg?: string;
  /** The raw `msg` field, for validating the encoding. */
  rawMsg?: string;
  unknownKeys: string[];
  /** Size of the whole sequence on the wire. */
  bytes: number;
}

const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error']);
const KINDS = new Set(['permission', 'question', 'auth']);
const SEQUENCE = /\x1b\]7501;([^\x07\x1b]*)\x1b\\/g;
const MAX_MSG_BYTES = 2048;
const MAX_MSG_ENCODED_BYTES = 2732;
const MAX_SEQUENCE_BYTES = 4096;
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/;

/** Pull every OSC 7501 report out of captured terminal bytes. Reports a stray or unterminated one. */
export function parseReports(stream: string): { reports: ParsedReport[]; problems: string[] } {
  const problems: string[] = [];
  const reports: ParsedReport[] = [];
  for (const match of stream.matchAll(SEQUENCE)) {
    const fields = new Map<string, string>();
    const unknownKeys: string[] = [];
    for (const pair of match[1].split(':')) {
      const eq = pair.indexOf('=');
      if (eq < 1) {
        problems.push(`malformed field "${pair}" in "${match[1]}"`);
        continue;
      }
      const key = pair.slice(0, eq);
      fields.set(key, pair.slice(eq + 1));
      if (!['state', 'app', 'kind', 'msg'].includes(key)) unknownKeys.push(key);
    }
    const rawMsg = fields.get('msg');
    reports.push({
      state: fields.get('state') ?? '',
      app: fields.get('app'),
      kind: fields.get('kind'),
      rawMsg,
      msg: rawMsg === undefined ? undefined : Buffer.from(rawMsg, 'base64').toString('utf8'),
      unknownKeys,
      bytes: Buffer.byteLength(match[0], 'utf8'),
    });
  }
  const opened = stream.split('\x1b]7501').length - 1;
  if (opened !== reports.length) {
    problems.push(`${opened - reports.length} OSC 7501 sequence(s) not terminated with ST (ESC \\)`);
  }
  return { reports, problems };
}

/**
 * Check one run's reports against the protocol. Returns the violations; an empty list means conformant.
 */
export function violations(reports: ParsedReport[], app = 'radius-cli'): string[] {
  const out: string[] = [];
  reports.forEach((r, i) => {
    const at = `report ${i + 1} (${r.state || 'no state'})`;
    if (!STATES.has(r.state)) out.push(`${at}: state must be one of ${[...STATES].join(', ')}`);
    if (r.app !== app) out.push(`${at}: app must be "${app}", got "${r.app ?? ''}"`);
    if (r.app !== undefined && !APP_PATTERN.test(r.app)) out.push(`${at}: app must match [A-Za-z0-9_.+-]{1,32}`);
    if (r.bytes > MAX_SEQUENCE_BYTES) out.push(`${at}: sequence is over ${MAX_SEQUENCE_BYTES} bytes`);
    if (r.unknownKeys.length) out.push(`${at}: unknown field(s) ${r.unknownKeys.join(', ')}`);
    if (r.kind !== undefined) {
      if (r.state !== 'blocked') out.push(`${at}: kind is only valid with state=blocked`);
      if (!KINDS.has(r.kind)) out.push(`${at}: kind must be one of ${[...KINDS].join(', ')}`);
    }
    if (r.state === 'blocked' && r.kind === undefined) out.push(`${at}: blocked needs a kind`);
    if (r.rawMsg !== undefined) {
      if (r.rawMsg === '') out.push(`${at}: empty msg; leave the field out`);
      else if (Buffer.from(r.msg ?? '', 'utf8').toString('base64') !== r.rawMsg) {
        out.push(`${at}: msg is not canonical base64 of valid UTF-8`);
      }
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f-\x9f]/.test(r.msg ?? '')) out.push(`${at}: msg contains a control character`);
      if (Buffer.byteLength(r.msg ?? '', 'utf8') > MAX_MSG_BYTES) out.push(`${at}: msg is over ${MAX_MSG_BYTES} bytes`);
      if (r.rawMsg.length > MAX_MSG_ENCODED_BYTES) out.push(`${at}: encoded msg is over ${MAX_MSG_ENCODED_BYTES} bytes`);
    }
  });

  reports.forEach((r, i) => {
    const next = reports[i + 1];
    if (r.state === 'blocked') {
      if (!next) out.push(`report ${i + 1}: run ended while still blocked`);
      else if (!['working', 'idle', 'done', 'error'].includes(next.state)) {
        out.push(`report ${i + 1}: blocked must be followed by working, idle, done or error, got ${next.state}`);
      }
    }
    if (r.state === 'idle' && next) out.push(`report ${i + 1}: nothing may follow a cancel (idle)`);
  });

  // A run that waited on the network (working with a message) must say how it ended. A restored
  // `working` with no message after a prompt is fine: the terminal drops it at exit.
  const waited = reports.some((r) => r.state === 'working' && r.msg !== undefined);
  const last = reports.at(-1);
  if (waited && last && !['done', 'error', 'idle'].includes(last.state)) {
    out.push(`the run waited on the network but ended on "${last.state}"; it must end with done, error or idle`);
  }
  return out;
}

/** Parse and check in one step. Throws with the fix in the message, which is what an agent reads first. */
export function expectConformant(stream: string): ParsedReport[] {
  const { reports, problems } = parseReports(stream);
  const found = [...problems, ...violations(reports)];
  if (found.length) {
    throw new Error(
      `OSC 7501 output does not follow the Program Status Protocol:\n  - ${found.join('\n  - ')}\n` +
        'Fix the CLI, not this check, unless the CLI deliberately changed what it reports. ' +
        'Prompts go through programStatus.whileBlocked; network waits call programStatus.working then succeeded. ' +
        'See .claude/skills/program-status/SKILL.md.',
    );
  }
  return reports;
}
