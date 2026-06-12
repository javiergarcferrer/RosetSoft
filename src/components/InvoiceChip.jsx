import { ReceiptText } from 'lucide-react';

/**
 * "Facturada" stamp for a quote that has a sale posting in the books — the
 * CRM-visible face of the accounting bridge (`resolveQuoteInvoiceStatus`).
 * `detail` also prints the NCF (builder header); lists keep the compact chip
 * with the NCF in the tooltip. Renders nothing while uninvoiced.
 */
export default function InvoiceChip({ invoice, detail = false, className = '' }) {
  if (!invoice) return null;
  const rejected = invoice.ecfStatus === 'rejected';
  const tone = rejected
    ? 'bg-rose-50 text-rose-700 border border-rose-200'
    : 'bg-emerald-50 text-emerald-700 border border-emerald-200';
  const label = rejected ? 'e-CF rechazado' : 'Facturada';
  return (
    <span className={`chip whitespace-nowrap ${tone} ${className}`}
      title={invoice.ncf ? `${label} · NCF ${invoice.ncf}` : label}>
      <ReceiptText size={10} /> {label}
      {detail && invoice.ncf && <span className="tabular-nums font-normal">· {invoice.ncf}</span>}
    </span>
  );
}
