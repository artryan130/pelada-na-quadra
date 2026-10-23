// CNPJ validation, including the alphanumeric format issued since July 2026:
// 12 characters [0-9A-Z] followed by 2 numeric check digits. Each character is
// worth its ASCII code minus 48, so digits keep their value and A=17 … Z=42.
// Mirrors public.is_valid_cnpj in the database.

const W1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
const W2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

export function normalizeCnpj(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

function checkDigit(chars: string, weights: number[]): number {
  const sum = weights.reduce((acc, w, i) => acc + (chars.charCodeAt(i) - 48) * w, 0);
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

export function isValidCnpj(value: string): boolean {
  const c = normalizeCnpj(value);
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  const d1 = checkDigit(c.slice(0, 12), W1);
  const d2 = checkDigit(c.slice(0, 12) + d1, W2);
  return c.endsWith(`${d1}${d2}`);
}

/** Formats as you type: 12.ABC.345/01DE-35 */
export function formatCnpj(value: string): string {
  const c = normalizeCnpj(value).slice(0, 14);
  const parts = [c.slice(0, 2), c.slice(2, 5), c.slice(5, 8), c.slice(8, 12), c.slice(12, 14)];
  let out = parts[0] ?? "";
  if (parts[1]) out += "." + parts[1];
  if (parts[2]) out += "." + parts[2];
  if (parts[3]) out += "/" + parts[3];
  if (parts[4]) out += "-" + parts[4];
  return out;
}
