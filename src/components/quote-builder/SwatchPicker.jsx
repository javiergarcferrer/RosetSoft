import { useContext, useEffect, useMemo, useState } from 'react';
import Modal from '../Modal.jsx';
import MaterialColorPicker from './MaterialColorPicker.jsx';
import ProjectPalettePicks from './ProjectPalettePicks.jsx';
import { ProjectPaletteContext } from './ProjectPaletteContext.js';
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
 * Multi-select option (`allowMultiSelect` + `onSelectMany`): surfaces a
 * "Agregar opciones" toggle inside the picker so the SAME modal can either
 * replace the line's fabric OR batch-add alternative materials as options —
 * confirming ONCE with an array of selections.
 *
 * Empty-catalog state: the picker shows a friendly nudge to import the
 * Ligne Roset 10.2025 list from /admin/materials. We don't trigger the
 * import inline because the catalog is admin-scoped.
 */
export default function SwatchPicker({
  open, onClose, onSelect, onSelectMany, allowMultiSelect = false,
  currentGrade, currentFabric, family = null, nameFilter: nameFilterProp,
  showPalette = true,
}) {
  const { profileId } = useApp();
  // The quote's curated material library — surfaced first as quick-pick chips so
  // a compound's components get the project's fabrics in one tap. Hidden when
  // showPalette is false (the palette card uses this picker to BUILD the library,
  // not apply from it).
  const { materials: palette } = useContext(ProjectPaletteContext);
  const paletteList = showPalette && Array.isArray(palette) ? palette : [];
  const materials = useLiveQuery(
    () => (profileId ? db.materials.where('profileId').equals(profileId).toArray() : Promise.resolve([])),
    [profileId, open],   // re-query on open so a freshly-imported catalog shows up without remounting
    [],
  );

  // The offered-fabric allowlist. The caller (a product line / compound parent)
  // owns the model link and passes `nameFilter` in — for a compound that single
  // link governs every component. When no prop is given we fall back to a lookup
  // by this line's own model root, so a standalone use still filters.
  const useOwnLookup = nameFilterProp === undefined;
  const ownRec = useLiveQuery(
    () => (useOwnLookup && family?.root ? db.modelFabrics.get(family.root) : Promise.resolve(null)),
    [family?.root, open, useOwnLookup],
    null,
  );
  const nameFilter = useMemo(() => {
    if (nameFilterProp !== undefined) return nameFilterProp;
    return ownRec?.patternNames?.length ? new Set(ownRec.patternNames) : undefined;
  }, [nameFilterProp, ownRec]);

  const [title, setTitle] = useState('Elegir material');

  // Reset the heading every time the modal opens. The inner picker remounts
  // on open (Modal returns null while closed), so its own step state resets
  // too — a reopened picker never keeps the previous line's drilled material;
  // it immediately re-syncs the title via onTitleChange.
  useEffect(() => {
    if (open) setTitle('Elegir material');
  }, [open]);

  // material + color → the { grade, fabric, swatchImageId } shape the quote
  // line consumes. Pre-fill the swatch from the chosen color's own photo when
  // it has one; we deliberately do NOT fall back to another color's picture —
  // a wrong-colour swatch is worse than none.
  function toPick(material, color) {
    return {
      grade: material.grade || '',
      fabric: composeFabricLabel(material, color),
      swatchImageId: (color && color.imageId) || null,
    };
  }

  function commit(material, color) {
    onSelect(toPick(material, color));
    onClose();
  }

  function commitMany(picks) {
    onSelectMany?.(picks.map(({ material, color }) => toPick(material, color)));
    onClose();
  }

  return (
    <Modal open={open} onClose={onClose} title={title} size="lg">
      {/* Modal returns null while closed, so the picker below fully unmounts
          and remounts on reopen — its step state (and the autoDrill guard)
          reset without an explicit key. */}
      {open && (
        <>
          <ProjectPalettePicks
            palette={paletteList}
            onApply={(pick) => { onSelect?.(pick); onClose(); }}
          />
          <MaterialColorPicker
            materials={materials}
            family={family}
            nameFilter={nameFilter}
            currentGrade={currentGrade}
            currentFabric={currentFabric}
            autoDrill
            allowMultiSelect={allowMultiSelect}
            onPick={commit}
            onPickMany={commitMany}
            onTitleChange={setTitle}
          />
        </>
      )}
    </Modal>
  );
}
