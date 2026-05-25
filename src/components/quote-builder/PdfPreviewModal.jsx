import { useState } from 'react';
import { Download, Share2, ExternalLink, Loader2 } from 'lucide-react';
import Modal from '../Modal.jsx';

/**
 * In-app preview of the freshly generated quote PDF, shown BEFORE it is
 * shared or downloaded so the dealer can eyeball it first. The mobile share
 * path used to fire the native share sheet immediately, sight unseen — the
 * dealer asked to *see* the document before sending it to a client.
 *
 * The PDF renders in an <iframe> off its blob URL — reliable on desktop and
 * Android. iOS Safari / PWA can refuse to paint a PDF inline, so the
 * "Abrir en pestaña" escape hatch always hands it to the OS's native viewer.
 *
 * Confirming is a real user-gesture click — exactly what navigator.share()
 * needs — so it shares more reliably than the old fire-after-async path.
 *
 * Props:
 *   preview    { url, filename, shareMode } | null  (null = closed)
 *   onConfirm  async () => void  — runs the share/download
 *   onClose    () => void        — dismiss + revoke the blob URL
 */
export default function PdfPreviewModal({ preview, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  if (!preview) return null;
  const { url, filename, shareMode } = preview;

  async function confirm() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={filename}
      size="xl"
      footer={
        <>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-ghost text-sm mr-auto"
          >
            <ExternalLink size={14} /> Abrir en pestaña
          </a>
          <button type="button" onClick={onClose} className="btn-ghost text-sm">
            Cerrar
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="btn-primary text-sm disabled:opacity-60 disabled:cursor-wait"
          >
            {busy ? (
              <><Loader2 size={14} className="animate-spin" /> {shareMode ? 'Compartiendo…' : 'Descargando…'}</>
            ) : shareMode ? (
              <><Share2 size={14} /> Compartir / Enviar</>
            ) : (
              <><Download size={14} /> Descargar</>
            )}
          </button>
        </>
      }
    >
      <div className="-mx-5 -my-4">
        <iframe
          src={url}
          title="Vista previa de la cotización"
          className="w-full h-[68vh] border-0 bg-ink-100"
        />
      </div>
    </Modal>
  );
}
