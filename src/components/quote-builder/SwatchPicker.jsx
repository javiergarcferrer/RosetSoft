import { useEffect, useState } from 'react';
import Modal from '../Modal.jsx';
import MaterialColorPicker from './MaterialColorPicker.jsx';
import { composeFabricLabel } from '../../lib/subtype.js';
import { useLiveQuery } from '../../db/hooks.js';
import { db } from '../../db/database.js';
import { useApp } from '../../context/AppContext.jsx';

/**
 * Modal picker for selecting a material + color combination from the
 * catalog and committing it back to a quote line.
 *
 * Thin <Modal> wrapper around the shared, headless <MaterialColorPicker>
 * (the MaterialList → ColorGrid body). This component owns ONLY the modal
 * chrome (overlay, close, heading) and the materials query; the two-step
 * flow + keyboard nav live in MaterialColorPicker so the catalog flow can
 * reuse exactly the same body.
 *
 * The caller (QuoteLineItem's grade/fabric row) receives:
 *   { grade, fabric, swatchImageId }
 * where `fabric` is "<MATERIAL NAME> · <COLOR NAME> (#code)" — the exact
 * same shape the dealer would have typed by hand, just generated from
 * canonical data (composeFabricLabel) so the codes don't drift.
 *
 * Re-opening a line that already carries a material drills STRAIGHT into
 * that material's ColorGrid (autoDrill) — MaterialColorPicker locates the
 * material via swatchMatch.locateColor on the current grade/fabric.
 *
 * Empty-catalog state: the picker shows a friendly nudge to import the
 * Ligne Roset 10.2025 list from /admin/materials. We don't trigger the
 * import inline because the catalog is admin-scoped.
 */
export default function SwatchPicker({ open, onClose, onSelect, currentGrade, currentFabric }) {
  const { profileId } = useApp();
  const materials = useLiveQuery(
    () => (profileId ? db.materials.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId, open],   // re-query on open so a freshly-imported catalog shows up without remounting
    [],
  );

  const [title, setTitle] = useState('Elegir material');

  // Reset the heading every time the modal opens. The inner picker remounts
  // on open (Modal returns null while closed), so its own step state resets
  // too — a reopened picker never keeps the previous line's drilled material.
  useEffect(() => {
    if (open) setTitle('Elegir material');
  }, [open]);

  function commit(material, color) {
    const fabric = composeFabricLabel(material, color);
    // Pre-fill the swatch from the chosen color's own photo when it has one.
    // We deliberately do NOT fall back to another color's picture — a wrong-
    // colour swatch is worse than none. When the color has no photo the
    // line's swatch slot lets the dealer add it inline.
    const swatchImageId = (color && color.imageId) || null;
    onSelect({ grade: material.grade || '', fabric, swatchImageId });
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      {/* Modal returns null while closed, so the picker below fully unmounts
          and remounts on reopen — its step state (and the autoDrill guard)
          reset without an explicit key. */}
      {open && (
        <MaterialColorPicker
          materials={materials}
          currentGrade={currentGrade}
          currentFabric={currentFabric}
          autoDrill
          onPick={commit}
          onTitleChange={setTitle}
        />
      )}
    </Modal>
  );
}
