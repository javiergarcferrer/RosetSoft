// Print a Gmail thread — a clean, paper-friendly rendition (subject, per-message
// From/To/date headers, bodies) printed through a hidden SANDBOXED iframe:
// no `allow-scripts`, so anything the email carries stays inert, exactly like
// the reading pane's iframe; `allow-modals` lets the print dialog open and
// `allow-same-origin` lets US (the parent) call contentWindow.print().

const esc = (s) => String(s || '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmtWhen(ms) {
  if (!ms) return '';
  try { return new Date(ms).toLocaleString('es-DO', { dateStyle: 'long', timeStyle: 'short' }); }
  catch { return new Date(ms).toISOString(); }
}

/** The printable HTML document for a resolved thread ({ subject, items }). */
export function buildPrintHtml(thread) {
  const items = thread?.items || [];
  const blocks = items.map((m) => {
    const sender = m.fromName ? `${esc(m.fromName)} &lt;${esc(m.fromEmail || '')}&gt;` : esc(m.fromEmail || '');
    const body = m.bodyHtml
      ? m.bodyHtml
      : `<pre style="white-space:pre-wrap;font:inherit;margin:0">${esc(m.bodyText || m.snippet || '')}</pre>`;
    const attachments = (m.attachments || []).map((a) => esc(a.filename || 'archivo')).join(' · ');
    return [
      '<section style="margin:0 0 28px;page-break-inside:avoid">',
      '<div style="border-bottom:1px solid #ddd;padding-bottom:6px;margin-bottom:10px;font-size:12px;color:#555">',
      `<div><strong style="color:#111">${m.direction === 'out' ? 'Yo' : sender}</strong></div>`,
      m.toEmail ? `<div>Para: ${esc(m.toEmail)}</div>` : '',
      `<div>${esc(fmtWhen(m.receivedAt || m.createdAt))}</div>`,
      attachments ? `<div>Adjuntos: ${attachments}</div>` : '',
      '</div>',
      `<div>${body}</div>`,
      '</section>',
    ].join('');
  }).join('');
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<title>${esc(thread?.subject || 'Correo')}</title>`,
    '<style>',
    'body{font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;font-size:13px;line-height:1.55;color:#1b1b1b;margin:28px;max-width:720px}',
    'img{max-width:100%;height:auto}table{max-width:100%}',
    'h1{font-size:18px;margin:0 0 20px}',
    '</style></head><body>',
    `<h1>${esc(thread?.subject || '(sin asunto)')}</h1>`,
    blocks,
    '</body></html>',
  ].join('');
}

/** Open the browser's print dialog with the thread's printable rendition. */
export function printGmailThread(thread) {
  if (typeof document === 'undefined') return;
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  frame.setAttribute('title', 'Imprimir correo');
  frame.style.position = 'fixed';
  frame.style.right = '0';
  frame.style.bottom = '0';
  frame.style.width = '0';
  frame.style.height = '0';
  frame.style.border = '0';
  frame.srcdoc = buildPrintHtml(thread);
  frame.onload = () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } catch { /* printing unavailable — nothing to clean beyond the frame */ }
    // Give the (blocking-in-most-engines) dialog time before tearing down.
    setTimeout(() => frame.remove(), 60_000);
  };
  document.body.appendChild(frame);
}
