import { parseAbiItem, type AbiFunction } from 'viem';

export interface ParsedSignature {
  abiItem: AbiFunction;
  /** Top-level return-type strings, e.g. ['uint256'] or ['address','bool']. Empty if no returns clause. */
  returnTypes: string[];
  /** True if the cast-style signature included a returns paren group. */
  isView: boolean;
}

export function findMatchingClose(s: string, openIdx: number): number {
  if (s[openIdx] !== '(') throw new Error('Expected opening paren');
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  throw new Error('Unbalanced parentheses');
}

function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      const token = s.slice(start, i).trim();
      if (token) out.push(token);
      start = i + 1;
    }
  }
  const tail = s.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Parse a cast-style human-readable function signature.
 *
 *   "transfer(address,uint256)"        → write form, no returns
 *   "balanceOf(address)(uint256)"      → view form, returns ['uint256']
 *   "foo(uint256,bytes32)(address,bool)" → returns ['address','bool']
 *
 * Tuple types (parens) inside args/returns are supported via paren-balanced parsing.
 */
export function parseCastSignature(sig: string): ParsedSignature {
  const trimmed = sig.trim();
  const firstParen = trimmed.indexOf('(');
  if (firstParen === -1) {
    throw new Error(`Invalid signature (no '(' found): ${sig}`);
  }
  const name = trimmed.slice(0, firstParen).trim();
  if (!/^[a-zA-Z_$][\w$]*$/.test(name)) {
    throw new Error(`Invalid function name in signature: ${sig}`);
  }

  const argsClose = findMatchingClose(trimmed, firstParen);
  const argsGroup = trimmed.slice(firstParen, argsClose + 1);

  const after = trimmed.slice(argsClose + 1).trim();
  let returnsGroup = '';
  if (after.startsWith('(')) {
    const retClose = findMatchingClose(after, 0);
    returnsGroup = after.slice(0, retClose + 1);
    const tail = after.slice(retClose + 1).trim();
    if (tail.length > 0) {
      throw new Error(`Unexpected trailing content after returns group: '${tail}'`);
    }
  } else if (after.length > 0) {
    throw new Error(`Unexpected trailing content after args group: '${after}'`);
  }

  const isView = returnsGroup.length > 0;
  const viemSig = isView
    ? `function ${name}${argsGroup} view returns ${returnsGroup}`
    : `function ${name}${argsGroup}`;

  const abiItem = parseAbiItem(viemSig) as AbiFunction;
  const returnTypes = isView ? splitTopLevel(returnsGroup.slice(1, -1)) : [];

  return { abiItem, returnTypes, isView };
}

/** Coerce a string CLI arg into the JS value viem expects for the given Solidity type. */
export function coerceArg(value: string, type: string): unknown {
  const t = type.trim();

  if (t.endsWith(']')) {
    // Array type — split top-level commas after stripping outer brackets if present.
    const inner = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    const elemType = t.replace(/\[[^\]]*\]$/, '');
    return splitTopLevel(inner).map((part) => coerceArg(part.trim(), elemType));
  }
  if (t.startsWith('(') && t.endsWith(')')) {
    // Tuple — expect JSON array form.
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(`Tuple arg for type ${t} must be JSON, got: ${value}`);
    }
    if (!Array.isArray(parsed)) throw new Error(`Tuple arg for type ${t} must be a JSON array.`);
    const inner = splitTopLevel(t.slice(1, -1));
    return parsed.map((v, i) => coerceArg(String(v), inner[i] ?? 'string'));
  }
  if (t === 'bool') {
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`bool arg must be 'true' or 'false', got: ${value}`);
  }
  if (t === 'address') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error(`address arg must be 0x + 40 hex chars: ${value}`);
    }
    return value;
  }
  if (t === 'string') return value;
  if (t.startsWith('bytes')) {
    if (!value.startsWith('0x')) {
      throw new Error(`bytes arg must start with 0x: ${value}`);
    }
    return value;
  }
  if (t.startsWith('uint') || t.startsWith('int')) {
    try {
      return BigInt(value);
    } catch {
      throw new Error(`Could not parse ${t} arg as integer: ${value}`);
    }
  }
  // Fallback — pass through; viem will validate.
  return value;
}
