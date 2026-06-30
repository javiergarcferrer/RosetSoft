/**
 * Gmail — the official multi-colour envelope logo (Google product icon). Each
 * segment carries its own brand fill (red / blue / green / yellow), so unlike a
 * monochrome lucide glyph it reads as Gmail itself in the nav, matching the
 * WhatsApp / Instagram channel marks. Lucide-compatible API (size / className,
 * rest spread); pure lib module (automatic JSX runtime, no React import).
 */
export default function GmailIcon({ size = 24, className = '', ...rest }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      className={className}
      aria-hidden="true"
      {...rest}
    >
      {/* White envelope body so the mark reads correctly on the dark sidebar
          (the colour segments only draw the borders; the interior is negative
          space that would otherwise show the dark chrome through). */}
      <rect x="3" y="8" width="42" height="32" rx="4.5" fill="#fff" />
      <path fill="#4caf50" d="M45 16.2l-5 2.75-5 4.75L35 40h7c1.657 0 3-1.343 3-3V16.2z" />
      <path fill="#1e88e5" d="M3 16.2l3.614 1.71L13 23.7V40H6c-1.657 0-3-1.343-3-3V16.2z" />
      <polygon fill="#e53935" points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17" />
      <path fill="#c62828" d="M3 12.298V16.2l10 7.5V11.2L9.876 8.859C9.132 8.301 8.228 8 7.298 8 4.924 8 3 9.924 3 12.298z" />
      <path fill="#fbc02d" d="M45 12.298V16.2l-10 7.5V11.2l3.124-2.341C38.868 8.301 39.772 8 40.702 8 43.076 8 45 9.924 45 12.298z" />
    </svg>
  );
}
