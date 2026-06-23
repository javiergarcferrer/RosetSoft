// DriveFilePreview — view a Google Drive file inline (Drive's own preview
// iframe) with a link out to open it in Drive. Shared by the Mi Drive page and
// the per-record document cards so the preview stays identical everywhere.
//
// `file` is a Drive file ({ id, name, webViewLink }); pass null/undefined to
// render nothing. `onClose` closes the modal.
import { ExternalLink } from 'lucide-react';
import Modal from '../Modal.jsx';

export default function DriveFilePreview({ file, onClose }) {
  if (!file) return null;
  return (
    <Modal open onClose={onClose} title={file.name} size="lg">
      <iframe
        title={file.name}
        src={`https://drive.google.com/file/d/${file.id}/preview`}
        className="h-[70vh] w-full rounded-lg border border-ink-100"
        allow="autoplay"
      />
      <div className="mt-2 text-right">
        <a href={file.webViewLink || '#'} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand-700 hover:underline">
          <ExternalLink size={12} /> Abrir en Drive
        </a>
      </div>
    </Modal>
  );
}
