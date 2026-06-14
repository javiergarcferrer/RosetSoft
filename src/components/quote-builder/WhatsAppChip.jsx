import { userMessageFor } from '../../lib/errorMessages.js';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, X, Send, Loader2, AlertTriangle, Link2, FileText } from 'lucide-react';
import Modal from '../Modal.jsx';
import BrandName from '../BrandName.jsx';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';
import { waDigits, displayPhone } from '../../lib/phone.js';
import { shareLinkUrl, newShareToken } from '../../lib/quoteShare.js';
import { quoteSlug } from '../../lib/quoteNaming.js';
import { sendQuoteLink, sendQuotePdf, phoneOwner, phoneInUseMessage } from '../../lib/whatsapp.js';

/**
 * The literal WhatsApp mark (phone inside a speech bubble) as an inline SVG —
 * lucide dropped its brand glyphs, so we ship the official logo path here.
 * Inherits `currentColor` so the chip's green tint flows straight through.
 */
function WhatsAppGlyph({ className }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.967-.94 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.71.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z" />
    </svg>
  );
}

/**
 * The quote customer's WhatsApp number, editable inline from the header — so
 * adding it is one click without leaving the quote pane. The number lives on the
 * CUSTOMER (`customer.phone`, the same number the rest of the app already shows),
 * so it's captured once and reused on every quote for that client; saving writes
 * straight to the customer row. Empty → a dashed "Agregar WhatsApp" affordance;
 * set → opens a WhatsApp chat to that number, with a pencil to edit. Hidden until
 * a customer is assigned (the CustomerChip prompts that first — there's no one to
 * attach a number to yet).
 *
 * The chip is just the number now — capture / edit / open the chat. Sending the
 * quote itself lives in ONE place, the totals-dock action (which opens
 * SendQuoteModal), so there is no per-chip send button competing with it.
 */
export default function WhatsAppChip({ customer }) {
  const { profileId } = useApp();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [phoneErr, setPhoneErr] = useState('');

  if (!customer) return null;
  const phone = customer.phone || '';

  function startEdit() {
    setValue(phone);
    setPhoneErr('');
    setEditing(true);
  }
  async function save() {
    const next = value.trim();
    if (next === phone) { setEditing(false); return; }
    // Watertight WhatsApp-number relation: refuse a number already held by
    // another contact (the inbox links a thread by phone — duplicates
    // misattribute it, the "Carmen had Alcover's number" bug).
    if (next) {
      const owner = await phoneOwner({ phone: next, excludeId: customer.id, profileId });
      if (owner) { setPhoneErr(phoneInUseMessage(owner)); return; }
    }
    await db.customers.update(customer.id, { phone: next || null });
    setEditing(false);
  }

  if (editing) {
    return (
      <span className="inline-flex flex-col gap-1 min-w-0 max-w-full">
        <span className={`inline-flex items-center gap-1 rounded-full border bg-surface px-2 min-h-7 coarse:min-h-9 text-xs shadow-xs ring-1 ring-inset max-w-full min-w-0 ${phoneErr ? 'border-rose-300 ring-rose-200/60' : 'border-emerald-300 ring-emerald-200/50'}`}>
          <WhatsAppGlyph className={`h-3 w-3 flex-shrink-0 ${phoneErr ? 'text-rose-500' : 'text-[#25D366]'}`} />
          <input
            autoFocus
            type="tel"
            inputMode="tel"
            value={value}
            onChange={(e) => { setValue(e.target.value); if (phoneErr) setPhoneErr(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
            placeholder="809 000 0000"
            className="w-24 min-w-0 bg-transparent border-0 p-0 text-xs text-ink-900 focus:outline-none focus:ring-0"
            aria-label="Número de WhatsApp"
          />
          <button type="button" onClick={save} title="Guardar" aria-label="Guardar" className="inline-flex h-6 w-6 coarse:h-8 coarse:w-8 items-center justify-center rounded text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 active:bg-emerald-100 transition-colors flex-shrink-0">
            <Check size={13} />
          </button>
          <button type="button" onClick={() => setEditing(false)} title="Cancelar" aria-label="Cancelar" className="inline-flex h-6 w-6 coarse:h-8 coarse:w-8 items-center justify-center rounded text-ink-300 hover:text-ink-600 hover:bg-ink-50 active:bg-ink-100 transition-colors flex-shrink-0">
            <X size={13} />
          </button>
        </span>
        {phoneErr && <span className="text-[11px] text-rose-600 max-w-60 break-words">{phoneErr}</span>}
      </span>
    );
  }

  // The chip is now a compact status dot, not a number readout: a green
  // WhatsApp glyph when the client has a number on file, a muted grey one when
  // they don't. The digits aren't shown (you don't need to watch them here) —
  // they live on the customer and the send-dock/CRM own the actual messaging.
  if (!phone) {
    return (
      <button
        type="button"
        onClick={startEdit}
        title="Agregar WhatsApp"
        aria-label="Agregar número de WhatsApp"
        className="inline-flex h-6 w-6 coarse:h-11 coarse:w-11 items-center justify-center rounded-full border border-dashed border-ink-300 text-ink-300 hover:border-[#25D366] hover:text-[#25D366] hover:bg-[#25D366]/10 transition-all active:scale-[0.95]"
      >
        <WhatsAppGlyph className="h-3.5 w-3.5" />
      </button>
    );
  }

  // Green = number on file. A single solid brand-green badge carrying the
  // literal WhatsApp mark; tapping it opens the inline edit bubble directly
  // (no separate pencil) — the digits never print, edit is one tap.
  return (
    <button
      type="button"
      onClick={startEdit}
      title={`Editar WhatsApp · ${phone}`}
      aria-label={`Editar número de WhatsApp de ${phone}`}
      className="inline-flex h-6 w-6 coarse:h-10 coarse:w-10 items-center justify-center rounded-full bg-[#25D366] text-white shadow-sm ring-1 ring-inset ring-black/5 transition-transform active:scale-95 hover:brightness-105"
    >
      <WhatsAppGlyph className="h-3.5 w-3.5 coarse:h-5 coarse:w-5" />
    </button>
  );
}

/**
 * Confirm-and-send, in the dealer's choice of format:
 *   • Enlace — mints (once) the quote's public share link — same rule as
 *     useQuoteExport.mintClientLink, persisted through the caller's
 *     updateQuote — and ships it via the wa-send Edge Function (approved
 *     template outside the 24h window, free text inside it).
 *   • PDF — builds the same blob Exportar downloads (buildPdf =
 *     useQuoteExport.generatePdf) and ships it as a WhatsApp document.
 *     Documents are free-form media, so they only deliver inside the 24h
 *     window — the per-format hint below says so before the dealer sends.
 * Owns the in-flight/result state, and self-explains when the quote can't be
 * sent yet (no customer / no number / API not connected).
 *
 * The SINGLE send surface: rendered once at page level (QuoteBuilder) and
 * opened from the totals-dock action, so the whole app has ONE place that
 * sends a quote to the client — always through the dealer's WhatsApp number,
 * never an OS share-sheet that would bypass it.
 */
export function SendQuoteModal({ open, onClose, customer, quote, settings, onUpdateQuote, buildPdf }) {
  const [state, setState] = useState('idle'); // idle | sending | sent | error
  const [msg, setMsg] = useState('');
  const [format, setFormat] = useState('link'); // 'link' | 'pdf'
  const template = (settings?.whatsappQuoteTemplate || '').trim();
  const canPdf = typeof buildPdf === 'function';

  // Single send surface — opened from the totals dock for ANY quote, so a
  // prerequisite may still be missing. Explain the next step instead of
  // rendering a send form that would fail (no number to send to, no API).
  const connected = !!settings?.whatsappConnectedAt;
  const phone = customer?.phone || '';
  let blocker = null;
  if (!connected) {
    blocker = (
      <>
        WhatsApp Business no está conectado. Actívalo en{' '}
        <Link to="/settings" onClick={onClose} className="underline font-medium text-ink-700">Configuración → WhatsApp</Link>{' '}
        para enviar la cotización desde el número del negocio.
      </>
    );
  } else if (!customer) {
    blocker = <>Asigna un cliente a la cotización para poder enviarla por WhatsApp.</>;
  } else if (!phone) {
    blocker = <>{customer.name || customer.company || 'El cliente'} no tiene número de WhatsApp. Agrégalo en el chip del cliente y vuelve a enviar.</>;
  }

  async function send() {
    if (state === 'sending') return;
    setState('sending');
    setMsg('');
    try {
      let res;
      if (format === 'pdf' && canPdf) {
        const { blob, filename } = await buildPdf();
        res = await sendQuotePdf({ to: customer.phone, blob, filename, customer, quoteId: quote.id });
      } else {
        let token = quote.shareToken;
        if (!token || !quote.shareEnabled) {
          token = token || newShareToken();
          await onUpdateQuote({ shareToken: token, shareEnabled: true });
        }
        const url = shareLinkUrl(token, quoteSlug(quote, customer));
        res = await sendQuoteLink({ to: customer.phone, url, settings, customer, quoteId: quote.id });
      }
      if (res?.ok) {
        setState('sent');
        setMsg(`Enviado a ${displayPhone(waDigits(customer.phone))}.`);
      } else {
        setState('error');
        setMsg(res?.error || 'No se pudo enviar.');
      }
    } catch (e) {
      setState('error');
      setMsg(userMessageFor(e));
    }
  }

  const pickFormat = (f) => {
    if (state === 'sending') return;
    setFormat(f);
    if (state === 'error') { setState('idle'); setMsg(''); }
  };

  if (blocker) {
    return (
      <Modal open={open} onClose={onClose} title="Enviar cotización por WhatsApp" size="sm">
        <p className="text-sm text-ink-600 flex items-start gap-2">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
          <span>{blocker}</span>
        </p>
        <div className="flex items-center justify-end mt-5">
          <button type="button" onClick={onClose} className="btn-ghost text-sm">Cerrar</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title="Enviar cotización por WhatsApp" size="sm">
      <p className="text-sm text-ink-600">
        Se enviará la cotización a{' '}
        <strong><BrandName name={customer.name || customer.company} /></strong> ({displayPhone(waDigits(customer.phone))})
        desde el número del negocio{settings?.whatsappDisplayNumber ? ` (${settings.whatsappDisplayNumber})` : ''}.
      </p>

      {/* Format — the interactive client link or the exported PDF document. */}
      <div className="grid grid-cols-2 gap-2 mt-3" role="radiogroup" aria-label="Formato del envío">
        <FormatOption
          icon={Link2}
          label="Enlace interactivo"
          hint="El cliente abre la cotización en vivo y elige telas"
          active={format === 'link'}
          onPick={() => pickFormat('link')}
        />
        <FormatOption
          icon={FileText}
          label="PDF"
          hint="El documento exportado, como archivo adjunto"
          active={format === 'pdf'}
          disabled={!canPdf}
          onPick={() => pickFormat('pdf')}
        />
      </div>

      <p className="text-xs text-ink-500 mt-2.5">
        {format === 'pdf'
          ? 'El PDF viaja como archivo adjunto — WhatsApp solo lo entrega si el cliente escribió en las últimas 24 horas. Fuera de esa ventana, envía el enlace (usa la plantilla aprobada).'
          : template
            ? <>Se usa la plantilla aprobada <code>{template}</code>, así que llega aunque el cliente no haya escrito.</>
            : 'Sin plantilla configurada se envía como texto libre — solo llega si el cliente escribió en las últimas 24 horas. Configura la plantilla en Configuración → WhatsApp.'}
      </p>
      {msg && (
        <p className={`text-xs mt-3 flex items-start gap-1.5 ${state === 'error' ? 'text-rose-600' : 'text-emerald-700'}`}>
          {state === 'error' ? <AlertTriangle size={13} className="mt-0.5 shrink-0" /> : <Check size={13} className="mt-0.5 shrink-0" />}
          <span className="min-w-0 break-words">{msg}</span>
        </p>
      )}
      <div className="flex items-center justify-end gap-2 mt-5">
        <button type="button" onClick={onClose} className="btn-ghost text-sm">
          {state === 'sent' ? 'Cerrar' : 'Cancelar'}
        </button>
        {state !== 'sent' && (
          <button type="button" onClick={send} disabled={state === 'sending'} className="btn-primary text-sm inline-flex items-center gap-1.5 disabled:opacity-40">
            {state === 'sending' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {state === 'error' ? 'Reintentar' : format === 'pdf' ? 'Enviar PDF' : 'Enviar enlace'}
          </button>
        )}
      </div>
    </Modal>
  );
}

/** One selectable format card in the send modal's link-or-PDF pair. */
function FormatOption({ icon: Icon, label, hint, active, disabled, onPick }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onPick}
      className={`text-left rounded-lg border p-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        active
          ? 'border-emerald-400 bg-emerald-50/60 ring-1 ring-inset ring-emerald-200'
          : 'border-ink-200 hover:border-ink-300 hover:bg-ink-50'
      }`}
    >
      <span className={`flex items-center gap-1.5 text-sm font-medium ${active ? 'text-emerald-800' : 'text-ink-800'}`}>
        <Icon size={14} className={active ? 'text-emerald-600' : 'text-ink-400'} /> {label}
      </span>
      {/* Active card sits on the always-light bg-emerald-50/60, which doesn't
          flip in dark mode; the hint must use a fixed emerald tone too, or the
          theme-following text-ink-500 turns light-gray-on-light-green and the
          line washes out (same class as the dark-mode Subtotal invisibility). */}
      <span className={`block text-[11px] mt-0.5 ${active ? 'text-emerald-700' : 'text-ink-500'}`}>{hint}</span>
    </button>
  );
}
