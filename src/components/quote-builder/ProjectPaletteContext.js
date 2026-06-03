import { createContext } from 'react';

/**
 * A quote's curated material library ("Paleta del proyecto") — the fabrics the
 * designer pinned to this project — provided by the quote Workspace and read by
 * the SwatchPicker (to surface them first as quick-pick chips) and the palette
 * card (to manage them). Lives in its own module, like FamiliesContext /
 * MaterialsContext, so the provider and consumers don't import a context out of
 * the big line-item / picker components.
 *
 * Value shape: { materials: QuoteMaterial[], onAdd(pick), onAddMany(picks),
 * onRemove(id) }. `onAdd`/`onAddMany` take the picker's
 * { grade, fabric, swatchImageId } emit(s) (they stamp ids + dedupe); handlers
 * may be null on read-only surfaces. `onAddMany` appends a batch in one write so
 * a multi-select add doesn't clobber itself.
 */
export const ProjectPaletteContext = createContext({ materials: [], onAdd: null, onAddMany: null, onRemove: null });
