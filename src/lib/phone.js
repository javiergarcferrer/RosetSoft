// Pure phone-number helpers for the WhatsApp integration (Model — no imports).
//
// WhatsApp addresses a chat by digits-only E.164 (no "+", no spaces). The
// Dominican market wrinkle: dealers type a bare 10-digit local number
// (area + line, e.g. "809 555 0100") and expect it to mean +1. Everything
// here normalizes through `waDigits`; thread/contact matching uses `phoneKey`
// (the last 10 digits) so "+18095550100", "18095550100" and "809-555-0100"
// all land in the SAME conversation.

/**
 * Digits-only number for the Cloud API / wa.me. A bare 10-digit local number
 * gets a leading "1" (+1, DR); anything that already carries a country code is
 * left as typed. Non-digits (spaces, dashes, "+") are stripped.
 */
export function waDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 ? `1${d}` : d;
}

/**
 * Matching key for grouping messages into threads and linking a number to a
 * customer/professional: the LAST 10 digits. Country-code variants (806… vs
 * 1809…) collapse onto one key; numbers shorter than 10 digits key as-is.
 */
export function phoneKey(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length > 10 ? d.slice(-10) : d;
}

/**
 * Human display for a normalized digits number. NANP numbers (1 + 10 digits —
 * the DR lives here) render as "+1 809 555 0100"; anything else gets a bare
 * "+" prefix rather than a wrong grouping.
 */
export function displayPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length === 11 && d.startsWith('1')) {
    return `+1 ${d.slice(1, 4)} ${d.slice(4, 7)} ${d.slice(7)}`;
  }
  if (d.length === 10) return `+1 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return `+${d}`;
}
