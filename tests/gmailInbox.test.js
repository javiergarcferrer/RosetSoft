/**
 * Tests for src/core/crm/views/gmailInbox.js — the Gmail inbox VM.
 *
 * Pins the two derivations the feature is built on: BRAND classification
 * (sender-domain rules + manual override) and INVOICE detection, plus the
 * thread grouping / unread / brand-of-thread roll-up the inbox list renders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBrand, isInvoiceEmail, parseInvoiceAmount,
  resolveGmailThreads, resolveGmailThread, resolveGmailInvoices,
  resolveReplyDraft, replySubject, forwardSubject, resolveForwardDraft,
  isEmailAddress, resolveEmailRecipients,
  GMAIL_BRAND_OTHER, GMAIL_BRAND_TABS,
  GMAIL_CAT_PROVEEDORES, GMAIL_CAT_FINANZAS, GMAIL_CAT_OPERACIONES, GMAIL_CAT_BOLETINES,
} from '../src/core/crm/views/gmailInbox.js';

const NOW = Date.parse('2026-06-10T12:00:00Z');
const MIN = 60_000;
const msg = (o) => ({ id: 'm', profileId: 'team', threadId: 't', direction: 'in', isRead: false, ...o });

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
