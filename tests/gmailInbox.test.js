/**
 * Tests for src/core/crm/views/gmailInbox.js — the Gmail inbox VM.
 *
 * Pins the derivations the feature is built on: BRAND classification
 * (sender-domain rules + manual override), INVOICE detection, the thread
 * grouping / unread / archived-visibility / brand-of-thread roll-up the inbox
 * list renders, the per-tab counts, and the list-quality helpers (relative
 * dates, avatar initials/colors, the load-older pagination cursor).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBrand, isInvoiceEmail, parseInvoiceAmount,
  resolveGmailThreads, resolveGmailThread, resolveGmailInvoices, resolveGmailTabCounts,
  resolveReplyDraft, replySubject, forwardSubject, resolveForwardDraft,
  isEmailAddress, resolveEmailRecipients,
  formatGmailDate, senderInitials, avatarColorIndex, oldestGmailAt, olderMailQuery,
  GMAIL_BRAND_OTHER, GMAIL_BRAND_TABS,
  GMAIL_CAT_PROVEEDORES, GMAIL_CAT_FINANZAS, GMAIL_CAT_OPERACIONES, GMAIL_CAT_BOLETINES,
} from '../src/core/crm/views/gmailInbox.js';

const NOW = Date.parse('2026-06-10T12:00:00Z');
const MIN = 60_000;
// Default: an unread inbound message sitting in the inbox (INBOX label) — the
// visibility rule hides inbound threads whose messages have all lost INBOX.
const msg = (o) => ({ id: 'm', profileId: 'team', threadId: 't', direction: 'in', isRead: false, labelIds: ['INBOX'], ...o });

// ── classifyBrand (intent-based categories) ─────────────────────────────────
test('classifyBrand: Ligne Roset is the golden lane — any Roset domain', () => {
  assert.equal(classifyBrand(msg({ fromEmail: 'lllamas@roset.fr' })), 'ligne-roset');
  assert.equal(classifyBrand(msg({ fromEmail: 'egamboli@rosetusa.com' })), 'ligne-roset');
});

test('classifyBrand: a Ligne Roset newsletter still stays in the golden lane', () => {
  // A bulk-looking subject from a Roset domain must NOT leak into boletines.
  const m = msg({ fromEmail: 'sgreenspan@rosetusa.com', subject: 'Ligne Roset Mini-Newsletter', snippet: 'unsubscribe' });
  assert.equal(classifyBrand(m), 'ligne-roset');
});

test('classifyBrand: other design houses & suppliers → proveedores', () => {
  assert.equal(classifyBrand(msg({ fromEmail: 'orders@anthomdesignhouse.com' })), GMAIL_CAT_PROVEEDORES);
  assert.equal(classifyBrand(msg({ fromEmail: 'brbe@carlhansen.dk' })), GMAIL_CAT_PROVEEDORES);
});

test('classifyBrand: money by known sender → finanzas (even with no keyword)', () => {
  assert.equal(classifyBrand(msg({ fromEmail: 'vmojica@a24.com.do', subject: 'Solicitud' })), GMAIL_CAT_FINANZAS);
  assert.equal(classifyBrand(msg({ fromEmail: 'jjimenez@delllano.com.do', subject: 'Renovación' })), GMAIL_CAT_FINANZAS);
});

test('classifyBrand: money by wording from an unknown sender → finanzas', () => {
  assert.equal(classifyBrand(msg({ fromEmail: 'ventas@nuevoproveedor.do', subject: 'Su factura de mayo' })), GMAIL_CAT_FINANZAS);
});

test('classifyBrand: operations by sender and by wording → operaciones', () => {
  assert.equal(classifyBrand(msg({ fromEmail: 'maria.marte@totalenergies.com', subject: 'Tarjetas' })), GMAIL_CAT_OPERACIONES);
  assert.equal(classifyBrand(msg({ fromEmail: 'rrhh@empresa.do', subject: 'Perfiles para armador' })), GMAIL_CAT_OPERACIONES);
});

test('classifyBrand: mass-mailings → boletines (localpart, Promotions label, phrase)', () => {
  assert.equal(classifyBrand(msg({ fromEmail: 'news@news.kvadrat.dk', subject: 'Summer launches' })), GMAIL_CAT_BOLETINES);
  assert.equal(classifyBrand(msg({ fromEmail: 'someone@bank.do', subject: 'Promo', labelIds: ['CATEGORY_PROMOTIONS'] })), GMAIL_CAT_BOLETINES);
  assert.equal(classifyBrand(msg({ fromEmail: 'hola@tienda.do', subject: 'Oferta', snippet: 'Unsubscribe here' })), GMAIL_CAT_BOLETINES);
});

test('classifyBrand: a supplier mass-mailing goes to boletines, not proveedores', () => {
  // Same brand (DWR), but a newsletter sender — bulk wins over the supplier lane.
  assert.equal(classifyBrand(msg({ fromEmail: 'news@dwr.com', subject: 'Sale' })), GMAIL_CAT_BOLETINES);
  // …while a real person at the same house lands in proveedores.
  assert.equal(classifyBrand(msg({ fromEmail: 'james@anthomdesignhouse.com', subject: 'Re: PO' })), GMAIL_CAT_PROVEEDORES);
});

test('classifyBrand falls back to otros for an unknown, contentless sender', () => {
  assert.equal(classifyBrand(msg({ fromEmail: 'someone@randomdomain.com' })), GMAIL_BRAND_OTHER);
});

test('classifyBrand: bulk localparts are token-bounded — a real supplier person is never demoted', () => {
  // 'product' the token matches product@ / product-updates@ …
  assert.equal(classifyBrand(msg({ fromEmail: 'product-updates@randomshop.com' })), GMAIL_CAT_BOLETINES);
  // … but production@ at a KNOWN supplier is real correspondence, not a newsletter.
  assert.equal(classifyBrand(msg({ fromEmail: 'production@taillardat.fr', subject: 'Re: chairs order' })), GMAIL_CAT_PROVEEDORES);
});

test('classifyBrand: a named ops biller from a noreply@ address stays in operaciones', () => {
  // The fleet-fuel statement — a noreply localpart must not demote a NAMED ops sender.
  assert.equal(classifyBrand(msg({ fromEmail: 'noreply@totalenergies.com', subject: 'Estado de cuenta flota' })), GMAIL_CAT_OPERACIONES);
});

test('parseInvoiceAmount reads European formats (dots-as-thousands, comma decimal)', () => {
  const eu = parseInvoiceAmount(msg({ subject: 'Facture', snippet: 'Total EUR 1.234,56' }));
  assert.deepEqual(eu, { amount: 1234.56, currency: 'EUR' });
  const bare = parseInvoiceAmount(msg({ subject: 'Facture', snippet: 'Montant: €1.500' }));
  assert.deepEqual(bare, { amount: 1500, currency: 'EUR' });
});

test('classifyBrand: a manual override to a current category wins over the rules', () => {
  // Sender would classify as ligne-roset, but the override re-files it.
  assert.equal(classifyBrand(msg({ fromEmail: 'lllamas@roset.fr', brand: GMAIL_CAT_FINANZAS })), GMAIL_CAT_FINANZAS);
});

test('classifyBrand: a stale override (retired brand) is ignored and re-classifies', () => {
  // 'lifestylegarden' no longer has a tab — the message must fall back to the
  // rules (here: Roset domain → golden lane), not vanish from every tab.
  assert.equal(classifyBrand(msg({ fromEmail: 'lllamas@roset.fr', brand: 'lifestylegarden' })), 'ligne-roset');
});

test('GMAIL_BRAND_TABS opens on the golden Ligne Roset lane and has no LifestyleGarden', () => {
  assert.equal(GMAIL_BRAND_TABS[0].id, 'ligne-roset');
  assert.ok(!GMAIL_BRAND_TABS.some((t) => t.id === 'lifestylegarden'));
});

// ── isInvoiceEmail ──────────────────────────────────────────────────────────
test('isInvoiceEmail: invoice keyword + attachment ⇒ true', () => {
  assert.equal(isInvoiceEmail(msg({ subject: 'Su factura de mayo', hasAttachment: true, attachments: [{ filename: 'doc.pdf' }] })), true);
});

test('isInvoiceEmail: a named invoice attachment counts even with a terse note', () => {
  assert.equal(isInvoiceEmail(msg({ subject: 'hola', hasAttachment: true, attachments: [{ filename: 'Factura-001.pdf' }] })), true);
});

test('isInvoiceEmail: keyword but no attachment ⇒ false', () => {
  assert.equal(isInvoiceEmail(msg({ subject: 'Su factura', hasAttachment: false, attachments: [] })), false);
});

test('isInvoiceEmail: ordinary mail ⇒ false', () => {
  assert.equal(isInvoiceEmail(msg({ subject: 'Reunión el lunes', hasAttachment: true, attachments: [{ filename: 'agenda.pdf' }] })), false);
});

// ── parseInvoiceAmount ──────────────────────────────────────────────────────
test('parseInvoiceAmount picks the largest figure and its currency', () => {
  const a = parseInvoiceAmount(msg({ subject: 'Total RD$ 12,500.00', snippet: 'ITBIS RD$ 1,907.63' }));
  assert.deepEqual(a, { amount: 12500, currency: 'DOP' });
});

test('parseInvoiceAmount returns null when there is no money', () => {
  assert.equal(parseInvoiceAmount(msg({ subject: 'sin montos', snippet: 'nada' })), null);
});

// ── resolveGmailThreads ─────────────────────────────────────────────────────
test('groups by threadId, newest-activity first, unread = inbound unread', () => {
  const messages = [
    msg({ id: 'a1', threadId: 'A', fromEmail: 'x@ligne-roset.com', subject: 'A1 old', snippet: 's', receivedAt: NOW - 10 * MIN }),
    msg({ id: 'a2', threadId: 'A', fromEmail: 'x@ligne-roset.com', subject: 'A2 new', snippet: 's', receivedAt: NOW - 5 * MIN }),
    msg({ id: 'b1', threadId: 'B', fromEmail: 'y@lifestylegarden.do', subject: 'B1', snippet: 's', receivedAt: NOW - 1 * MIN }),
  ];
  const list = resolveGmailThreads(messages, {});
  assert.deepEqual(list.map((t) => t.threadId), ['B', 'A']); // B newer
  const a = list.find((t) => t.threadId === 'A');
  assert.equal(a.subject, 'A2 new');     // newest in-thread subject
  assert.equal(a.unread, 2);             // both inbound, unread
  assert.equal(a.count, 2);
  assert.equal(a.brand, 'ligne-roset');  // from the inbound sender
});

test('thread brand follows the inbound counterpart, not our outbound reply', () => {
  const messages = [
    msg({ id: 'i', threadId: 'T', direction: 'in', fromEmail: 'brbe@carlhansen.dk', receivedAt: NOW - 5 * MIN }),
    msg({ id: 'o', threadId: 'T', direction: 'out', fromEmail: 'us@alcover.do', receivedAt: NOW - 1 * MIN }),
  ];
  const [t] = resolveGmailThreads(messages, {});
  assert.equal(t.brand, GMAIL_CAT_PROVEEDORES);
});

test('hasInvoice flags a thread carrying an invoice message; needle filters', () => {
  const messages = [
    msg({ id: 'a', threadId: 'A', subject: 'Factura abril', hasAttachment: true, attachments: [{ filename: 'f.pdf' }], receivedAt: NOW }),
    msg({ id: 'b', threadId: 'B', subject: 'Saludo', receivedAt: NOW - MIN }),
  ];
  const all = resolveGmailThreads(messages, {});
  assert.equal(all.find((t) => t.threadId === 'A').hasInvoice, true);
  assert.equal(all.find((t) => t.threadId === 'B').hasInvoice, false);
  assert.deepEqual(resolveGmailThreads(messages, { needle: 'factura' }).map((t) => t.threadId), ['A']);
});

// ── resolveGmailThread ──────────────────────────────────────────────────────
test('resolveGmailThread returns one thread oldest-first', () => {
  const messages = [
    msg({ id: 'a2', threadId: 'A', subject: 'asunto', receivedAt: NOW - 2 * MIN }),
    msg({ id: 'a1', threadId: 'A', subject: 'asunto', receivedAt: NOW - 9 * MIN }),
    msg({ id: 'b', threadId: 'B', receivedAt: NOW }),
  ];
  const t = resolveGmailThread(messages, { threadId: 'A' });
  assert.deepEqual(t.items.map((m) => m.id), ['a1', 'a2']);
  assert.equal(t.subject, 'asunto');
});

// ── replySubject / resolveReplyDraft ────────────────────────────────────────
test('replySubject adds Re: once and never stacks it', () => {
  assert.equal(replySubject('Cotización'), 'Re: Cotización');
  assert.equal(replySubject('Re: Cotización'), 'Re: Cotización');
  assert.equal(replySubject('RE: algo'), 'RE: algo');
  assert.equal(replySubject(''), 'Re: (sin asunto)');
});

test('resolveReplyDraft answers the latest inbound sender, threaded on the last message', () => {
  const items = [
    msg({ id: 'i1', threadId: 'T', direction: 'in', fromEmail: 'cliente@correo.com', subject: 'Pedido' }),
    msg({ id: 'o1', threadId: 'T', direction: 'out', fromEmail: 'us@alcover.do', toEmail: 'cliente@correo.com' }),
  ];
  const d = resolveReplyDraft({ items, threadId: 'T', subject: 'Pedido' }, { selfEmail: 'us@alcover.do' });
  assert.equal(d.to, 'cliente@correo.com');
  assert.equal(d.subject, 'Re: Pedido');
  assert.equal(d.inReplyToId, 'o1');   // chains onto the latest message
  assert.equal(d.threadId, 'T');
});

test('resolveReplyDraft never addresses the reply back to ourselves', () => {
  // An all-outbound thread: the fallback counterpart is the recipient, not us.
  const items = [
    msg({ id: 'o1', threadId: 'T', direction: 'out', fromEmail: 'us@alcover.do', toEmail: 'cliente@correo.com', subject: 'Hola' }),
  ];
  const d = resolveReplyDraft({ items, threadId: 'T', subject: 'Hola' }, { selfEmail: 'us@alcover.do' });
  assert.equal(d.to, 'cliente@correo.com');
});

test('resolveReplyDraft returns null for an empty thread', () => {
  assert.equal(resolveReplyDraft({ items: [] }, {}), null);
  assert.equal(resolveReplyDraft(null, {}), null);
});

// ── forwardSubject / isEmailAddress ─────────────────────────────────────────
test('forwardSubject adds Fwd: once, leaves an existing Fwd:/Fw: alone', () => {
  assert.equal(forwardSubject('Pedido'), 'Fwd: Pedido');
  assert.equal(forwardSubject('Fwd: Pedido'), 'Fwd: Pedido');
  assert.equal(forwardSubject('Fw: Pedido'), 'Fw: Pedido');
  assert.equal(forwardSubject(''), 'Fwd: (sin asunto)');
});

test('isEmailAddress validates a single address', () => {
  assert.equal(isEmailAddress('a@b.com'), true);
  assert.equal(isEmailAddress('  a@b.co  '), true);
  assert.equal(isEmailAddress('not-an-email'), false);
  assert.equal(isEmailAddress('a@b'), false);
  assert.equal(isEmailAddress(''), false);
});

// ── resolveForwardDraft ─────────────────────────────────────────────────────
test('resolveForwardDraft quotes the latest message with a Fwd: subject', () => {
  const thread = {
    subject: 'Pedido #101',
    items: [
      msg({ id: 'a', direction: 'in', fromName: 'Lola', fromEmail: 'lola@correo.com', toEmail: 'us@alcover.do', subject: 'Pedido #101', bodyText: 'Hola, adjunto el pedido.', receivedAt: NOW }),
    ],
  };
  const d = resolveForwardDraft(thread);
  assert.equal(d.subject, 'Fwd: Pedido #101');
  assert.match(d.body, /Mensaje reenviado/);
  assert.match(d.body, /De: Lola <lola@correo\.com>/);
  assert.match(d.body, /Hola, adjunto el pedido\./);
});

test('resolveForwardDraft strips HTML when there is no plain text', () => {
  const thread = { subject: 'X', items: [msg({ id: 'a', fromEmail: 'a@b.com', bodyHtml: '<p>Línea uno<br>Línea dos</p>' })] };
  const d = resolveForwardDraft(thread);
  assert.match(d.body, /Línea uno\nLínea dos/);
});

test('resolveForwardDraft returns null for an empty thread', () => {
  assert.equal(resolveForwardDraft({ items: [] }), null);
});

// ── resolveEmailRecipients ──────────────────────────────────────────────────
test('resolveEmailRecipients unions CRM contacts + correspondents, CRM ranks first', () => {
  const customers = [{ name: 'Lola Cliente', email: 'lola@correo.com' }];
  const professionals = [{ name: 'Arq. Pérez', email: 'perez@studio.do' }];
  const messages = [
    { direction: 'in', fromEmail: 'proveedor@ligne-roset.com', fromName: 'LR Ventas' },
    { direction: 'in', fromEmail: 'lola@correo.com', fromName: 'Lola' }, // dup of customer
  ];
  const out = resolveEmailRecipients(customers, professionals, messages, {});
  // CRM contacts first (rank 0/1), then bare correspondents.
  assert.deepEqual(out.map((r) => r.email), ['lola@correo.com', 'perez@studio.do', 'proveedor@ligne-roset.com']);
  assert.equal(out[0].kind, 'customer');
  assert.equal(out[0].name, 'Lola Cliente'); // CRM name wins over the correspondent name
});

test('resolveEmailRecipients filters by needle and excludes given addresses', () => {
  const customers = [{ name: 'Lola', email: 'lola@correo.com' }, { name: 'Juan', email: 'juan@correo.com' }];
  assert.deepEqual(
    resolveEmailRecipients(customers, [], [], { needle: 'juan' }).map((r) => r.email),
    ['juan@correo.com'],
  );
  assert.deepEqual(
    resolveEmailRecipients(customers, [], [], { exclude: ['lola@correo.com'] }).map((r) => r.email),
    ['juan@correo.com'],
  );
});

test('resolveEmailRecipients drops malformed addresses', () => {
  const customers = [{ name: 'Bad', email: 'nope' }, { name: 'Ok', email: 'ok@x.com' }];
  assert.deepEqual(resolveEmailRecipients(customers, [], [], {}).map((r) => r.email), ['ok@x.com']);
});

// ── resolveGmailInvoices ────────────────────────────────────────────────────
test('resolveGmailInvoices lists only invoices, newest first, with brand + amount', () => {
  const messages = [
    msg({ id: 'inv', threadId: 'A', fromEmail: 'billing@ligne-roset.com', subject: 'Factura · Total US$ 3,200.00', hasAttachment: true, attachments: [{ filename: 'inv.pdf' }], receivedAt: NOW }),
    msg({ id: 'plain', threadId: 'B', subject: 'hola', receivedAt: NOW - MIN }),
  ];
  const invoices = resolveGmailInvoices(messages, {});
  assert.equal(invoices.length, 1);
  assert.equal(invoices[0].id, 'inv');
  assert.equal(invoices[0].brand, 'ligne-roset');
  assert.deepEqual(invoices[0].amount, { amount: 3200, currency: 'USD' });
});

// ── archived visibility (Gmail semantics) ───────────────────────────────────
test('an inbound thread with no INBOX label anywhere is hidden (archived)', () => {
  const messages = [
    msg({ id: 'a', threadId: 'A', labelIds: [], receivedAt: NOW }),                         // archived inbound
    msg({ id: 'b', threadId: 'B', labelIds: ['INBOX'], receivedAt: NOW - MIN }),            // in the inbox
    msg({ id: 'c', threadId: 'C', direction: 'out', labelIds: ['SENT'], receivedAt: NOW }), // sent-only: stays
  ];
  const visible = resolveGmailThreads(messages, {});
  assert.deepEqual(visible.map((t) => t.threadId).sort(), ['B', 'C']);
  assert.equal(resolveGmailThreads(messages, { includeArchived: true }).length, 3);
});

test('a thread stays visible while ANY of its messages still carries INBOX', () => {
  const messages = [
    msg({ id: 'a1', threadId: 'A', labelIds: [], receivedAt: NOW - MIN }),
    msg({ id: 'a2', threadId: 'A', labelIds: ['INBOX'], receivedAt: NOW }),
  ];
  assert.equal(resolveGmailThreads(messages, {}).length, 1);
});

test('hasAttachment and starred roll up to the thread', () => {
  const messages = [
    msg({ id: 'a1', threadId: 'A', receivedAt: NOW - MIN }),
    msg({ id: 'a2', threadId: 'A', hasAttachment: true, labelIds: ['INBOX', 'STARRED'], receivedAt: NOW }),
    msg({ id: 'b', threadId: 'B', receivedAt: NOW }),
  ];
  const a = resolveGmailThreads(messages, {}).find((t) => t.threadId === 'A');
  const b = resolveGmailThreads(messages, {}).find((t) => t.threadId === 'B');
  assert.equal(a.hasAttachment, true);
  assert.equal(a.starred, true);
  assert.equal(b.hasAttachment, false);
  assert.equal(b.starred, false);
});

// ── resolveGmailTabCounts ───────────────────────────────────────────────────
test('resolveGmailTabCounts buckets thread + unread counts per tab', () => {
  const messages = [
    msg({ id: 'r1', threadId: 'R1', fromEmail: 'x@roset.fr', receivedAt: NOW }),                    // LR, unread
    msg({ id: 'r2', threadId: 'R2', fromEmail: 'y@rosetusa.com', isRead: true, receivedAt: NOW }),  // LR, read
    msg({ id: 'f1', threadId: 'F1', fromEmail: 'z@nuevo.do', subject: 'Su factura', receivedAt: NOW }), // finanzas
  ];
  const c = resolveGmailTabCounts(messages);
  assert.equal(c['ligne-roset'].threads, 2);
  assert.equal(c['ligne-roset'].unread, 1);
  assert.equal(c[GMAIL_CAT_FINANZAS].threads, 1);
  assert.equal(c[GMAIL_BRAND_OTHER].threads, 0);
  // Every tab id is present even when empty.
  for (const t of GMAIL_BRAND_TABS) assert.ok(c[t.id]);
});

test('resolveGmailTabCounts excludes archived threads (they left the tabs)', () => {
  const messages = [
    msg({ id: 'a', threadId: 'A', fromEmail: 'x@roset.fr', labelIds: [], receivedAt: NOW }),
  ];
  assert.equal(resolveGmailTabCounts(messages)['ligne-roset'].threads, 0);
});

// ── formatGmailDate (relative buckets, deterministic months) ────────────────
test('formatGmailDate: hoy → HH:MM, ayer, mismo año → d mmm, previo → d mmm yy', () => {
  const now = new Date(2026, 5, 10, 15, 30).getTime(); // 10 jun 2026, local
  assert.equal(formatGmailDate(new Date(2026, 5, 10, 9, 5).getTime(), now), '09:05');
  assert.equal(formatGmailDate(new Date(2026, 5, 9, 22, 0).getTime(), now), 'ayer');
  assert.equal(formatGmailDate(new Date(2026, 2, 3).getTime(), now), '3 mar');
  assert.equal(formatGmailDate(new Date(2024, 11, 24).getTime(), now), '24 dic 24');
  assert.equal(formatGmailDate(0, now), '');
});

// ── senderInitials / avatarColorIndex ───────────────────────────────────────
test('senderInitials: first + last name initials, falling back to the address', () => {
  assert.equal(senderInitials('Lola María Cliente', ''), 'LC');
  assert.equal(senderInitials('Lola', ''), 'LO');
  assert.equal(senderInitials('', 'billing@ligne-roset.com'), 'BI');
  assert.equal(senderInitials('', ''), '?');
});

test('avatarColorIndex is deterministic, bounded and case-insensitive', () => {
  const a = avatarColorIndex('billing@ligne-roset.com', 6);
  assert.equal(avatarColorIndex('billing@ligne-roset.com', 6), a);
  assert.equal(avatarColorIndex('BILLING@ligne-roset.com', 6), a);
  assert.ok(a >= 0 && a < 6);
});

// ── load-older pagination (oldestGmailAt / olderMailQuery) ──────────────────
test('oldestGmailAt returns the earliest timestamp, null when empty', () => {
  const early = new Date(2026, 2, 15, 12).getTime();
  const late = new Date(2026, 4, 1, 12).getTime();
  assert.equal(oldestGmailAt([msg({ receivedAt: late }), msg({ receivedAt: early })]), early);
  assert.equal(oldestGmailAt([]), null);
  assert.equal(oldestGmailAt(null), null);
});

test('olderMailQuery builds a day-granular before: one day past the cursor', () => {
  assert.equal(
    olderMailQuery(new Date(2026, 2, 15, 12).getTime()),
    '(in:inbox OR in:sent) before:2026/03/16',
  );
  // Month rollover pads and carries correctly.
  assert.equal(
    olderMailQuery(new Date(2026, 0, 31, 12).getTime()),
    '(in:inbox OR in:sent) before:2026/02/01',
  );
  assert.equal(olderMailQuery(null), null);
});
