// DrivePickerModal — pick an existing file from Google Drive ("add from Drive").
//
// A thin Modal around DriveExplorer: the team browses folders (or searches),
// taps a file, and it comes back via onPick ({ id, name, mimeType,
// webViewLink, … }). The caller decides what to do with it (copy into a folder,
// attach a reference, etc.). Pinned folders (optional) give one-tap shortcuts.
// Requires a connected Google account.
import { Loader2 } from 'lucide-react';
import Modal from '../Modal.jsx';
import DriveExplorer from './DriveExplorer.jsx';

export default function DrivePickerModal({ open, onClose, onPick, picking = false, pins = [] }) {
  return (
    <Modal open={open} onClose={onClose} title="Agregar desde Google Drive" size="lg">
      <DriveExplorer onFile={onPick} pins={pins} busy={picking} />
      {picking && <p className="mt-3 text-xs text-ink-500 flex items-center gap-2"><Loader2 size={13} className="animate-spin" /> Agregando…</p>}
    </Modal>
  );
}
