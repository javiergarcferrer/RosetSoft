/**
 * Togo — the Ligne Roset signature: a low, legless, quilted-tube lounge. lucide
 * has no Togo glyph, so this is a custom one: two stacked rounded cushion "banks"
 * (backrest + seat) scored with vertical channels, echoing the Togo's ribbed
 * silhouette. Lucide-compatible API (size / strokeWidth / className, rest spread)
 * so it drops in anywhere a lucide icon goes — e.g. the sidebar nav. Uses the
 * automatic JSX runtime (no React import) so it stays a pure lib module.
 */
export default function TogoIcon({ size = 24, strokeWidth = 1.75, className = '', ...rest }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {/* backrest bank (raised) */}
      <rect x="4.5" y="6" width="15" height="5" rx="2.5" />
      {/* seat bank (low + wider — sits on the floor, no legs) */}
      <rect x="3" y="11.5" width="18" height="5.5" rx="2.75" />
      {/* quilted channels */}
      <path d="M9.5 6.8v3.4M14.5 6.8v3.4" />
      <path d="M9 12.3v3.9M15 12.3v3.9" />
    </svg>
  );
}
