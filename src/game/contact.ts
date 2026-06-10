/** Decode the obfuscated phone ("0x2507B120E" → "+91 99401 77422").
 *
 * The number is stored encoded so it never appears as plain text in the repo or
 * the built bundle; the game decodes it at runtime only once the player has earned
 * it. Returns '' for anything non-numeric or non-positive. */
export function decodePhone(encoded: string): string {
  const n = Number(encoded);
  if (!Number.isFinite(n) || n <= 0) return '';
  const local = String(n).replace(/(\d{5})(\d{5})$/, '$1 $2');
  return `+91 ${local}`;
}
