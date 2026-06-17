// Quote email Model — composes the subject + HTML/plain body for sending a
// quote to a client (or professional) by Gmail. Pure: no React, no network. The
// caller (SendQuoteModal) hands it the resolved share URL and/or signals a PDF
// is attached, and sends the result through lib/google.sendGmail.

/** Escape a string for safe interpolation into the HTML body. */
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build a quote email.
 * @param {object}  opts
 * @param {object}  opts.quote      the quote (for its number)
 * @param {object}  opts.recipient  customer or professional (for the greeting)
 * @param {object}  opts.settings   app settings (company name / signature)
 * @param {string}  [opts.url]      the public interactive quote link, if any
 * @param {boolean} [opts.hasPdf]   whether a PDF is attached
 * @returns {{subject:string, html:string, text:string}}
 */
export function buildQuoteEmail({ quote, recipient, settings, url = '', hasPdf = false }) {
  const company = settings?.companyName || 'Alcover';
  const numberTag = quote?.number ? ` #${quote.number}` : '';
  const greetingName = recipient?.contactName || recipient?.name || recipient?.company || '';
  const subject = `Cotización${numberTag} — ${company}`;

  const hi = greetingName ? `Hola ${greetingName},` : 'Hola,';
  const lead = `Adjuntamos${hasPdf ? ' el PDF de' : ''} tu cotización${numberTag} de ${company}.`;
  const linkLine = url
    ? `También puedes verla en línea${hasPdf ? '' : ' y elegir telas'} aquí: ${url}`
    : '';
  const sign = `Saludos,\n${company}`;
  const text = [hi, '', lead, linkLine, '', sign].filter((l) => l !== null).join('\n');

  const linkHtml = url
    ? `<p style="margin:0 0 16px"><a href="${esc(url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">Ver la cotización en línea</a></p>`
    : '';
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.55">
  <p style="margin:0 0 12px">${esc(hi)}</p>
  <p style="margin:0 0 16px">${esc(lead)}</p>
  ${linkHtml}
  <p style="margin:24px 0 0;color:#666;font-size:13px">${esc(company)}</p>
</div>`;

  return { subject, html, text };
}
