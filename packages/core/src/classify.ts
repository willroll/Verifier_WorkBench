import type { ObligationKind } from '@verifier/shared';

/**
 * Maps an engine's property description (plus the class segment of its id,
 * e.g. "array_bounds" in "store.array_bounds.1") onto a short obligation kind.
 * The function-name segment of the id is deliberately ignored: a function
 * called `shift_left` must not turn its overflow into a shift finding.
 */
export function classify(description: string, propertyId = ''): ObligationKind {
  const segments = propertyId.split('.');
  const cls = segments.length >= 3 ? (segments[segments.length - 2] ?? '') : '';
  const d = `${description} ${cls}`.toLowerCase();
  if (d.includes('unwinding assertion') || cls === 'unwind') return 'unwind';
  // CBMC reports narrowing as "arithmetic overflow on signed type conversion".
  if (d.includes('conversion')) return 'conversion';
  if (d.includes('shift')) return 'shift';
  if (d.includes('division by zero') || d.includes('division-by-zero') || d.includes('div-by-zero'))
    return 'div-by-zero';
  if (d.includes('overflow')) return 'overflow';
  // Before bounds: "dereference failure: pointer outside object bounds" is a pointer problem.
  if (d.includes('dereference') || d.includes('overlap')) return 'pointer';
  // CBMC's library preconditions, e.g. "memcpy destination region writeable": a buffer overrun.
  if (d.includes('region')) return 'bounds';
  if (d.includes('bound') || d.includes('array') || d.includes('index')) return 'bounds';
  if (d.includes('pointer') || d.includes('null') || d.includes('invalid')) return 'pointer';
  return 'assertion';
}

/** "00010000" or "0001 0000" -> "0x10"; undefined for anything that is not a bit string. */
export function bitsToHex(bits: string | undefined): string | undefined {
  if (!bits) return undefined;
  const b = bits.replace(/[\s_]/g, '');
  if (!/^[01]+$/.test(b)) return undefined;
  const padded = b.padStart(Math.ceil(b.length / 4) * 4, '0');
  let hex = '';
  for (let i = 0; i < padded.length; i += 4) hex += parseInt(padded.slice(i, i + 4), 2).toString(16);
  return `0x${hex}`;
}
