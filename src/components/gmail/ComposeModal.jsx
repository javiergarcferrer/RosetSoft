import { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Paperclip, X, Loader2, PenLine } from 'lucide-react';
import Modal from '../Modal.jsx';
import RecipientField from './RecipientField.jsx';
import { resolveEmailRecipients } from '../../core/crm/index.js';
import { composeGmail, sanitizeSignatureHtml } from '../../lib/gmail.js';

const fmtBytes = (n) => {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

/**
 * A full compose window — To/Cc/Bcc (chips + contact autocomplete), subject,
 * body, a signature selector and file attachments. Sends a brand-new email via
 * composeGmail (no thread). `initial` seeds it for "Forward" (prefilled subject
 * + quoted body). Reused for both "Redactar" and forwarding.
 */
export default function ComposeModal({
  open, onClose, customers, professionals, messages,
  signatureEs, signatureEn, fromName, initial = null, onSent,
}) {
  const sigOptions = useMemo(() => {
    const opts = [];
    if (signatureEs?.trim()) opts.push({ lang: 'es', label: 'Español', html: signatureEs });
    if (signatureEn?.trim()) opts.push({ lang: 'en', label: 'English', html: signatureEn });
    opts.push({ lang: 'none', label: 'Sin firma', html: '' });
    return opts;
  }, [signatureEs, signatureEn]);

  const [to, setTo] = useState([]);
  const [cc, setCc] = useState([]);
  const [bcc, setBcc] = useState([]);
  const [showCc, setShowCc] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [sigLang, setSigLang] = useState(sigOptions[0].lang);
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  // Seed (or reset) whenever the window opens.
  useEffect(() => {
    if (!open) return;
    setTo(initial?.to || []);
    setCc(initial?.cc || []);
    setBcc(initial?.bcc || []);
    setShowCc(!!(initial?.cc?.length || initial?.bcc?.length));
    setSubject(initial?.subject || '');
    setBody(initial?.body || '');
    setSigLang(sigOptions[0].lang);
    setFiles([]);
    setError('');
    setSending(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chosenSigHtml = sigOptions.find((o) => o.lang === sigLang)?.html || '';
  const sigPreview = useMemo(() => sanitizeSignatureHtml(chosenSigHtml), [chosenSigHtml]);
  const hasSignatures = sigOptions.length > 1;

  const suggest = (needle, exclude) =>
    resolveEmailRecipients(customers, professionals, messages, { needle, exclude, limit: 8 });

  const addFiles = (list) => {
    const picked = [...(list || [])];
    if (picked.length) setFiles((f) => [...f, ...picked]);
  };

  const send = async () => {
    if (!to.length) { setError('Agrega al menos un destinatario.'); return; }
    if (!subject.trim() && !window.confirm('¿Enviar sin asunto?')) return;
    setSending(true);
    setError('');
    try {
      await composeGmail({
        to: to.join(', '),
        cc: cc.join(', '),
        bcc: bcc.join(', '),
        subject: subject.trim(),
        body,
        signatureHtml: chosenSigHtml,
        fromName,
        attachmentBlobs: files.map((f) => ({ filename: f.name, blob: f })),
      });
      onSent?.();
      onClose();
    } catch (e) {
      setError(e?.message || 'No se pudo enviar el correo.');
    } finally {
      setSending(false);
    }
  };

  const footer = (
    <>
      {error && <span className="mr-auto text-xs text-red-600">{error}</span>}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface px-3 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
      >
        <Paperclip size={15} /> <span className="hidden sm:inline">Adjuntar</span>
      </button>
      {hasSignatures && (
        <label className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-surface pl-2.5 pr-1.5 py-1.5 text-xs font-medium text-ink-600">
          <PenLine size={14} className="shrink-0 text-ink-400" />
          <select value={sigLang} onChange={(e) => setSigLang(e.target.value)} className="bg-transparent text-xs text-ink-700 focus:outline-none" aria-label="Firma">
            {sigOptions.map((o) => <option key={o.lang} value={o.lang}>{o.label}</option>)}
          </select>
        </label>
      )}
      <button
        type="button"
        onClick={send}
        disabled={sending}
        className="inline-flex items-center gap-2 rounded-full bg-ink-900 px-4 py-2 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-50"
      >
        {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        Enviar
      </button>
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title="Redactar correo" size="lg" footer={footer}>
      <div className="space-y-2.5">
        <RecipientField label="Para" value={to} onChange={setTo} suggest={suggest} autoFocus />
        {!showCc && (
          <div className="pl-14">
            <button type="button" onClick={() => setShowCc(true)} className="text-xs font-medium text-brand-700 hover:underline">
              Cc / Cco
            </button>
          </div>
        )}
        {showCc && (
          <>
            <RecipientField label="Cc" value={cc} onChange={setCc} suggest={suggest} />
            <RecipientField label="Cco" value={bcc} onChange={setBcc} suggest={suggest} />
          </>
        )}
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-xs font-medium text-ink-400">Asunto</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-ink-200 bg-surface px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ink-300"
          />
        </div>
        <div className="rounded-lg border border-ink-200 focus-within:ring-2 focus-within:ring-ink-300">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={9}
            placeholder="Escribe tu mensaje…"
            className="w-full resize-none rounded-t-lg bg-surface px-3 py-2.5 text-sm leading-relaxed focus:outline-none"
            style={{ fontFamily: 'Lausanne, system-ui, sans-serif' }}
          />
          {sigPreview && (
            <div className="border-t border-dashed border-ink-100 px-3 py-2.5">
              <div dangerouslySetInnerHTML={{ __html: sigPreview }} />
            </div>
          )}
        </div>
        {/* Attachment chips */}
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} className="inline-flex max-w-[16rem] items-center gap-1.5 rounded border border-ink-200 bg-ink-50 px-2 py-1 text-xs text-ink-700">
                <Paperclip size={12} className="shrink-0 text-ink-400" />
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 text-ink-400">{fmtBytes(f.size)}</span>
                <button type="button" onClick={() => setFiles((arr) => arr.filter((_, idx) => idx !== i))} className="shrink-0 text-ink-400 hover:text-ink-700" aria-label="Quitar adjunto">
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }}
        />
      </div>
    </Modal>
  );
}
