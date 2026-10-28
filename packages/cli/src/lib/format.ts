/** Format a numeric (or formatUnits-string) value as a USD-style 6-decimal string. */
export function formatUsd(value: string | number): string {
  return Number(value).toFixed(6);
}

/** A one-line message for an error: viem's `shortMessage` when present, else the first line of `message`. */
export function errDetail(err: unknown): string {
  if (!(err instanceof Error)) return String(err).split('\n')[0];
  return ((err as { shortMessage?: string }).shortMessage ?? err.message).split('\n')[0];
}

/** Stringify with bigints as decimal strings — viem returns lots of bigints. */
export function jsonStringify(value: unknown, indent = 2): string {
  return JSON.stringify(
    value,
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    indent,
  );
}

export function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(jsonStringify(value));
    return;
  }
  if (value === undefined || value === null) {
    console.log('');
    return;
  }
  if (typeof value === 'bigint') {
    console.log(value.toString());
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    console.log(String(value));
    return;
  }
  console.log(jsonStringify(value));
}
