/**
 * Renders a name in the company wordmark face (Rauschen B, Tailwind
 * `font-wordmark`) whenever that name IS the Alcover brand — so anywhere
 * "ALCOVER" / "ALCOVER SRL" surfaces as dynamic data (a customer that is the
 * house account, the configured company name, …) it reads as the brand mark,
 * not plain body type. Any other name renders untouched in the inherited font.
 *
 * Use it for VALUES that may or may not be the brand (customer/company names).
 * For the literal brand mark (the logo block) just apply `font-wordmark`
 * directly — there's no need to guess.
 */
const BRAND_RE = /^\s*alcover\b/i;

export function isBrandName(name) {
  return typeof name === 'string' && BRAND_RE.test(name);
}

export default function BrandName({ name, className = '' }) {
  if (name == null || name === '') return null;
  const cls = `${isBrandName(name) ? 'font-wordmark' : ''} ${className}`.trim();
  return cls ? <span className={cls}>{name}</span> : <>{name}</>;
}
