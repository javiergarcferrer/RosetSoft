/**
 * Spanish amount-in-words for DOP invoices — e.g. montoEnLetras(11800) →
 * "ONCE MIL OCHOCIENTOS PESOS CON 00/100". "Son: …" in letras is a standard
 * element of a Dominican factura (and a worldwide invoicing best practice).
 * Pure: no deps.
 */
const UNIDADES = [
  '', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve',
  'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete',
  'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés',
  'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve',
];
const DECENAS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const CENTENAS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

/** 0–999 in words. */
function centenasALetras(n) {
  if (n === 0) return '';
  if (n === 100) return 'cien';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  let s = CENTENAS[c];
  if (resto > 0) {
    if (resto < 30) s = `${s} ${UNIDADES[resto]}`.trim();
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      s = `${s} ${DECENAS[d]}${u > 0 ? ` y ${UNIDADES[u]}` : ''}`.trim();
    }
  }
  return s.trim();
}

/** A non-negative integer in words ("once mil ochocientos"). */
export function enteroALetras(n) {
  const v = Math.floor(Math.abs(Number(n) || 0));
  if (v === 0) return 'cero';
  const millones = Math.floor(v / 1000000);
  const miles = Math.floor((v % 1000000) / 1000);
  const resto = v % 1000;
  let s = '';
  if (millones > 0) s += millones === 1 ? 'un millón' : `${centenasALetras(millones)} millones`;
  if (miles > 0) s += `${s ? ' ' : ''}${miles === 1 ? 'mil' : `${centenasALetras(miles)} mil`}`;
  if (resto > 0) s += `${s ? ' ' : ''}${centenasALetras(resto)}`;
  return s.trim();
}

/**
 * A DOP amount in invoice words: "MIL OCHOCIENTOS PESOS CON 00/100". Rounds to
 * cents (carry-safe), apocopates the trailing "uno" before "PESOS"
 * (un peso, veintiún pesos, ciento un pesos), and singularizes "PESO" at 1.
 */
export function montoEnLetras(amount) {
  const cents = Math.round(Math.max(0, Number(amount) || 0) * 100);
  const entero = Math.floor(cents / 100);
  const centavos = cents % 100;
  const letras = enteroALetras(entero)
    .replace(/veintiuno$/, 'veintiún')
    .replace(/uno$/, 'un');
  const moneda = entero === 1 ? 'PESO' : 'PESOS';
  return `${letras.toUpperCase()} ${moneda} CON ${String(centavos).padStart(2, '0')}/100`;
}
