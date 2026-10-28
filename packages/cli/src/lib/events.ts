import { decodeEventLog, parseAbiItem, toEventSelector, type AbiEvent, type Address, type Hex } from 'viem';
import { errDetail } from './format.js';
import { findMatchingClose } from './signature.js';

export interface ParsedEvent {
  abiItem: AbiEvent;
  selector: Hex;
  /** Number of `indexed` params: a matching non-anonymous log has this many topics after topics[0]. */
  indexedCount: number;
}

/** The fields of a receipt log the decoder reads. */
export interface RawLog {
  address: Address;
  topics: readonly Hex[];
  data: Hex;
  logIndex: number | null;
}

export interface DecodedLogEntry {
  address: Address;
  logIndex: number | null;
  eventName: string;
  /** Keyed by param name, or by position for an unnamed param. */
  args: Record<string, unknown>;
}

/** An undecoded log, trimmed to the fields of `RawLog` (the receipt's log carries more). */
export type RawLogEntry = RawLog;

export type LogEntry = DecodedLogEntry | RawLogEntry;

export interface DecodeResult {
  logs: LogEntry[];
  /** Logs whose topics[0] matched a signature but whose topic count did not (usually a missing `indexed`). */
  warnings: string[];
}

/**
 * Parse a cast-style event signature: "Transfer(address indexed from, address indexed to, uint256 value)".
 * A leading `event ` is optional. `indexed` decides which params are read from topics and which from data.
 */
export function parseEventSignature(sig: string): ParsedEvent {
  const trimmed = sig.trim().replace(/^event\s+/, '');
  const invalid = (detail: string) =>
    new Error(`Invalid event signature: '${sig}': ${detail} (expected e.g. "Transfer(address indexed from, address indexed to, uint256 value)")`);
  const firstParen = trimmed.indexOf('(');
  if (firstParen === -1) throw invalid("no '(' found");
  if (!/^[a-zA-Z_$][\w$]*$/.test(trimmed.slice(0, firstParen).trim())) throw invalid('invalid event name');
  let argsClose: number;
  try {
    argsClose = findMatchingClose(trimmed, firstParen);
  } catch (err) {
    throw invalid(errDetail(err));
  }
  const tail = trimmed.slice(argsClose + 1).trim();
  if (tail) throw invalid(`unexpected trailing content '${tail}'`);
  let abiItem: AbiEvent;
  try {
    abiItem = parseAbiItem(`event ${trimmed}`) as AbiEvent;
  } catch (err) {
    throw invalid(errDetail(err));
  }
  return {
    abiItem,
    selector: toEventSelector(abiItem),
    indexedCount: abiItem.inputs.filter((input) => input.indexed).length,
  };
}

/**
 * Decode each log against the first event whose selector equals topics[0] and whose indexed-param
 * count matches the log's topics. Logs that match no event are returned raw, never dropped.
 * Which params are indexed is taken from the signature: a log does not record it, so a signature that
 * marks the same number of params `indexed` but different ones decodes without error, to wrong values.
 */
export function decodeLogs(logs: readonly RawLog[], events: readonly ParsedEvent[]): DecodeResult {
  const warnings: string[] = [];
  const out = logs.map((log): LogEntry => {
    const raw: RawLogEntry = { address: log.address, logIndex: log.logIndex, topics: log.topics, data: log.data };
    const candidates = events.filter((e) => e.selector.toLowerCase() === log.topics[0]?.toLowerCase());
    if (candidates.length === 0) return raw;
    const event = candidates.find((e) => e.indexedCount === log.topics.length - 1);
    if (!event) {
      const declared = [...new Set(candidates.map((e) => e.indexedCount))].join(' or ');
      warnings.push(
        `log ${log.logIndex ?? '?'} matches the ${candidates[0].abiItem.name} selector but has ${log.topics.length - 1} indexed topics; ` +
          `the signature declares ${declared}. Mark the indexed params with \`indexed\`. Left undecoded.`,
      );
      return raw;
    }
    let decoded;
    try {
      decoded = decodeEventLog({ abi: [event.abiItem], topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
    } catch (err) {
      warnings.push(`log ${log.logIndex ?? '?'} matches the ${event.abiItem.name} selector but its data does not decode: ${errDetail(err)}. Left undecoded.`);
      return raw;
    }
    return { address: log.address, logIndex: log.logIndex, eventName: event.abiItem.name, args: namedArgs(event.abiItem, decoded.args) };
  });
  return { logs: out, warnings };
}

/**
 * Args in signature order, keyed by name, or by position when unnamed. viem returns an array when any
 * param is unnamed, and otherwise an object with the indexed params first.
 */
function namedArgs(event: AbiEvent, args: unknown): Record<string, unknown> {
  const byName = (args ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    event.inputs.map((input, i) => [input.name || String(i), Array.isArray(args) ? args[i] : byName[input.name!]]),
  );
}

export function isDecoded(entry: LogEntry): entry is DecodedLogEntry {
  return 'eventName' in entry;
}
