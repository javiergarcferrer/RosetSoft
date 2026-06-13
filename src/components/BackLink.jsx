import { ArrowLeft } from 'lucide-react';
import { useGoBack } from '../context/NavMemory.jsx';

/**
 * The "Volver a …" affordance, made trustworthy. It used to be a hard `<Link>`
 * to a fixed section list, so arriving at a detail page from anywhere else (a
 * quote, the ⌘K search, a WhatsApp deep link) and hitting Back dumped you on
 * the list instead of where you actually were. Now it steps back through real
 * history when there's an in-app origin (`useGoBack`), and only falls back to
 * `to` (the section list) on a fresh load / deep link.
 *
 * `to` is the fallback path; `children` is the label ("Volver a profesionales").
 */
export default function BackLink({ to, children, className = 'back-link' }) {
  const goBack = useGoBack();
  return (
    <button type="button" onClick={() => goBack(to)} className={className}>
      <ArrowLeft size={12} /> {children}
    </button>
  );
}
