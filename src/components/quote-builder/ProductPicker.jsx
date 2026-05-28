import Modal from '../Modal.jsx';
import ModelBrowser from './ModelBrowser.jsx';
import { useApp } from '../../context/AppContext.jsx';

/**
 * Modal for SWITCHING an existing quote line's product. The product-selector
 * counterpart to the material-selector (SwatchPicker): same shape, but it
 * re-points the line at a different catalog MODEL instead of a material.
 *
 * Picking a model hands the whole CatalogFamily up via `onSelect`; the caller
 * (QuoteLineItem) feeds it to lib/catalog:switchLineProduct, which keeps the
 * materials the new model can be quoted in and drops the rest. There is no
 * fabric step here — the line's existing material is preserved when it fits —
 * so this is just ModelBrowser in modal chrome.
 */
export default function ProductPicker({ open, onClose, onSelect }) {
  const { profileId } = useApp();
  return (
    <Modal open={open} onClose={onClose} size="lg" title="Cambiar producto">
      {/* Modal returns null while closed, so ModelBrowser fully unmounts and
          remounts on reopen — its search state (and focus) reset cleanly. */}
      {open && (
        <ModelBrowser
          profileId={profileId}
          onPick={(model) => { onSelect(model); onClose(); }}
        />
      )}
    </Modal>
  );
}
