import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, ChevronDown, GripVertical, Copy, Tag, Layers, Plus, X, Palette, Check, Sparkles, GitFork, Boxes, Split, Combine, AlignLeft, StickyNote, PackageSearch, ImagePlus, Loader2, ExternalLink } from 'lucide-react';
import Thumbnail from '../primitives/Thumbnail.jsx';
import ImageView from '../ImageView.jsx';
import HeroInput from '../primitives/HeroInput.jsx';
import InlineEditor from '../primitives/InlineEditor.jsx';
import MoneyInput from '../primitives/MoneyInput.jsx';
import Select from '../primitives/Select.jsx';
import { DebouncedInput, DebouncedTextarea } from '../DebouncedInput.jsx';
import LineBreakdownPopover from './LineBreakdownPopover.jsx';
import FamilyPicker from './FamilyPicker.jsx';
import SwatchPicker from './SwatchPicker.jsx';
import MaterialPickerButton from './MaterialPickerButton.jsx';
import CatalogPicker from './CatalogPicker.jsx';
import MultiAddPicker from './MultiAddPicker.jsx';
import ModelLinkBar from './ModelLinkBar.jsx';
import { carryModelLink, clearModelFabrics } from '../../lib/lrModelFabrics.js';
import { FamiliesContext } from './FamiliesContext.js';
import { MaterialsContext } from './MaterialsContext.js';
import { useQuoteActions } from './QuoteActionsContext.js';
import { colorCodeFromSubtype, locateColor } from '../../lib/swatchMatch.js';
import { swatchUrl } from '../../lib/swatchImage.js';
import { materialOptionDeltas } from '../../lib/pricing.js';
import { splitSkuGrade, productForGrade, materiallessRangePatch, skuFillPatch } from '../../lib/catalog.js';
import { groupComponents, ungroupModule, renameModule, setModuleOptional, addModuleAlternative, selectModuleAlternative, isModularLine } from '../../lib/modules.js';
import { formatMoney } from '../../lib/format.js';
import { resolveLineItem } from '../../core/quote/views/lineItem.js';
import { parseSubtype, composeSubtype, GRADE_GROUPS, SPECIAL_GRADES, LEGACY_NAMED_GRADES } from '../../lib/subtype.js';
import { db, newId, saveImage } from '../../db/database.js';
import { useLiveQuery } from '../../db/hooks.js';

/**
 * One quote line — a product card read top→bottom:
 *
 *   1. Top strip      drag handle + family chip + READ-ONLY status badges
 *                     (Compuesto / Opcional / Conjunto N/M / Alternativa N/M)
 *   2. Identity band  thumbnail + name + grade/fabric chooser + spec strip
 *                     + an always-visible "Descripción" (visible in the PDF)
 *                     + an optional "Nota interna" (collapsed when empty)
 *   3. Calculator     qty × unit = total, on a tinted inset surface
 *   4. Footer         the per-line ACTION row — Compuesto, + Alternativa,
 *                     Opcional, Duplicar, Separar, Eliminar. The old "⋯"
 *                     overflow menu + "más detalles" disclosure are gone;
 *                     every action lives in the open on the card.
 *
 * Same anatomy on every viewport. On phones the bands stack vertically;
 * from sm up the identity and calculator bands sit side-by-side with the
 * calculator right-aligned. Layout is explicit at every breakpoint — no
 * flex-wrap fallback that drifts the money tower below the name.
 *
 * The grade + fabric pair is promoted from the legacy "Subtype" free-text
 * field via lib/subtype.js (parse on read, compose on write — no DB
 * migration). Grade is a native <Select> so iOS / Android use their built-
 * in picker UI; fabric is an inline editor next to it.
 *
 * Yardage, line-level margin AND the per-line discount input are
 * intentionally absent from the editor. Old quotes that carry
 * `lineMarginPct` / `lineDiscountPct` in the DB still calculate correctly
 * (pricing.js respects the value, and the read-only AdjustmentChip surfaces
 * it on the total), but new lines never set them and the UI never lets you
 * edit them.
 *
 * autoFocus targets the REF input — the dealer's primary entry point when
 * reading from a paper price list.
 */
export default function QuoteLineItem({
  line, quote, onChange, onRemove, onDuplicate,
  onToggleOptional, onAddAlternative, onSelectAlternative,
  onSeparateFromSet, onUngroup, insideGroupCard,
  groupInfo, setInfo,
  autoFocus, dragHandleProps,
}) {
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const refInput = useRef(null);

  useEffect(() => {
    if (autoFocus && refInput.current) {
      refInput.current.focus();
      refInput.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }
  }, [autoFocus]);

  const currency = quote.currencyCode || 'USD';
  const rates = quote.rates || { USD: 1 };
  // All per-line DISPLAY derivation lives in the ViewModel — the card reads
  // fields, never computes them. Currency formatting stays here (the VM is a
  // plain-data projection, rate-agnostic) via the `fmt` closure below.
  const vm = useMemo(() => resolveLineItem(line), [line]);
  const compound = vm.isCompound;
  // Catalog families (keyed by SKU root) — used by applyComponentMaterialToAll
  // to re-price a material-less RANGE sibling at the propagated grade, exactly
  // as GradeFabricRow.commit does for a single pick.
  const families = useContext(FamiliesContext);
  // The product line's Ligne Roset link governs its material picker(s). A SIMPLE
  // line is keyed by its model root (so the link persists per model across every
  // quote); a COMPOUND is keyed by the line id, so one link applies to EVERY
  // component within. Resolved here so the IdentityBand and the ComponentsPanel
  // share the same record.
  const modelKey = compound ? line.id : splitSkuGrade(line.reference).root;
  const modelRec = useLiveQuery(
    () => (modelKey ? db.modelFabrics.get(modelKey) : Promise.resolve(null)),
    [modelKey],
    null,
  );
  const modelNameFilter = useMemo(
    () => (modelRec?.patternNames?.length ? new Set(modelRec.patternNames) : undefined),
    [modelRec],
  );
  const modelSourceUrl = modelRec?.sourceUrl || null;
  const unit = vm.unitNet;
  const rowTotal = vm.subtotal;
  // Material-less RANGE line — priced cheapest→priciest grade until a fabric is
  // picked. Shows a range band instead of the qty × unit = total calculator.
  const range = vm.isRange;
  const totalRange = vm.range;
  const fmt = (v) => formatMoney(v, currency, rates);
  // Only render the adjustment chip when there's a live discount or a legacy
  // margin to explain (gate resolved in the VM as `hasAdjustment`).
  const hasAdjustment = vm.hasAdjustment;

  // ----- compound mutations -----
  function addComponent() {
    const components = Array.isArray(line.components) ? [...line.components] : [];
    components.push(makeBlankComponent());
    onChange({ components });
  }
  // Bulk-add from the multi-add picker — each catalog seed becomes a component
  // (priced at the chosen grade, or a price RANGE when no grade was picked). On
  // a MODULAR line the run is stamped as ONE module (a component product) so the
  // dealer assembles a modular module-by-module; on a plain component product it
  // just appends the elements flat. Either way the compound subtotal re-sums.
  function addComponentsFromSeeds(seeds) {
    if (!seeds?.length) return;
    const existing = Array.isArray(line.components) ? line.components : [];
    const moduleGroup = isModular ? newId() : null;
    const moduleName = isModular ? (seeds.find((s) => s.name)?.name || '') : null;
    const additions = seeds.map((s) => makeBlankComponent({
      name: s.name || '',
      reference: s.reference || '',
      dimensions: s.dimensions || '',
      subtype: s.subtype || '',
      qty: 1,
      unitPrice: s.unitPrice || 0,
      swatchImageId: s.swatchImageId ?? null,
      priceMin: s.priceMin ?? null,
      priceMax: s.priceMax ?? null,
      ...(moduleGroup ? { moduleGroup, moduleName } : {}),
    }));
    onChange({ components: [...existing, ...additions] });
  }
  function updateComponent(id, patch) {
    const components = (line.components || []).map((c) =>
      c.id === id ? { ...c, ...patch } : c,
    );
    onChange({ components });
  }
  function removeComponent(id) {
    const remaining = (line.components || []).filter((c) => c.id !== id);
    onChange({ components: healComponentAlternatives(remaining) });
  }
  function reorderComponents(orderedIds) {
    const byId = new Map((line.components || []).map((c) => [c.id, c]));
    const components = orderedIds.map((id) => byId.get(id)).filter(Boolean);
    onChange({ components });
  }
  // "Apply this component's material to all the others" — the pick-once shortcut.
  // Copies the source's grade + fabric (subtype) and colour swatch onto every
  // sibling, mirroring GradeFabricRow.commit per piece: each sibling is repriced
  // to ITS OWN model at the grade (reference + price re-snapshotted, any range
  // dropped) — a grade is a price tier, so the price + SKU letter must follow.
  function applyComponentMaterialToAll(sourceId) {
    const comps = Array.isArray(line.components) ? line.components : [];
    const src = comps.find((c) => c.id === sourceId);
    if (!src) return;
    const { grade, fabric } = parseSubtype(src.subtype);
    applyMaterialToAllComponents({ grade, fabric, swatchImageId: src.swatchImageId ?? null });
  }
  // "Apply a CHOSEN material to all components" — the header twin of
  // applyComponentMaterialToAll, fed by the composition-header SwatchPicker
  // instead of a source component. Stamps the picked grade + fabric (subtype)
  // and swatch onto EVERY component AND reprices each to ITS OWN model at the
  // grade (reference + price re-snapshotted, any range dropped) exactly as
  // GradeFabricRow.commit does for a single pick. A grade is a price tier, so
  // applying it must move every piece's price + SKU letter — not just the
  // material-less RANGE pieces — else an already-priced component keeps its old
  // grade's price/reference while showing the new fabric (the reported bug).
  function applyMaterialToAllComponents({ grade, fabric, swatchImageId }) {
    const comps = Array.isArray(line.components) ? line.components : [];
    if (!comps.length) return;
    const subtype = composeSubtype(grade, fabric);
    const swatch = swatchImageId ?? null;
    const components = comps.map((c) => {
      const patch = { subtype, swatchImageId: swatch };
      if (grade) {
        const fam = families?.get(splitSkuGrade(c.reference).root) || null;
        const p = fam ? productForGrade(fam, grade) : null;
        // Reprice to this component's own SKU at the grade (no-op when the grade
        // is unchanged; left intact when its model doesn't carry the grade).
        if (p) {
          patch.reference = p.reference;
          patch.unitPrice = Number(p.priceUsd) || 0;
        }
        if (c.priceMin != null || c.priceMax != null) {
          patch.priceMin = null;
          patch.priceMax = null;
        }
      }
      return { ...c, ...patch };
    });
    onChange({ components });
  }
  // Component-level ALTERNATIVE (pick-one among sub-pieces) — the compound twin
  // of addAlternative: assign the source a group (selecting it if new), then
  // insert a copy right after as another, non-selected option.
  function addComponentAlternative(componentId) {
    const comps = Array.isArray(line.components) ? line.components : [];
    const src = comps.find((c) => c.id === componentId);
    if (!src || src.isOptional) return;  // optional ⊕ alternative are exclusive
    const groupId = src.alternativeGroup || newId();
    const dup = { ...src, id: newId(), alternativeGroup: groupId, isSelectedAlternative: false, optionalOffered: false, isOptional: false };
    const next = [];
    for (const c of comps) {
      if (c.id === componentId) {
        next.push({
          ...c,
          alternativeGroup: groupId,
          // First time grouping this piece → it becomes the selected option.
          isSelectedAlternative: c.alternativeGroup ? !!c.isSelectedAlternative : true,
        });
        next.push(dup);
      } else {
        next.push(c);
      }
    }
    onChange({ components: next });
  }
  function selectComponentAlternative(componentId) {
    const comps = Array.isArray(line.components) ? line.components : [];
    const target = comps.find((c) => c.id === componentId);
    if (!target?.alternativeGroup) return;
    const g = target.alternativeGroup;
    onChange({
      components: comps.map((c) =>
        c.alternativeGroup === g ? { ...c, isSelectedAlternative: c.id === componentId } : c,
      ),
    });
  }
  // ----- modules: the catalog-agnostic grouping that makes a compound line a
  // MODULAR product (see lib/modules). Purely structural over the components
  // array — no catalog lookup, no model-specific data — so the compound subtotal
  // re-sums on its own and each module's roll-up always folds back into it.
  const isModular = isModularLine(line);
  function setModular(on) {
    onChange({ compoundKind: on ? 'modular' : 'componentProduct' });
  }
  // Group the given component ids into one named module (a component product).
  function groupIntoModule(ids, name) {
    // Do NOT write compoundKind here — quote_lines has no compound_kind column
    // (the modular refactor shipped without that migration), so including it
    // makes the whole patch fail and silently revert. A component's moduleGroup
    // already makes isModularLine true, which is all the grouped view needs.
    const next = groupComponents(line.components, ids, name, newId);
    if (next) onChange({ components: next });
  }
  // Turn ONE component line into its own component product (a named producto of
  // one) directly from the line — no select-many-then-group dance. The dealer
  // then fills it with the product's "Agregar componente".
  function makeComponentProduct(componentId) {
    groupIntoModule([componentId]);
  }
  // Add a blank componente INTO an existing producto (module), the per-product
  // "Agregar componente", so a component product is built up piece by piece.
  function addComponentToModule(moduleGroup) {
    const comps = Array.isArray(line.components) ? line.components : [];
    const moduleName = comps.find((c) => c.moduleGroup === moduleGroup)?.moduleName || '';
    onChange({ components: [...comps, makeBlankComponent({ moduleGroup, moduleName })] });
  }
  function ungroupModuleById(moduleGroup) {
    onChange({ components: ungroupModule(line.components, moduleGroup) });
  }
  function renameModuleById(moduleGroup, name) {
    onChange({ components: renameModule(line.components, moduleGroup, name) });
  }
  // Offer a WHOLE module (a component product) as an optional add-on, or fold it
  // back in — the module twin of the line/component optional toggle.
  function toggleModuleOptional(moduleGroup, optional) {
    onChange({ components: setModuleOptional(line.components, moduleGroup, optional) });
  }
  // Offer a module (component product) as a pick-one ALTERNATIVE, and select among
  // the siblings — the module twin of the line-level alternative.
  function addModuleAlternativeById(moduleGroup) {
    const next = addModuleAlternative(line.components, moduleGroup, newId);
    if (next) onChange({ components: next });
  }
  function selectModuleAlternativeById(moduleGroup) {
    onChange({ components: selectModuleAlternative(line.components, moduleGroup) });
  }
  function convertToCompound() {
    // Promote the current line's own ref/subtype/dimensions/description/
    // qty/unitPrice into the first component, then clear those columns
    // on the parent — keeps the dealer's work intact through the
    // toggle. Family + image + name stay on the parent because they're
    // the shared identity of the compound.
    // Captured BEFORE onChange clears `reference`: where a simple-line model
    // link is stored (its SKU family root). The compound will key its link by
    // line.id instead, so carry the link across the shape change — otherwise
    // the just-linked model's offered-fabric restriction is orphaned and every
    // component's picker silently shows all in-grade fabrics again.
    const priorRoot = splitSkuGrade(line.reference).root;
    const seed = makeBlankComponent({
      name: '',
      reference: line.reference || '',
      subtype: line.subtype || '',
      dimensions: line.dimensions || '',
      description: line.description || '',
      qty: line.qty ?? 1,
      unitPrice: line.unitPrice ?? 0,
    });
    onChange({
      components: [seed],
      reference: '',
      subtype: '',
      dimensions: '',
      description: '',
      qty: 1,
      unitPrice: 0,
    });
    // Copy (don't move) the SKU-root link onto the line id: the root link still
    // serves other quotes' simple lines of this model. Fire-and-forget; the
    // live query repaints the ModelLinkBar + re-filters the pickers when it lands.
    carryModelLink(priorRoot, line.id);
  }
  function dissolveCompound() {
    // Promote the first component back onto the parent line and drop
    // the rest. The dealer can re-add them as separate lines if they
    // want — silently discarding multi-component work would be worse.
    const first = (line.components || [])[0];
    const restoredRef = first?.reference || line.reference || '';
    onChange({
      components: [],
      reference: restoredRef,
      subtype: first?.subtype || line.subtype || '',
      dimensions: first?.dimensions || line.dimensions || '',
      description: first?.description || line.description || '',
      qty: first?.qty ?? line.qty ?? 1,
      unitPrice: first?.unitPrice ?? line.unitPrice ?? 0,
    });
    // The link's key flips back from line.id to the restored SKU root: carry it
    // onto the root (unless the root already carries its own per-model link),
    // then drop the now-unreachable line-id record so a later re-convert starts
    // from the authoritative root link rather than a stale snapshot.
    const restoredRoot = splitSkuGrade(restoredRef).root;
    carryModelLink(line.id, restoredRoot).then(() => clearModelFabrics(line.id));
  }

  // Deactivated (optional) or non-selected alternative: the row reads as
  // "off". We fade it with a white veil overlay (not row opacity) so the
  // fabric swatch — lifted to z-[2] in GradeFabricRow — stays full-colour
  // while the product photo, text and prices dim. Same treatment the
  // client preview and the PDF export use.
  const dimmed = vm.dimmed;

  return (
    // qli-row turns each row into its own container-query root, so the
    // body below reflows based on this row's width — not the viewport's.
    // That's how the line item reads correctly whether it lives in the
    // full-width builder, in a narrowed editor when the PDF panel is
    // open, or in some future drawer / inspector pane. CSS in
    // src/index.css owns the breakpoints.
    // Visual cues for the option flags:
    //   • optional lines     dashed left accent + faint background tint
    //                        + white veil (deactivated).
    //   • alternative groups solid brand-color left accent unifying
    //                        the contiguous siblings.
    //   • non-selected sibs  white veil on top of the accent so the
    //                        selected one wins the eye.
    <li
      className={`qli-row group relative transition-colors duration-150 hover:bg-ink-50/40 ${
        line.isOptional ? 'border-l-2 border-dashed border-ink-300 bg-ink-50/30' : ''
      } ${
        // Per-line group accents are drawn by the wrapping GroupCard when
        // this line lives inside one (insideGroupCard) — don't double them.
        // A standalone alternative line (mid-edit, before the card forms)
        // keeps its own accent as a fallback.
        !insideGroupCard && line.alternativeGroup ? 'border-l-2 border-solid border-brand-300' : ''
      }`}
    >
      {dimmed && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/55" aria-hidden />
      )}
      <TopStrip
        family={line.family}
        onPickFamily={(value) => onChange({ family: value || '' })}
        compound={compound}
        isOptional={!!line.isOptional}
        alternativeGroup={line.alternativeGroup}
        isSelectedAlternative={!!line.isSelectedAlternative}
        setGroup={line.setGroup}
        groupInfo={groupInfo}
        setInfo={setInfo}
        insideGroupCard={insideGroupCard}
        onSelectAlternative={onSelectAlternative}
        dragHandleProps={dragHandleProps}
      />

      <div className="qli-body mt-1.5">
        <IdentityBand
          line={line}
          compound={compound}
          onChange={onChange}
          refInputRef={refInput}
          currency={currency}
          rates={rates}
          modelKey={modelKey}
          modelRec={modelRec}
          nameFilter={modelNameFilter}
          sourceUrl={modelSourceUrl}
        />
        {compound ? (
          <CompoundCalculatorBand
            line={line}
            compound={vm.compound}
            rowTotal={rowTotal}
            fmt={fmt}
            hasAdjustment={hasAdjustment}
            breakdownOpen={breakdownOpen}
            onToggleBreakdown={() => setBreakdownOpen((v) => !v)}
            onCloseBreakdown={() => setBreakdownOpen(false)}
            currency={currency}
            rates={rates}
          />
        ) : range ? (
          <RangeBand line={line} totalRange={totalRange} fmt={fmt} onChange={onChange} />
        ) : (
          <CalculatorBand
            line={line}
            unit={unit}
            lineTotal={rowTotal}
            fmt={fmt}
            hasAdjustment={hasAdjustment}
            breakdownOpen={breakdownOpen}
            onChange={onChange}
            onToggleBreakdown={() => setBreakdownOpen((v) => !v)}
            onCloseBreakdown={() => setBreakdownOpen(false)}
            currency={currency}
            rates={rates}
          />
        )}
      </div>

      {compound && (
        <ComponentsPanel
          line={line}
          components={vm.components}
          currency={currency}
          rates={rates}
          fmt={fmt}
          nameFilter={modelNameFilter}
          sourceUrl={modelSourceUrl}
          onAdd={addComponent}
          onUpdate={updateComponent}
          onRemove={removeComponent}
          onReorder={reorderComponents}
          onAddAlternative={addComponentAlternative}
          onSelectAlternative={selectComponentAlternative}
          onApplyToAll={applyComponentMaterialToAll}
          onApplyMaterialToAll={applyMaterialToAllComponents}
          isModular={isModular}
          modules={vm.modules}
          onSetModular={setModular}
          onGroupModule={groupIntoModule}
          onUngroupModule={ungroupModuleById}
          onRenameModule={renameModuleById}
          onToggleModuleOptional={toggleModuleOptional}
          onAddModuleAlternative={addModuleAlternativeById}
          onSelectModuleAlternative={selectModuleAlternativeById}
          onMakeProduct={makeComponentProduct}
          onAddToProduct={addComponentToModule}
          onAddMany={addComponentsFromSeeds}
        />
      )}

      <LineFooter
        compound={compound}
        isOptional={!!line.isOptional}
        alternativeGroup={line.alternativeGroup}
        setGroup={line.setGroup}
        onConvertToCompound={convertToCompound}
        onDissolveCompound={dissolveCompound}
        onAddAlternative={onAddAlternative}
        onToggleOptional={onToggleOptional}
        onDuplicate={onDuplicate}
        onSeparateFromSet={onSeparateFromSet}
        onUngroup={onUngroup}
        onRemove={onRemove}
      />
    </li>
  );
}

// New compound components start with their own id so React keys stay
// stable across reorders / edits. Pass overrides to seed values from
// an existing line being converted to compound.
function makeBlankComponent(overrides = {}) {
  return {
    id: newId(),
    name: '',
    reference: '',
    subtype: '',
    dimensions: '',
    description: '',
    qty: 1,
    unitPrice: 0,
    ...overrides,
  };
}

// Keep component alternative groups well-formed after a removal: a group that
// drops to a SINGLE member dissolves back to a normal component, and a group
// that lost its selected member promotes its first survivor — so a removed
// option can never leave an orphan that's silently excluded from the total.
function healComponentAlternatives(components) {
  const counts = new Map();
  const hasSelected = new Map();
  for (const c of components) {
    if (!c?.alternativeGroup) continue;
    counts.set(c.alternativeGroup, (counts.get(c.alternativeGroup) || 0) + 1);
    if (c.isSelectedAlternative) hasSelected.set(c.alternativeGroup, true);
  }
  const promoted = new Set();
  return components.map((c) => {
    const g = c?.alternativeGroup;
    if (!g) return c;
    if (counts.get(g) === 1) {
      // Lone survivor → no longer an alternative.
      const { alternativeGroup, isSelectedAlternative, ...rest } = c;
      return rest;
    }
    if (!hasSelected.get(g) && !promoted.has(g)) {
      promoted.add(g);
      return { ...c, isSelectedAlternative: true };
    }
    return c;
  });
}

// ---------------------------------------------------------------------------
// Top strip — drag handle + family chip + READ-ONLY status badges. The chip
// is a direct button that opens FamilyPicker; previously the only path to
// set a family was to expand the row, scroll to the Catálogo group, and type
// the string by hand (the dealer's words: "I don't like that I have to write
// family name there for it to show up above. That's stupid."). One tap now.
//
// The TopStrip carries IDENTITY + STATE only: family + the Compuesto /
// Opcional / Conjunto N/M / Alternativa N/M badges. All row ACTIONS
// (convert, alternativa, opcional, duplicar, separar, eliminar) moved to
// the per-line LineFooter at the bottom of the card, so there's no longer
// an action cluster pinned to the right edge here.
// ---------------------------------------------------------------------------
function TopStrip({
  family, onPickFamily, compound,
  isOptional, alternativeGroup, isSelectedAlternative, groupInfo,
  setGroup, setInfo, insideGroupCard,
  onSelectAlternative,
  dragHandleProps,
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <div className="flex items-center gap-2 mb-2.5 -ml-1">
      <span
        {...(dragHandleProps || {})}
        className="hidden sm:inline-flex items-center cursor-grab text-ink-300 hover:text-ink-700 opacity-0 group-hover:opacity-60 hover:!opacity-100 transition-opacity"
        title="Arrastra para reordenar"
        aria-label="Arrastrar para reordenar"
      >
        <GripVertical size={14} />
      </span>

      {/* Alternative-radio at the leftmost position when this line is
          in an alternative group. Clicking flips the group's selection
          to this line. Reading order: radio → family → status pills
          → actions. The radio sits BEFORE family because it's the
          primary affordance for an alternative-group member. */}
      {alternativeGroup && (
        <button
          type="button"
          onClick={onSelectAlternative}
          className={`inline-flex items-center justify-center w-5 h-5 rounded-full border-2 transition-colors flex-shrink-0 ${
            isSelectedAlternative
              ? 'border-brand-500 bg-brand-500 text-white'
              : 'border-ink-300 bg-white hover:border-brand-400'
          }`}
          title={isSelectedAlternative ? 'Alternativa seleccionada' : 'Seleccionar esta alternativa'}
          aria-pressed={isSelectedAlternative}
          aria-label="Seleccionar alternativa"
        >
          {isSelectedAlternative && <Check size={11} strokeWidth={3} />}
        </button>
      )}

      {family ? (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="chip text-brand-700 bg-brand-50 border border-brand-100 hover:bg-brand-100 hover:border-brand-200"
          title="Cambiar familia"
          aria-label={`Familia ${family}. Cambiar`}
        >
          {family}
          <ChevronDown size={10} className="-mr-0.5 opacity-70" aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="chip font-medium text-ink-500 hover:text-ink-900 border border-dashed border-ink-300 hover:border-ink-500"
          aria-label="Asignar familia"
        >
          <Tag size={10} className="opacity-70" aria-hidden />
          Asignar familia
        </button>
      )}

      {/* Read-only status badges. Order: Modular → Opcional → Alternativa
          → Conjunto. Multiple can show concurrently when a modular product is
          in an alternative group; isOptional+alternative is forbidden by the DB
          so those two are visually mutually exclusive too. These are NON-
          interactive labels — the matching toggles (Modular, Opcional) live in
          the per-line LineFooter. */}
      {compound && (
        <span
          className="chip text-ink-600 bg-ink-100 border border-ink-200"
          title="Producto modular"
        >
          <Layers size={10} className="opacity-80" aria-hidden />
          Modular
        </span>
      )}

      {/* Opcional badge — read-only. Shown only when the line IS optional;
          the on/off toggle (and its "Hacer opcional" affordance) lives in
          the footer. Hidden for grouped lines, where optional is forbidden. */}
      {isOptional && (
        <span
          className="chip text-ink-600 bg-ink-50 border border-dashed border-ink-300"
          title="Línea opcional — se muestra pero no suma al total"
        >
          <Sparkles size={10} className="opacity-80" aria-hidden />
          Opcional
        </span>
      )}

      {/* Group position chips. When the line is wrapped in a GroupCard the
          card's header/footer already carries the "Conjunto" / "Alternativas"
          identity, so we render only a quiet "N/M" position pill inside the
          card to avoid doubling the label. Outside a card (a momentary
          mid-edit single line) the full labelled chip still shows. */}
      {alternativeGroup && groupInfo && (
        <span
          className="chip text-brand-700 bg-brand-50 border border-brand-100"
          title="Esta línea es parte de un grupo de alternativas; solo la seleccionada cuenta en el total"
        >
          {insideGroupCard ? `${groupInfo.index}/${groupInfo.total}` : `Alternativa ${groupInfo.index}/${groupInfo.total}`}
        </span>
      )}

      {setGroup && (
        <span
          className="chip text-ink-600 bg-ink-100 border border-ink-200"
          title="Esta línea forma parte de un conjunto; todas las piezas se cotizan y suman al total"
        >
          <Boxes size={10} className="opacity-80" aria-hidden />
          {insideGroupCard
            ? (setInfo ? `${setInfo.index}/${setInfo.total}` : 'Conjunto')
            : `Conjunto${setInfo ? ` ${setInfo.index}/${setInfo.total}` : ''}`}
        </span>
      )}

      <div className="flex-1" />

      <FamilyPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(value) => onPickFamily(value)}
        currentFamily={family || ''}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Identity band — thumbnail · name · grade/fabric · spec strip.
//
// Grade + fabric are promoted from the legacy DetailsPanel to the always-
// visible band because fabric grade is what drives price; hiding it behind
// a disclosure made the dealer hunt for the most-used control.
// ---------------------------------------------------------------------------
function IdentityBand({ line, compound, onChange, refInputRef, currency, rates, modelKey, modelRec, nameFilter, sourceUrl }) {
  // Layout: product photo + name on top; the ref/dimensions strip and
  // the swatch + material (grade/fabric) stack BELOW them, full width —
  // not squeezed into a narrow column beside the photo. Material sits
  // under the spec to match the PDF and client preview.
  //
  // In compound mode the parent only carries the *shared* identity —
  // family (a chip in the TopStrip), photo, and the composition name.
  // The per-product grade/fabric + spec strip live inside each component.
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const families = useContext(FamiliesContext);

  // Pick the line's product from the catalog with the SAME flow as adding a
  // line — model → material + color OR "sin material · cotizar por rango" — so
  // selecting a product always prompts for the material (or a range). Applies
  // the catalog seed to this line and resets any prior alternative materials.
  function insertProductToLine(seed) {
    onChange({
      family: seed.family ?? line.family,
      reference: seed.reference,
      name: seed.name,
      dimensions: seed.dimensions,
      subtype: seed.subtype,
      unitPrice: seed.unitPrice,
      unitCost: seed.unitCost ?? null,
      swatchImageId: seed.swatchImageId ?? null,
      priceMin: seed.priceMin ?? null,
      priceMax: seed.priceMax ?? null,
      materialOptions: null,
    });
  }

  return (
    <div className="flex-1 min-w-0 space-y-2.5">
      <div className="flex items-start gap-3">
        <CoverPhoto line={line} onChange={onChange} />
        <div className="flex-1 min-w-0 space-y-2.5">
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <HeroInput
                placeholder={compound ? 'Nombre de la composición' : 'Nombre del artículo'}
                value={line.name || ''}
                onCommit={(v) => onChange({ name: v })}
                autoCapitalize="words"
                enterKeyHint="next"
              />
            </div>
            {/* Product selector — opens the full catalog flow (model → material +
                color OR a price range), the same one the Catálogo button uses, so
                picking a product prompts for its material. Simple lines only (a
                compound's product identity lives per-component, not on the parent). */}
            {!compound && (
              <button
                type="button"
                onClick={() => setProductPickerOpen(true)}
                className="inline-flex items-center justify-center w-8 h-8 coarse:w-10 coarse:h-10 rounded-md text-ink-400 hover:text-brand-700 hover:bg-brand-50 transition-colors flex-shrink-0"
                title="Elegir el producto del catálogo"
                aria-label="Elegir el producto del catálogo"
              >
                <PackageSearch size={15} />
              </button>
            )}
          </div>
          {/* Extra product angles — a horizontal, responsive strip that flows
              across the width beside the cover (flex-wrap), so the thumbnails
              spread out instead of stacking in a narrow column that strands dead
              space to the right. */}
          <ExtraPhotos line={line} onChange={onChange} />
        </div>
      </div>
      {!compound && (
        <SpecStrip
          reference={line.reference}
          dimensions={line.dimensions}
          onChangeReference={(v) => onChange(skuFillPatch(families, v))}
          onChangeDimensions={(v) => onChange({ dimensions: v })}
          refInputRef={refInputRef}
        />
      )}
      {/* Ligne Roset link for THIS product line — restricts the material
          picker(s) to the model's offered fabrics. On a compound it governs
          every component within (the components inherit this link). */}
      {modelKey && <ModelLinkBar root={modelKey} record={modelRec} />}
      {!compound && <GradeFabricRow line={line} onChange={onChange} currency={currency} rates={rates} nameFilter={nameFilter} sourceUrl={sourceUrl} />}
      {/* Descripción (PDF-facing) + Nota interna (private) collapse to two
          inline icons — the least vertical space — each expanding its field on
          click. A compound carries no line-level description (its components
          do), so only the note icon shows there. */}
      <LineNotes
        showDescription={!compound}
        description={line.description || ''}
        onChangeDescription={(v) => onChange({ description: v })}
        note={line.notes || ''}
        onChangeNote={(v) => onChange({ notes: v })}
      />
      {!compound && (
        <CatalogPicker
          open={productPickerOpen}
          onClose={() => setProductPickerOpen(false)}
          onInsert={insertProductToLine}
        />
      )}
    </div>
  );
}

// Product photos for a line — the COVER (the big Thumbnail every surface that
// shows one image keeps using) plus a strip of ADDITIONAL photos so the dealer
// can attach several angles the client sees on the share link. Extras live in
// line.extraImageIds; each reuses the same Thumbnail (so drag/drop, paste,
// validation and delete-on-remove come for free), and a trailing tile appends.
function CoverPhoto({ line, onChange }) {
  return (
    <div className="flex-shrink-0">
      <Thumbnail
        imageId={line.imageId}
        onChange={(id) => onChange({ imageId: id })}
        kind="quote-line"
        ownerId={line.id}
        hoverPreview
      />
    </div>
  );
}

// Additional product angles the client sees on the share link — a horizontal,
// responsive strip that flows across the available width (flex-wrap) beside the
// cover, instead of stacking in a narrow column that strands dead space to the
// right. Extras live in line.extraImageIds; a trailing tile appends a new one.
function ExtraPhotos({ line, onChange }) {
  const extra = Array.isArray(line.extraImageIds) ? line.extraImageIds : [];
  // Store null (not []) when empty so the field reads "no extras" cleanly.
  const setExtra = (next) => onChange({ extraImageIds: next.length ? next : null });
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {extra.map((id, i) => (
        <Thumbnail
          key={id}
          imageId={id}
          onChange={(nid) => {
            const next = extra.slice();
            if (nid) next[i] = nid; else next.splice(i, 1);
            setExtra(next);
          }}
          kind="quote-line"
          ownerId={line.id}
          sizeClass="w-12 h-12"
          hoverPreview
        />
      ))}
      <AddPhotoTile kind="quote-line" ownerId={line.id} onAdd={(id) => setExtra([...extra, id])} />
    </div>
  );
}

// Small "+ add another photo" tile beside a line's extra photos. Uploads via
// saveImage (same validation/limits as Thumbnail) and hands the new id up to
// append. Supports click and drag-drop, like the main thumbnail.
function AddPhotoTile({ kind, ownerId, onAdd }) {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  async function handleFiles(files) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    try { onAdd(await saveImage({ kind, ownerId, file })); }
    catch (e) { console.error('[quote] add photo failed', e); }
    finally { setBusy(false); }
  }
  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); handleFiles(e.dataTransfer.files); }}
        disabled={busy}
        title="Agregar otra foto"
        aria-label="Agregar otra foto al artículo"
        className="inline-flex h-12 w-12 items-center justify-center rounded-md border-2 border-dashed border-ink-300 bg-ink-50 text-ink-400 transition-colors hover:border-ink-500 hover:bg-ink-100 hover:text-ink-700 disabled:opacity-60"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <ImagePlus size={14} />}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
      />
    </>
  );
}

// Auto-growing multi-line text field for the always-visible Descripción and
// the internal-note reveal. Wraps the shared <DebouncedTextarea> (debounced
// commit on type/blur) and drives the same scrollHeight auto-resize HeroInput
// uses, so long copy wraps and the field grows instead of scrolling. Unlike
// HeroInput it ALLOWS Enter (these are paragraphs, not one-line titles) and
// reads with the muted body weight of an inline note, not a heading.
function AutoGrowTextarea({ value, onCommit, label, placeholder, ...rest }) {
  const ref = useRef(null);
  useEffect(() => { autoSize(ref.current); }, [value]);
  return (
    <DebouncedTextarea
      ref={ref}
      value={value}
      onCommit={onCommit}
      rows={1}
      placeholder={placeholder}
      aria-label={label || placeholder}
      onInput={(e) => autoSize(e.currentTarget)}
      className="block w-full bg-transparent border-0 px-1 -mx-1 py-1 rounded resize-none overflow-hidden text-[13px] coarse:text-sm leading-snug text-ink-700 placeholder:text-ink-300 hover:bg-ink-50 focus:bg-white focus:shadow-[inset_0_0_0_1px_theme('colors.ink.200')] focus:outline-none transition-colors"
      {...rest}
    />
  );
}

function autoSize(el) {
  if (!el) return;
  // Reset to auto first so deleting content shrinks the field back down —
  // otherwise the height latches at the previous scrollHeight.
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// Descripción + Nota interna, collapsed to two inline icons so they cost the
// least vertical space. Each toggles its own auto-growing field open on click;
// a field that already carries copy shows a filled dot, and the hover tooltip
// previews that copy (or states the field's purpose when empty) — so the dealer
// reads it without expanding. Descripción is PDF-facing; the note never prints.
function LineNotes({ showDescription, description, onChangeDescription, note, onChangeNote }) {
  const [descOpen, setDescOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1">
        {showDescription && (
          <NoteToggle
            icon={AlignLeft}
            label="Descripción · visible en el PDF"
            content={description}
            open={descOpen}
            onClick={() => setDescOpen((v) => !v)}
          />
        )}
        <NoteToggle
          icon={StickyNote}
          label="Nota interna · no se imprime"
          content={note}
          open={noteOpen}
          onClick={() => setNoteOpen((v) => !v)}
        />
      </div>
      {showDescription && descOpen && (
        <AutoGrowTextarea
          value={description}
          onCommit={onChangeDescription}
          label="Descripción · visible en el PDF"
          placeholder="Descripción · visible en el PDF"
          autoCapitalize="sentences"
          autoFocus
        />
      )}
      {noteOpen && (
        <AutoGrowTextarea
          value={note}
          onCommit={onChangeNote}
          label="Notas internas · no se imprimen"
          placeholder="Notas internas · no se imprimen"
          autoCapitalize="sentences"
          autoFocus
        />
      )}
    </div>
  );
}

// One collapsed note icon. Brand-tinted (with a dot) once its field carries
// copy, pressed-looking while its field is open; an elegant hover tooltip
// previews the copy, or explains the field's purpose when it's still empty.
function NoteToggle({ icon: Icon, label, content, open, onClick }) {
  const hasContent = !!(content && content.trim());
  const active = open || hasContent;
  const tip = hasContent ? content.trim() : label;
  return (
    <span className="group/note relative inline-flex">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        aria-expanded={open}
        className={`relative inline-flex items-center justify-center w-7 h-7 coarse:w-9 coarse:h-9 rounded-md transition-colors ${
          active ? 'text-brand-700 hover:bg-brand-50' : 'text-ink-400 hover:text-ink-700 hover:bg-ink-50'
        } ${open ? 'bg-brand-50' : ''}`}
      >
        <Icon size={14} />
        {hasContent && !open && (
          <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-brand-500 ring-2 ring-white" aria-hidden />
        )}
      </button>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-0 z-20 mb-1.5 w-max max-w-[260px] whitespace-pre-line rounded-md bg-ink-900 px-2.5 py-1.5 text-[11px] font-medium leading-snug text-white shadow-soft opacity-0 transition-opacity duration-150 group-hover/note:opacity-100"
      >
        {tip}
      </span>
    </span>
  );
}

// Grade + fabric editor. The grade dropdown displays just the short label
// (a letter, "Cuir", "COM") so the row reads tightly even when the device
// is narrow; the full "Grade X" name lives in the option list, grouped
// via <optgroup> so the menu still telegraphs the convention. Both
// controls write into the single `subtype` column on every commit via
// composeSubtype, so on-disk format is identical to what dealers have
// always typed — no migration, no PDF / autocomplete churn.
function GradeFabricRow({ line, onChange, currency = 'USD', rates, nameFilter, sourceUrl }) {
  const { rememberSwatch } = useQuoteActions();
  const families = useContext(FamiliesContext);
  const materials = useContext(MaterialsContext);
  const { grade, fabric } = parseSubtype(line.subtype);
  // Resolve this line's catalog family from its reference root so the
  // material-option chips can show a list-price delta. A line with no (or a
  // non-graded) reference simply yields no family → deltas read as 0.
  const family = families?.get(splitSkuGrade(line.reference).root) || null;
  // The model link (offered-fabric allowlist `nameFilter` + `sourceUrl` for the
  // "Ver en Ligne Roset" jump) is owned by the product line and passed in, so a
  // COMPOUND's single link governs every component within.
  const materialOptions = line.materialOptions || null;
  // When a swatch is attached inline, also remember it in the catalog so the
  // next quote that picks the same material/color is pre-filled. The catalog
  // persistence — which row, and where profileId comes from — lives in the
  // action layer; the row just says "remember this material's swatch".
  // Fire-and-forget; never blocks or fails the line edit.
  const setSwatch = (id) => {
    onChange({ swatchImageId: id });
    rememberSwatch(line.subtype, id);
  };
  // commit() always writes the composed subtype. When the picker hands
  // back a swatchImageId we persist it too; manual grade/fabric edits
  // (which don't carry the key) leave any existing swatch untouched.
  const commit = (next) => {
    const patch = { subtype: composeSubtype(next.grade, next.fabric) };
    if ('swatchImageId' in next) patch.swatchImageId = next.swatchImageId;
    // Picking a grade re-snapshots the reference + price from the model's SKU at
    // that grade, so the reference's grade letter (e.g. …A → …E) and the price
    // always track the chosen material — for an already-priced line AND a
    // material-less RANGE line. A range pick also drops the range so it bills as
    // a normal line. When the family can't resolve the grade (a manual or
    // non-graded reference), the reference + price are left exactly as typed.
    if (next.grade) {
      const p = family ? productForGrade(family, next.grade) : null;
      if (p) {
        patch.reference = p.reference;
        patch.unitPrice = Number(p.priceUsd) || 0;
      }
      if (line.priceMin != null || line.priceMax != null) {
        patch.priceMin = null;
        patch.priceMax = null;
      }
    }
    onChange(patch);
  };
  // Committing the fabric field (typed OR pasted). When the value embeds a
  // catalog color code ("… (#code)"), resolve its material so we adopt the
  // material's GRADE — pasting a coded fabric must move the price tier, not just
  // the label + swatch (the swatch already updates via colorCodeFromSubtype).
  // A hand-typed name with no code resolves nothing, so the grade is unchanged.
  const commitFabric = (v) => {
    const located = locateColor(materials, composeSubtype(grade, v));
    const nextGrade = located?.material?.grade || grade;
    commit({ grade: nextGrade, fabric: v });
  };
  const swatchImageId = line.swatchImageId || null;
  // "Sin material" — strip the chosen fabric and revert the line to the model's
  // cheapest→priciest price RANGE. Offered only when the family forms a range
  // (else there's nothing to revert to); the same Model rule the client-preview
  // swatch × uses (materiallessRangePatch), so the two clears can't drift.
  const rangePatch = materiallessRangePatch(family);
  const clearMaterial = () => { if (rangePatch) onChange(rangePatch); };
  const [swatchOpen, setSwatchOpen] = useState(false);
  // Index of the alternative option whose color we're re-picking (null = none).
  // Drives a dedicated SwatchPicker that drills into that option's material.
  const [editingOption, setEditingOption] = useState(null);

  // Append one or more alternative materials (informational — never touches the
  // line's price/subtype). On the FIRST option we snapshot the line's current
  // grade + material name as the delta base, so every option's "+RD$X" reads
  // relative to what the line is actually quoted at. The catalog picker hands
  // back a batch (multi-select), so this takes an array.
  function addOptions(picks) {
    if (!picks?.length) return;
    const toOption = (picked) => ({
      grade: picked.grade || '',
      label: picked.fabric || '',
      code: colorCodeFromSubtype(composeSubtype(picked.grade, picked.fabric)) || undefined,
      swatchImageId: picked.swatchImageId || undefined,
    });
    const additions = picks.map(toOption);
    const prev = materialOptions;
    const next = prev
      ? { ...prev, options: [...(prev.options || []), ...additions] }
      : { baseGrade: grade || '', baseLabel: fabric || '', options: additions };
    onChange({ materialOptions: next });
  }

  function removeOption(idx) {
    if (!materialOptions) return;
    const options = (materialOptions.options || []).filter((_, i) => i !== idx);
    // Drop the whole structure when the last option goes — keeps the row clean
    // and avoids a dangling base with no alternatives.
    onChange({ materialOptions: options.length ? { ...materialOptions, options } : null });
  }

  // Swap an option into the base slot: the picked option becomes the delta
  // reference and the old base is pushed back as an option. INFORMATIONAL
  // only — the line's own grade/price/subtype are untouched (deltas just
  // recompute against the new base).
  function makeBase(idx) {
    if (!materialOptions) return;
    const opts = materialOptions.options || [];
    const target = opts[idx];
    if (!target) return;
    const oldBase = {
      grade: materialOptions.baseGrade || '',
      label: materialOptions.baseLabel || '',
    };
    const options = opts.map((o, i) => (i === idx ? oldBase : o));
    onChange({
      materialOptions: {
        ...materialOptions,
        baseGrade: target.grade || '',
        baseLabel: target.label || '',
        options,
      },
    });
  }

  // Re-pick an alternative option's material/color. Mirrors how the base
  // material commits a catalog pick, but writes it back into the option at
  // `editingOption` (grade + label + code + swatch) instead of the line's own
  // subtype — informational, never touches the line's price. This is what
  // makes the option pills editable: pick colors per option after a bulk add.
  function editOption(picked) {
    if (editingOption == null || !materialOptions) return;
    const opts = materialOptions.options || [];
    const updated = opts.map((o, i) =>
      i === editingOption
        ? {
            grade: picked.grade || '',
            label: picked.fabric || '',
            code: colorCodeFromSubtype(composeSubtype(picked.grade, picked.fabric)) || undefined,
            swatchImageId: picked.swatchImageId || undefined,
          }
        : o,
    );
    onChange({ materialOptions: { ...materialOptions, options: updated } });
  }

  // Single row: swatch · grade · fabric · picker. The fabric input sizes
  // to its content (field-sizing) so it's only as wide as the material
  // name; the picker button sits right after it, not across the row.
  return (
    <div className="space-y-1.5 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {/* Swatch pinned to the LEFT so the material reads the same on every
            line/component no matter how long the fabric name is — mirrors
            the client preview, which always puts the swatch left of the
            subtype. The catalog picker pre-fills it; the empty state is an
            explicit "add photo" tile and the corner × clears just the
            swatch. */}
        {/* z-[2] keeps the swatch above any deactivated/non-selected veil
            (z-[1]) so the fabric colour is never dimmed — in any state. */}
        <span className="relative z-[2] inline-flex shrink-0">
          <Thumbnail
            imageId={swatchImageId}
            fallbackUrl={swatchUrl(colorCodeFromSubtype(line.subtype))}
            onChange={setSwatch}
            kind="quote-line-swatch"
            ownerId={line.id}
            sizeClass="w-10 h-10"
            hoverPreview
          />
        </span>
        <div className="flex items-baseline gap-x-1 min-w-0 flex-1">
          <Select
            variant="ghost"
            value={grade}
            onChange={(v) => commit({ grade: v, fabric })}
            aria-label="Grade"
            title="Fabric grade"
          >
            {/* Option text carries the "Grade " prefix on alpha values so the
                collapsed select reads as "Grade C" rather than just "C" —
                a bare letter is unambiguous to a Ligne Roset dealer in
                isolation but jarring on a card that contains other letters
                (refs, page numbers, dimensions).

                Groups (Telas / Microfibras / Pieles) and the A..R, S, U..X
                letter set come from the Ligne Roset price list verbatim;
                the in-between letters (T, Y, Z) are reserved and never
                offered. Source of truth: src/lib/subtype.js GRADE_GROUPS. */}
            <option value="">Grade —</option>
            {GRADE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.grades.map((g) => (
                  <option key={g} value={g}>Grade {g}</option>
                ))}
              </optgroup>
            ))}
            <optgroup label="Otros">
              {SPECIAL_GRADES.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
              {/* Legacy values that may still live in older quotes — render
                  the matching option ONLY when the current value is one of
                  them, so a native <select> can display it back to the user.
                  Without this, the browser would silently fall back to the
                  first option and we'd lose what the dealer typed. */}
              {LEGACY_NAMED_GRADES.includes(grade) && (
                <option value={grade}>{grade} (anterior)</option>
              )}
            </optgroup>
          </Select>
          {(grade || fabric) ? (
            <span className="text-ink-300 select-none px-0.5" aria-hidden>·</span>
          ) : null}
          <DebouncedInput
            value={fabric}
            onCommit={commitFabric}
            placeholder="Tela o acabado"
            autoCapitalize="words"
            // Sizes to its content (field-sizing via .qli-grow): only as wide
            // as the material name (or the placeholder when empty), never
            // stretched across the row. Capped at 100% so a very long name
            // still wraps/scrolls within the row instead of overflowing.
            className="qli-grow bg-transparent border-0 border-b border-transparent hover:border-ink-200 focus:!border-ink-900 px-1 py-1 coarse:min-h-10 text-[13px] coarse:text-sm text-ink-700 placeholder:text-ink-300 focus:outline-none focus:ring-0 transition-colors"
          />
          {/* Catalog picker — opens the swatch modal so the dealer can pick a
              material + color instead of typing the name and guessing the
              code. Selecting writes back grade + fabric (and the swatch) in
              one shot; the input above still works for freeform overrides. */}
          <MaterialPickerButton onClick={() => setSwatchOpen(true)} />
          {/* Remove the chosen material → revert to the model's price RANGE.
              Shown only when a material is set AND the family can form a range
              (rangePatch non-null). Distinct from the swatch's corner ×, which
              clears only the colour image. */}
          {(grade || fabric) && rangePatch && (
            <button
              type="button"
              onClick={clearMaterial}
              className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-400 hover:text-red-600 rounded-md px-1.5 py-1 coarse:min-h-9 hover:bg-red-50 transition-colors flex-shrink-0"
              title="Quitar la tela y volver a cotizar sin material (rango de precio)"
            >
              <X size={12} className="opacity-80" aria-hidden />
              Sin material
            </button>
          )}
          {/* Quick jump to this model's Ligne Roset page when it's been linked
              in the catalog — lets the dealer (or designer) open the exact
              product to confirm the offered fabrics. */}
          {sourceUrl && (
            <a
              href={sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-400 hover:text-brand-700 rounded-md px-1.5 py-1 coarse:min-h-9 hover:bg-brand-50 transition-colors flex-shrink-0"
              title="Ver este modelo en Ligne Roset"
            >
              <ExternalLink size={12} className="opacity-80" aria-hidden />
              Ligne Roset
            </a>
          )}
        </div>
      </div>

      <MaterialOptionChips
        materialOptions={materialOptions}
        family={family}
        currency={currency}
        rates={rates}
        onRemove={removeOption}
        onMakeBase={makeBase}
        onEditColor={setEditingOption}
      />

      {/* One picker: replaces the line's grade/fabric by default, and via its
          "Agregar opciones" toggle batch-adds alternative materials (appended
          to materialOptions instead of replacing the line's own fabric). */}
      <SwatchPicker
        open={swatchOpen}
        onClose={() => setSwatchOpen(false)}
        onSelect={(next) => commit(next)}
        allowMultiSelect
        onSelectMany={(picks) => addOptions(picks)}
        currentGrade={grade}
        currentFabric={fabric}
        family={family}
        nameFilter={nameFilter}
      />
      {/* Re-pick the color/material of an EXISTING option.
          Opens drilled into that option's material (autoDrill via its
          grade/fabric) so clicking an option pill lands straight on its
          color grid; the pick overwrites just that option. */}
      <SwatchPicker
        open={editingOption != null}
        onClose={() => setEditingOption(null)}
        onSelect={(picked) => editOption(picked)}
        currentGrade={materialOptions?.options?.[editingOption]?.grade || ''}
        currentFabric={materialOptions?.options?.[editingOption]?.label || ''}
        family={family}
        nameFilter={nameFilter}
      />
    </div>
  );
}

// Compact, removable chips for a line/component's alternative materials. Each
// shows a color swatch + "LABEL +RD$X" with a "Hacer base" and a remove ×; the
// delta comes from materialOptionDeltas (resolved against the line's catalog
// family) and is formatted in the quote's currency. "Hacer base" swaps a chip
// with the current delta base — informational only. Clicking the swatch/label
// opens the color picker for THAT option (onEditColor) so colors can be chosen
// per option, e.g. after bulk-adding the same materials across many lines.
function MaterialOptionChips({ materialOptions, family, currency, rates, onRemove, onMakeBase, onEditColor }) {
  if (!materialOptions || !(materialOptions.options || []).length) return null;
  const deltas = materialOptionDeltas(materialOptions, family);
  const fmtDelta = (d) => {
    const v = Number(d) || 0;
    const sign = v > 0 ? '+' : v < 0 ? '−' : '';
    return `${sign}${formatMoney(Math.abs(v), currency, rates)}`;
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 pl-12">
      {materialOptions.baseLabel && (
        <span
          className="chip text-ink-500 bg-ink-50 border border-ink-200"
          title="Material base — referencia para los deltas"
        >
          {composeSubtype(materialOptions.baseGrade, materialOptions.baseLabel) || materialOptions.baseLabel}
          <span className="ml-1 text-ink-400 normal-case font-normal">base</span>
        </span>
      )}
      {deltas.map((o, i) => (
        <span
          key={`${o.code || o.label || 'opt'}-${i}`}
          className="inline-flex items-center gap-1 chip text-brand-700 bg-brand-50 border border-brand-100"
        >
          {/* Swatch + label — click to re-pick this option's color/material. */}
          <button
            type="button"
            onClick={() => onEditColor(i)}
            className="inline-flex items-center gap-1 rounded hover:text-brand-900 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand-400"
            title="Cambiar el color o material de esta opción"
            aria-label={`Cambiar el color de ${o.label || 'la opción'}`}
          >
            {(o.swatchImageId || o.code) && (
              <ImageView
                id={o.swatchImageId}
                fallbackUrl={swatchUrl(o.code)}
                alt=""
                className="w-4 h-4 rounded-sm object-cover border border-brand-100 bg-white flex-shrink-0"
              />
            )}
            <span className="truncate max-w-[14rem]">{o.label || `Grade ${o.grade}`}</span>
            <Palette size={10} className="opacity-40 flex-shrink-0" aria-hidden />
          </button>
          <span className="tabular-nums font-medium">{fmtDelta(o.delta)}</span>
          <button
            type="button"
            onClick={() => onMakeBase(i)}
            className="text-[10px] text-brand-600 hover:text-brand-900 underline decoration-dotted"
            title="Usar este material como base de los deltas"
          >
            Hacer base
          </button>
          <button
            type="button"
            onClick={() => onRemove(i)}
            className="text-brand-500 hover:text-red-600"
            aria-label={`Quitar ${o.label || 'opción'}`}
            title="Quitar opción"
          >
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  );
}

// Compact inline strip of identifying meta — REF. + DIM. The uppercase
// micro-labels match the compound component rows (and the PDF / client
// preview), so the spec reads consistently across all three surfaces.
//
// Shared by the article line AND the compound ComponentRow (passing
// `value`/`onCommit` for `reference` + `dimensions`) so the two have an
// identical spec layout. The inputs auto-grow via field-sizing:content;
// `widthClass` is the MIN width (REF. is short, DIM. holds a full
// "H 28 × L 89 × P 43" string), and the .qli-grow 2.5rem floor keeps an
// empty placeholder-only field from collapsing. The strip flex-wraps so a
// long value drops the second field to its own line instead of forcing
// horizontal scroll. (Previously the article passed widthClass="min-w-0",
// which re-zeroed the floor and let the placeholder clip to nothing.)
function SpecStrip({
  reference, dimensions, onChangeReference, onChangeDimensions, refInputRef,
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 min-w-0">
      <InlineEditor
        ref={refInputRef}
        label="Ref."
        value={reference || ''}
        onCommit={onChangeReference}
        placeholder="—"
        mono
        widthClass="min-w-[5rem]"
        autoCapitalize="characters"
        autoComplete="off"
      />
      {/* Catalog page input ("Pág.") intentionally hidden — the field
          remains in the data model (line.pageRef) and is still surfaced
          in PDF rendering; only the edit control has been removed at the
          dealer's request. */}
      <InlineEditor
        label="Dim."
        value={dimensions || ''}
        onCommit={onChangeDimensions}
        placeholder="H × W × D"
        mono
        widthClass="min-w-[7rem]"
        autoComplete="off"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pricing row — the ONE primitive that renders `Cant. × Unitario = Total`
// for both the standalone article line and every compound component. It
// owns the grid (.qli-pricing-grid in src/index.css) so the equation reads
// as a single right-aligned cluster on wide cards and reflows to a labelled
// stack on narrow ones. Article and component differ only in the size of
// the Total and whether the Total opens a breakdown popover — passed as
// props so the structure, spacing, operators, and min-widths stay identical
// across the two surfaces. (Fixes the prior split where the article used a
// flex calc-grid with a stranded total cell and the component used a
// hand-rolled justify-between row with no operators.)
function PricingRow({
  qty, unitPrice, total, fmt, currency,
  onQtyChange, onUnitChange,
  // Total presentation: 'lg' on the article line, 'md' inside a component.
  totalSize = 'lg',
  totalLabel = 'Total',
  // When provided, the Total is a button that toggles the breakdown popover
  // and renders the c/u adjustment caption. Components pass none of these
  // (their total is a plain read-out; the parent line owns the breakdown).
  onToggleBreakdown, breakdownOpen, breakdown, adjustmentLine, unitForCaption, hasAdjustment,
  qtyAriaLabel = 'Cantidad', unitAriaLabel = 'Precio unitario',
}) {
  const totalValCls = totalSize === 'lg'
    ? 'qli-total-val text-lg font-semibold tabular-nums text-ink-900 leading-tight'
    : 'qli-total-val text-[15px] font-semibold tabular-nums text-ink-900 leading-tight';
  const totalEl = (
    <div className={totalValCls}>{fmt(total)}</div>
  );
  return (
    <div className="qli-pricing-grid">
      <CalcCell label="Cant.">
        <DebouncedInput
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          className="qli-grow min-w-[3.25rem] max-w-[7rem] text-right tabular-nums input min-h-9 coarse:min-h-10 py-1.5 px-2"
          value={qty ?? 1}
          onCommit={(v) => onQtyChange(Math.max(0, Number(v) || 0))}
          aria-label={qtyAriaLabel}
        />
      </CalcCell>

      <span className="qli-pricing-op text-base" aria-hidden>×</span>

      <CalcCell label="Unitario">
        <MoneyInput
          currency={currency}
          value={unitPrice}
          onCommit={onUnitChange}
          widthClass="min-w-[6rem]"
          aria-label={unitAriaLabel}
        />
      </CalcCell>

      <span className="qli-pricing-op text-base" aria-hidden>=</span>

      <div className="qli-pricing-cell qli-pricing-total relative">
        <div className="eyebrow-xs tracking-wide">
          {totalLabel}
        </div>
        {onToggleBreakdown ? (
          <>
            <button
              type="button"
              onClick={onToggleBreakdown}
              className="block w-full text-right px-1 py-1 -mx-1 -my-1 rounded hover:bg-white active:bg-ink-100 transition-colors"
              title="Ver desglose"
              aria-expanded={breakdownOpen}
            >
              {totalEl}
              {hasAdjustment ? (
                <div className="text-[10px] text-ink-500 tabular-nums leading-tight mt-0.5">
                  {unitForCaption != null && (
                    <span className="whitespace-nowrap">{fmt(unitForCaption)} c/u</span>
                  )}
                  {adjustmentLine && <AdjustmentChip line={adjustmentLine} />}
                </div>
              ) : null}
            </button>
            {breakdownOpen && breakdown}
          </>
        ) : (
          totalEl
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Calculator band — the article line's pricing. Reads as the card's last
// row (faint top divider via .qli-pricing), right-aligned equation. The
// Total is a button — clicking it toggles the per-line breakdown popover.
function CalculatorBand({
  line, unit, lineTotal, fmt, hasAdjustment, breakdownOpen,
  onChange, onToggleBreakdown, onCloseBreakdown, currency, rates,
}) {
  return (
    <div className="qli-pricing">
      <PricingRow
        qty={line.qty}
        unitPrice={line.unitPrice}
        total={lineTotal}
        fmt={fmt}
        currency={currency}
        onQtyChange={(q) => onChange({ qty: q })}
        onUnitChange={(v) => onChange({ unitPrice: v })}
        totalSize="lg"
        totalLabel="Total"
        onToggleBreakdown={onToggleBreakdown}
        breakdownOpen={breakdownOpen}
        hasAdjustment={hasAdjustment}
        unitForCaption={unit}
        adjustmentLine={line}
        breakdown={(
          <LineBreakdownPopover
            line={line}
            currency={currency}
            rates={rates}
            onClose={onCloseBreakdown}
          />
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Range band — a material-less line's pricing. There's no single unit price:
// the model is quoted across its fabric grades, so we show qty × [min … max]
// and a hint to pick a fabric (which pins the price and clears the range, via
// GradeFabricRow.commit). The qty input reuses the calculator's CalcCell so it
// reads identically to a normal row.
// ---------------------------------------------------------------------------
function RangeBand({ line, totalRange, fmt, onChange }) {
  return (
    <div className="qli-pricing">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <CalcCell label="Cant.">
          <DebouncedInput
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            className="qli-grow min-w-[3.25rem] max-w-[7rem] text-right tabular-nums input min-h-9 coarse:min-h-10 py-1.5 px-2"
            value={line.qty ?? 1}
            onCommit={(v) => onChange({ qty: Math.max(0, Number(v) || 0) })}
            aria-label="Cantidad"
          />
        </CalcCell>
        <div className="text-right ml-auto">
          <div className="eyebrow-xs tracking-wide text-brand-700">Rango · sin material</div>
          <div className="qli-total-val text-lg font-semibold tabular-nums text-ink-900 leading-tight whitespace-nowrap">
            {fmt(totalRange.min)} <span className="text-ink-300 mx-0.5" aria-hidden>–</span> {fmt(totalRange.max)}
          </div>
          <div className="text-[10px] text-ink-500 leading-tight mt-0.5">
            Elige una tela para fijar el precio
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compound calculator band — replaces the qty × unit = total equation
// with a single read-only "Compound total" because the math now lives
// per-component below. Still a button so clicking opens the breakdown
// popover with the same explanation (subtotal of all components, then
// line-level discount).
// ---------------------------------------------------------------------------
function CompoundCalculatorBand({
  line, compound, rowTotal, fmt, hasAdjustment, breakdownOpen,
  onToggleBreakdown, onCloseBreakdown, currency, rates,
}) {
  // Compound roll-up resolved in the VM: component count, whether it shows a
  // price RANGE (any material-less piece — like a standalone range line), and
  // that range (null when fully specified, where lineTotalRange is a point).
  const count = compound.count;
  const ranged = compound.hasRange;
  const tr = compound.range;
  return (
    <div className="qli-pricing">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11px] text-ink-500 tabular-nums leading-tight">
          {count} componente{count === 1 ? '' : 's'}
        </div>
        <div className="relative text-right ml-auto">
          <div className="eyebrow-xs tracking-wide mb-0.5">
            {ranged ? 'Total modular · rango' : 'Total modular'}
          </div>
          <button
            type="button"
            onClick={onToggleBreakdown}
            className="block w-full text-right px-1 py-1 -mx-1 -my-1 rounded hover:bg-white active:bg-ink-100 transition-colors"
            title="Ver desglose"
            aria-expanded={breakdownOpen}
          >
            <div className="qli-total-val text-lg font-semibold tabular-nums text-ink-900 leading-tight whitespace-nowrap">
              {ranged
                ? <>{fmt(tr.min)} <span className="text-ink-300 mx-0.5" aria-hidden>–</span> {fmt(tr.max)}</>
                : fmt(rowTotal)}
            </div>
            {hasAdjustment ? (
              <div className="text-[10px] text-ink-500 tabular-nums leading-tight mt-0.5">
                <AdjustmentChip line={line} />
              </div>
            ) : null}
          </button>
          {breakdownOpen && (
            <LineBreakdownPopover
              line={line}
              currency={currency}
              rates={rates}
              onClose={onCloseBreakdown}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Components panel — the per-component editor that sits below the
// parent identity in compound mode. Each component is a compact row
// with its own name, ref, dim, grade/fabric, qty, unit, and total.
//
// Layout intent: dense but readable. A component is the same data
// shape as a line item but rendered as a single horizontal-wrapping
// strip rather than the full-card vocabulary — three vertical bands
// nested inside another three vertical bands would be visual noise.
// ---------------------------------------------------------------------------
// Components reorder with the SAME HTML5 drag-and-drop as the line items
// (see LineItemList) — a grip handle per row, a brand drop-indicator bar,
// and a renormalised order on drop. Kept deliberately identical so the
// interaction is consistent across the two nesting levels.
function ComponentsPanel({ line, components: componentVMs, currency, rates, fmt, nameFilter, sourceUrl, onAdd, onUpdate, onRemove, onReorder, onAddAlternative, onSelectAlternative, onApplyToAll, onApplyMaterialToAll, isModular, modules, onSetModular, onGroupModule, onUngroupModule, onRenameModule, onToggleModuleOptional, onAddModuleAlternative, onSelectModuleAlternative, onMakeProduct, onAddToProduct, onAddMany }) {
  const components = line.components || [];
  // Per-component display projection (total, range swap, optional/alternative
  // flags + dim state, and the "Opción N de M" position) resolved once in the
  // VM, keyed by component id. The raw components above still drive the map's
  // keys, drag/reorder and the edit handlers.
  const vmById = new Map((componentVMs || []).map((v) => [v.id, v]));
  const [draggingId, setDraggingId] = useState(null);
  const [dropTargetId, setDropTargetId] = useState(null);
  const [multiOpen, setMultiOpen] = useState(false);
  // "Aplicar material a todo" picker on the composition header — opens the
  // SwatchPicker, and the chosen material is stamped onto every component.
  const [applyAllOpen, setApplyAllOpen] = useState(false);
  // Selection mode for building a component product: clicking "Desglosar" on a
  // component enters it (that component pre-selected), checkboxes appear so the
  // dealer ticks the rest, and "Crear producto" groups them into one product.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  function toggleSelected(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function startSelecting(id) {
    setSelected(new Set([id]));
    setSelecting(true);
  }
  function cancelSelecting() {
    setSelected(new Set());
    setSelecting(false);
  }
  function groupSelected() {
    if (selected.size === 0) return;
    onGroupModule?.([...selected], '');
    setSelected(new Set());
    setSelecting(false);
  }

  function onDragStart(e, id) {
    setDraggingId(id);
    e.stopPropagation();   // don't let the parent line's drag pick this up
    try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); } catch { /* noop */ }
  }
  function onDragEnd() { setDraggingId(null); setDropTargetId(null); }
  function onDragOver(e, id) {
    if (!draggingId || draggingId === id) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropTargetId(id);
  }
  function onDrop(e, id) {
    e.preventDefault();
    e.stopPropagation();
    const srcId = draggingId;
    setDraggingId(null);
    setDropTargetId(null);
    if (!srcId || srcId === id) return;
    const srcIdx = components.findIndex((c) => c.id === srcId);
    const dstIdx = components.findIndex((c) => c.id === id);
    if (srcIdx === -1 || dstIdx === -1) return;
    const next = [...components];
    const [moved] = next.splice(srcIdx, 1);
    const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
    next.splice(insertAt, 0, moved);
    onReorder(next.map((c) => c.id));
  }

  // One component row + its drag wrapper and (on a modular line) its grouping
  // checkbox. Shared by the flat layout and the grouped-by-module layout so the
  // editing affordances never diverge between the two.
  function renderRow(c) {
    const i = components.findIndex((x) => x.id === c.id);
    const isDragging = draggingId === c.id;
    const isDropTarget = dropTargetId === c.id && draggingId !== c.id;
    const dragHandleProps = {
      draggable: true,
      onDragStart: (e) => onDragStart(e, c.id),
      onDragEnd,
    };
    return (
      <div
        key={c.id || i}
        onDragOver={(e) => onDragOver(e, c.id)}
        onDrop={(e) => onDrop(e, c.id)}
        className={`relative flex items-stretch ${isDragging ? 'opacity-40' : ''}`}
      >
        {isDropTarget && (
          <div className="absolute left-0 right-0 -top-px h-0.5 bg-brand-500 z-10 pointer-events-none" />
        )}
        {selecting && !c.moduleGroup && (
          <label className="flex items-center pl-2 pr-0.5 cursor-pointer" title="Incluir este componente en el producto">
            <input
              type="checkbox"
              checked={selected.has(c.id)}
              onChange={() => toggleSelected(c.id)}
              className="accent-brand-600"
            />
          </label>
        )}
        <div className="min-w-0 flex-1">
          <ComponentRow
            index={i}
            component={c}
            vm={vmById.get(c.id)}
            currency={currency}
            rates={rates}
            fmt={fmt}
            nameFilter={nameFilter}
            sourceUrl={sourceUrl}
            onChange={(patch) => onUpdate(c.id, patch)}
            onRemove={() => onRemove(c.id)}
            onAddAlternative={() => onAddAlternative?.(c.id)}
            onSelectAlternative={() => onSelectAlternative?.(c.id)}
            onApplyToAll={() => onApplyToAll?.(c.id)}
            onMakeProduct={() => startSelecting(c.id)}
            selecting={selecting}
            dragHandleProps={dragHandleProps}
          />
        </div>
      </div>
    );
  }

  const byId = new Map(components.map((c) => [c.id, c]));

  return (
    <div className="mt-3 rounded-lg border border-ink-100 bg-ink-50/40 overflow-hidden">
      {/* Composition controls: toggle modular, and group the current selection. */}
      <div className="px-3 py-2 bg-white border-b border-ink-100 flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-medium text-ink-500">
          Modular
        </span>
        <div className="flex-1" />
        {/* Top-level "apply material to all" — one pick stamps the chosen grade +
            fabric + swatch onto EVERY component (repricing material-less pieces
            against their own model). The per-component "Aplicar tela a todos"
            shortcut still copies one piece's material; this header control sets a
            fresh material for the whole product in one step. */}
        {onApplyMaterialToAll && components.length > 0 && (
          <button
            type="button"
            onClick={() => setApplyAllOpen(true)}
            className="btn-ghost text-xs"
            title="Elegir una tela y aplicarla a todos los componentes de este producto"
          >
            <Palette size={12} /> Aplicar material a todo
          </button>
        )}
      </div>
      {selecting && (
        <div className="px-3 py-2 bg-brand-50/60 border-b border-brand-100 flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-medium text-brand-700">Selecciona los componentes para el producto</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={groupSelected}
            disabled={selected.size === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-700 disabled:opacity-50"
          >
            <Boxes size={12} aria-hidden /> Crear producto{selected.size ? ` (${selected.size})` : ''}
          </button>
          <button type="button" onClick={cancelSelecting} className="btn-ghost text-xs">Cancelar</button>
        </div>
      )}

      {components.length === 0 ? (
        <div className="px-4 py-5 text-center text-xs text-ink-500">
          Sin componentes todavía. Agrega el primero para empezar.
        </div>
      ) : isModular ? (
        // Grouped-by-module: each module (a component product) under its own
        // header with a per-module subtotal; ungrouped elements stand alone.
        <div className="divide-y divide-ink-100">
          {(modules || []).map((m) => (
            <div key={m.moduleGroup || m.componentIds[0]} className={(m.optional || (m.altGroup && !m.selected)) ? 'bg-ink-50/40' : ''}>
              {m.moduleGroup ? (
                <div className="px-3 py-1.5 bg-ink-100/60 flex items-center gap-2 flex-wrap">
                  {m.altGroup ? (
                    <button
                      type="button"
                      onClick={() => onSelectModuleAlternative?.(m.moduleGroup)}
                      aria-pressed={m.selected}
                      title={m.selected ? 'Producto seleccionado' : 'Seleccionar este producto'}
                      className="inline-flex items-center gap-1.5 flex-shrink-0"
                    >
                      <span className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                        m.selected ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-300 bg-white hover:border-brand-400'
                      }`}>
                        {m.selected && <Check size={9} strokeWidth={3} aria-hidden />}
                      </span>
                      <span className="eyebrow-xs tracking-wide font-semibold text-brand-700 select-none whitespace-nowrap">
                        Alternativa {m.altIndex ?? '?'}/{m.altTotal ?? '?'}
                      </span>
                    </button>
                  ) : (
                    <Boxes size={11} className="text-ink-400 flex-shrink-0" aria-hidden />
                  )}
                  <DebouncedInput
                    value={m.name}
                    onCommit={(v) => onRenameModule?.(m.moduleGroup, v)}
                    className="input min-h-8 py-1 px-2 text-xs font-semibold text-ink-700 flex-1 min-w-0"
                    placeholder="Nombre del producto"
                  />
                  {onToggleModuleOptional && !m.altGroup && (
                    <button
                      type="button"
                      onClick={() => onToggleModuleOptional(m.moduleGroup, !m.optional)}
                      className={`chip font-medium ${
                        m.optional
                          ? 'text-ink-600 bg-ink-50 border border-dashed border-ink-300 hover:border-ink-500'
                          : 'text-ink-400 hover:text-ink-700 border border-dashed border-ink-200 hover:border-ink-400'
                      }`}
                      title={m.optional
                        ? 'Quitar opcional — el producto vuelve a sumar al total'
                        : 'Marcar el producto como opcional — se muestra pero no suma al total'}
                      aria-pressed={m.optional}
                    >
                      <Sparkles size={10} className="opacity-70" aria-hidden /> Opcional
                    </button>
                  )}
                  {onAddModuleAlternative && !m.optional && (
                    <button
                      type="button"
                      onClick={() => onAddModuleAlternative(m.moduleGroup)}
                      className="chip font-medium text-ink-400 hover:text-brand-700 border border-dashed border-ink-200 hover:border-brand-400"
                      title={m.altGroup
                        ? 'Agregar otra alternativa de este producto'
                        : 'Ofrecer este producto como alternativa — el cliente elige uno'}
                    >
                      <GitFork size={10} className="opacity-80" aria-hidden /> Alternativa
                    </button>
                  )}
                  <span className="text-[11px] tabular-nums text-ink-500 whitespace-nowrap">
                    {m.hasRange && m.range
                      ? `${fmt(m.range.min)} – ${fmt(m.range.max)}`
                      : fmt(m.subtotal)}
                    {m.optional && <span className="ml-1 text-ink-400">· no incluido</span>}
                    {m.altGroup && !m.selected && <span className="ml-1 text-ink-400">· no elegido</span>}
                  </span>
                  {onAddToProduct && (
                    <button
                      type="button"
                      onClick={() => onAddToProduct(m.moduleGroup)}
                      className="text-ink-400 hover:text-brand-700 p-1"
                      title="Agregar un componente a este producto"
                    >
                      <Plus size={12} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onUngroupModule?.(m.moduleGroup)}
                    className="text-ink-400 hover:text-brand-700 p-1"
                    title="Desagrupar este producto"
                  >
                    <Split size={12} />
                  </button>
                </div>
              ) : null}
              <div className={`${m.moduleGroup ? 'divide-y divide-ink-100 pl-2 border-l-2 border-ink-100' : 'divide-y divide-ink-100'}${(m.optional || (m.altGroup && !m.selected)) ? ' opacity-60' : ''}`}>
                {m.componentIds.map((id) => byId.get(id)).filter(Boolean).map((c) => renderRow(c))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="divide-y divide-ink-100">
          {components.map((c) => renderRow(c))}
        </div>
      )}

      <div className="px-3 py-2 bg-white border-t border-ink-100 flex items-center justify-end gap-1.5">
        {onAddMany && (
          <button
            type="button"
            onClick={() => setMultiOpen(true)}
            className="btn-ghost text-xs"
            title={isModular
              ? 'Buscar y agregar los elementos de un producto (producto completo) de una vez, al mismo grado'
              : 'Buscar y agregar varios elementos del catálogo de una vez, al mismo grado'}
          >
            <Boxes size={12} /> {isModular ? 'Agregar producto' : 'Agregar varios'}
          </button>
        )}
        <button
          type="button"
          onClick={onAdd}
          className="btn-ghost text-xs"
          title="Agregar componente"
        >
          <Plus size={12} /> Agregar componente
        </button>
      </div>
      {onAddMany && (
        <MultiAddPicker
          open={multiOpen}
          onClose={() => setMultiOpen(false)}
          onAddMany={onAddMany}
        />
      )}
      {/* Composition-header material picker. Honors the product line's offered-
          fabric allowlist (nameFilter); on select, the chosen grade/fabric/swatch
          is applied to every component via onApplyMaterialToAll. */}
      {onApplyMaterialToAll && (
        <SwatchPicker
          open={applyAllOpen}
          onClose={() => setApplyAllOpen(false)}
          onSelect={(picked) => onApplyMaterialToAll(picked)}
          nameFilter={nameFilter}
        />
      )}
    </div>
  );
}

function ComponentRow({ index, component, vm, currency, rates, fmt, nameFilter, sourceUrl, onChange, onRemove, onAddAlternative, onSelectAlternative, onApplyToAll, onMakeProduct, selecting, dragHandleProps }) {
  // Display fields resolved in the VM (see resolveComponents): the component's
  // total, its optional/alternative flags, the resulting "off" (dimmed) state,
  // the "Opción N de M" position, the range swap (a material-less sub-piece
  // shows a range like the standalone line), and whether copying this piece's
  // material to its siblings would change anything (canApplyToAll).
  const { total, optional, inGroup, isSelected, dimmed, groupInfo, canApplyToAll } = vm;
  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const families = useContext(FamiliesContext);
  // Fill THIS sub-piece from the catalog with the SAME flow as a product line:
  // pick a model, then a material + color OR "sin material · cotizar por rango".
  // The catalog seed is applied to the component (dropping the line-only family
  // / unitCost), carrying priceMin/priceMax for a range pick and resetting any
  // prior alternative materials so a freshly-picked product starts clean.
  function insertProductToComponent(seed) {
    onChange({
      reference: seed.reference,
      name: seed.name,
      dimensions: seed.dimensions,
      subtype: seed.subtype,
      unitPrice: seed.unitPrice,
      swatchImageId: seed.swatchImageId ?? null,
      priceMin: seed.priceMin ?? null,
      priceMax: seed.priceMax ?? null,
      materialOptions: null,
    });
  }
  // ComponentRow used to be a two-column grid (specs on the left, calc
  // cells on the right via `sm:grid-cols-[minmax(0,1fr)_auto]`). The
  // auto-sized right column happily grabbed ~300px for its CANT × UNIT
  // = TOTAL strip and squeezed a long component name ("RIGHT-ARM SOFA
  // WITH SHORT UNIT KOBOLD CLASSIC") into a narrow 3-line tower —
  // visible even on the mid-width screenshots the dealer was sending
  // in. This row is already inside a sub-card inside a line-item card;
  // stacking vertically reads cleaner and gives the name the full
  // row width unconditionally.
  return (
    <div className={`group/comprow relative px-3 sm:px-4 py-3 bg-white space-y-2 ${
      optional ? 'border-l-2 border-dashed border-ink-300' : ''
    } ${
      inGroup ? 'border-l-2 border-solid border-brand-300' : ''
    }`}>
      {/* Deactivated (optional) OR non-selected alternative: a white veil fades
          the block; the radio + swatch stay lifted (z-[2]) and clickable. */}
      {(optional || dimmed) && (
        <div className="pointer-events-none absolute inset-0 z-[1] bg-white/55" aria-hidden />
      )}
      <div className="flex items-center gap-2">
        <span
          {...(dragHandleProps || {})}
          className="hidden sm:inline-flex items-center cursor-grab text-ink-300 hover:text-ink-700 opacity-0 group-hover/comprow:opacity-60 hover:!opacity-100 transition-opacity"
          title="Arrastra para reordenar"
          aria-label="Arrastrar para reordenar componente"
        >
          <GripVertical size={13} />
        </span>
        {inGroup ? (
          // Pick-one radio + "Alternativa N de M" — lifted above the dim veil.
          <button
            type="button"
            onClick={onSelectAlternative}
            aria-pressed={isSelected}
            title={isSelected ? 'Alternativa seleccionada' : 'Seleccionar esta alternativa'}
            className="relative z-[2] inline-flex items-center gap-1.5"
          >
            <span className={`inline-flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
              isSelected ? 'border-brand-500 bg-brand-500 text-white' : 'border-ink-300 bg-white hover:border-brand-400'
            }`}>
              {isSelected && <Check size={9} strokeWidth={3} aria-hidden />}
            </span>
            <span className="eyebrow-xs tracking-wide font-semibold text-brand-700 select-none">
              Alternativa {groupInfo?.index ?? '?'} de {groupInfo?.total ?? '?'}
            </span>
          </button>
        ) : (
          <span className="eyebrow-xs tracking-wide text-ink-400 select-none">
            Componente {index + 1}
          </span>
        )}
        {/* Per-component optional toggle — hidden inside an alternative group
            (optional ⊕ alternative are mutually exclusive). Stamps
            optionalOffered too so the client can fold the sub-piece in/out. */}
        {!inGroup && (
          <button
            type="button"
            onClick={() => onChange(optional
              ? { isOptional: false, optionalOffered: false }
              : { isOptional: true, optionalOffered: true })}
            className={`chip font-medium ${
              optional
                ? 'text-ink-600 bg-ink-50 border border-dashed border-ink-300 hover:border-ink-500'
                : 'text-ink-400 hover:text-ink-700 border border-dashed border-ink-200 hover:border-ink-400'
            }`}
            title={optional
              ? 'Quitar el marcador opcional — el componente vuelve a sumar al total modular'
              : 'Marcar este componente como opcional — se muestra pero no suma al total'}
            aria-pressed={optional}
          >
            <Sparkles size={10} className="opacity-70" aria-hidden />
            Opcional
          </button>
        )}
        {/* Make this component its OWN component product (a named producto you
            then fill with componentes). Hidden once it already belongs to one. */}
        {onMakeProduct && !component.moduleGroup && !selecting && (
          <button
            type="button"
            onClick={onMakeProduct}
            className="chip font-medium text-ink-400 hover:text-brand-700 border border-dashed border-ink-200 hover:border-brand-400 relative z-[2]"
            title="Desglosar este componente en un producto — un producto completo que agrupa varios componentes"
          >
            <Boxes size={10} className="opacity-80" aria-hidden /> Desglosar
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex items-center justify-center w-7 h-7 coarse:w-9 coarse:h-9 rounded text-ink-400 hover:text-red-600 hover:bg-red-50 transition-colors"
          aria-label="Quitar componente"
          title="Quitar componente"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <HeroInput
            placeholder="Nombre del componente"
            value={component.name || ''}
            onCommit={(v) => onChange({ name: v })}
            autoCapitalize="words"
          />
        </div>
        {/* Catalog product picker for THIS sub-piece — the compound twin of the
            line-level selector. Switches the component's product, keeping the
            materials the new model offers a grade for. */}
        <button
          type="button"
          onClick={() => setProductPickerOpen(true)}
          className="inline-flex items-center justify-center w-8 h-8 coarse:w-10 coarse:h-10 rounded-md text-ink-400 hover:text-brand-700 hover:bg-brand-50 transition-colors flex-shrink-0"
          title="Elegir el producto del catálogo"
          aria-label="Elegir el producto del catálogo"
        >
          <PackageSearch size={15} />
        </button>
      </div>

      <SpecStrip
        reference={component.reference}
        dimensions={component.dimensions}
        onChangeReference={(v) => onChange({ reference: v })}
        onChangeDimensions={(v) => onChange({ dimensions: v })}
      />

      <div className="pt-0.5">
        <GradeFabricRow
          line={{
            subtype: component.subtype,
            swatchImageId: component.swatchImageId,
            reference: component.reference,
            materialOptions: component.materialOptions,
            // Range fields so picking a material clears the component's range and
            // pins its price, exactly as on a standalone line (GradeFabricRow.commit).
            priceMin: component.priceMin,
            priceMax: component.priceMax,
          }}
          onChange={(patch) => onChange(patch)}
          currency={currency}
          rates={rates}
          nameFilter={nameFilter}
          sourceUrl={sourceUrl}
        />
        {/* Pick-once shortcut — only shown when this component has a material AND
            some sibling still differs (canApplyToAll), so it disappears the
            moment everything matches. Copies grade + fabric + swatch to the rest. */}
        {canApplyToAll && onApplyToAll && (
          <button
            type="button"
            onClick={onApplyToAll}
            className="relative z-[2] mt-1 inline-flex items-center gap-1 rounded px-1 py-0.5 coarse:min-h-9 text-[11px] font-medium text-brand-700 hover:text-brand-800 hover:underline transition-colors"
            title="Usar esta misma tela en todos los componentes de este producto"
          >
            <Copy size={11} className="opacity-80" aria-hidden />
            Aplicar tela a todos
          </button>
        )}
      </div>

      {/* Pricing — a range band (qty + "min – max" + a pick-a-fabric hint)
          when the sub-piece is quoted material-less, else the SAME <PricingRow>
          primitive the article line uses, rendered one size down ('md'). The
          range ↔ calculator swap mirrors the standalone line exactly. */}
      {vm.hasRange ? (
        <RangeBand
          line={component}
          totalRange={vm.range}
          fmt={fmt}
          onChange={onChange}
        />
      ) : (
        <div className="qli-pricing">
          <PricingRow
            qty={component.qty}
            unitPrice={component.unitPrice}
            total={total}
            fmt={fmt}
            currency={currency}
            onQtyChange={(q) => onChange({ qty: q })}
            onUnitChange={(v) => onChange({ unitPrice: v })}
            totalSize="md"
            totalLabel="Total"
            qtyAriaLabel="Cantidad del componente"
            unitAriaLabel="Precio unitario del componente"
          />
        </div>
      )}

      <CatalogPicker
        open={productPickerOpen}
        onClose={() => setProductPickerOpen(false)}
        onInsert={insertProductToComponent}
      />
    </div>
  );
}

// Labelled input cell for the pricing grid: an uppercase micro-label
// (CANT. / UNITARIO) stacked over its input. Uses .qli-pricing-cell so it
// shares the grid's stacking + min-width contract with the Total cell.
function CalcCell({ label, children }) {
  return (
    <div className="qli-pricing-cell">
      <div className="eyebrow-xs tracking-wide">
        {label}
      </div>
      {children}
    </div>
  );
}

// Renders the live adjustments on a line. New lines can carry NEITHER a
// discount nor a margin from the editor anymore (the per-line discount input
// was removed); this read-only chip only surfaces a value that a legacy quote
// already stored, so an old discount/margin still explains the adjusted total.
function AdjustmentChip({ line }) {
  const margin = Number(line.lineMarginPct) || 0;
  const discount = Number(line.lineDiscountPct) || 0;
  const parts = [];
  if (margin) parts.push(`${margin > 0 ? '+' : ''}${margin}%`);
  if (discount) parts.push(`–${discount}%`);
  if (parts.length === 0) return null;
  return <span className="ml-1 text-brand-700 font-medium">{parts.join(' ')}</span>;
}

// ---------------------------------------------------------------------------
// Per-line footer — the ACTION row, the home for everything the old "⋯"
// overflow menu carried. A quiet hairline-topped strip at the bottom of the
// card, read left→right: Modular · Alternativa · Opcional · Duplicar ·
// Separar … Eliminar (pushed to the far right, red).
//
// Visibility / touch contract: the row is ALWAYS reachable on touch (no
// hover-to-reveal), so phone/tablet dealers can always act on a line. On
// fine pointers it sits subtle (muted, faint top border) and strengthens on
// row hover + on focus-within, so a dense desktop list stays calm but the
// actions are one hover/Tab away. (Judgment call flagged in the report.)
//
// The conditional buttons mirror the exact rules the overflow menu used:
//   • Modular      — convert / dissolve the modular product (compound).
//   • + Alternativa — hidden when optional or in a set; label changes to
//                     "Agregar otra alternativa" once already in a group.
//   • Opcional     — moved here from the TopStrip; hidden when grouped.
//   • Duplicar     — always.
//   • Separar      — "del conjunto" (set) or "de las alternativas" (alt).
//   • Eliminar     — always, red, far right.
// "Unir al conjunto de arriba" is gone — joining a set now happens via the
// between-lines connector chip in LineItemList.
// ---------------------------------------------------------------------------
function LineFooter({
  compound, isOptional, alternativeGroup, setGroup,
  onConvertToCompound, onDissolveCompound,
  onAddAlternative, onToggleOptional,
  onDuplicate, onSeparateFromSet, onUngroup, onRemove,
}) {
  const canToggleOptional = !alternativeGroup && !setGroup;
  const canAddAlternative = !isOptional && !setGroup;
  return (
    <div className="qli-footer relative z-[2] mt-2.5 pt-2 border-t border-ink-100 flex flex-wrap items-center gap-x-1 gap-y-1">
      <FooterButton
        onClick={compound ? onDissolveCompound : onConvertToCompound}
        icon={Layers}
        active={compound}
        aria-pressed={compound}
        title={compound
          ? 'Producto modular — varias referencias bajo una familia y foto. Clic para volver a un artículo simple.'
          : 'Convertir en producto modular — agrupar varias referencias bajo una familia y foto'}
      >
        Modular
      </FooterButton>

      {canAddAlternative && onAddAlternative && (
        <FooterButton
          onClick={onAddAlternative}
          icon={GitFork}
          active={!!alternativeGroup}
          aria-pressed={!!alternativeGroup}
          title={alternativeGroup
            ? 'Agregar otra alternativa al grupo existente'
            : 'Crear un grupo de alternativas con esta línea como la seleccionada por defecto'}
        >
          Alternativa
        </FooterButton>
      )}

      {canToggleOptional && onToggleOptional && (
        <FooterButton
          onClick={onToggleOptional}
          icon={Sparkles}
          active={isOptional}
          aria-pressed={isOptional}
          title={isOptional
            ? 'Quitar el marcador opcional — la línea vuelve a sumar al total'
            : 'Marcar como opcional — la línea se muestra pero no suma al total'}
        >
          Opcional
        </FooterButton>
      )}

      {onDuplicate && (
        <FooterButton onClick={onDuplicate} icon={Copy} title="Duplicar esta línea">
          Duplicar
        </FooterButton>
      )}

      {setGroup && onSeparateFromSet && (
        <FooterButton
          onClick={onSeparateFromSet}
          icon={Boxes}
          title="Sacar esta línea del conjunto; vuelve a ser una línea independiente"
        >
          Separar del conjunto
        </FooterButton>
      )}
      {alternativeGroup && onUngroup && (
        <FooterButton
          onClick={onUngroup}
          icon={GitFork}
          title="Sacar esta línea del grupo de alternativas; vuelve a ser una línea independiente"
        >
          Separar de las alternativas
        </FooterButton>
      )}

      <div className="flex-1" />

      <button
        type="button"
        onClick={onRemove}
        className="inline-flex items-center justify-center w-8 h-8 coarse:w-10 coarse:h-10 rounded-md text-ink-400 hover:text-red-600 hover:bg-red-50 active:bg-red-100 transition-colors"
        aria-label="Eliminar línea"
        title="Eliminar línea"
      >
        <Trash2 size={15} />
      </button>
    </div>
  );
}

// A single footer action — quiet text+icon button reusing the project's
// ghost-button feel. `active` paints the pressed state for the Opcional
// toggle (the only stateful action in the row); everything else is a plain
// command. On touch the min-height bumps to 40px so it's a comfortable tap
// target without making the desktop row tall.
function FooterButton({ onClick, icon: Icon, children, active, title, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`inline-flex items-center gap-1.5 text-[11px] font-medium rounded-md px-2 py-1 coarse:min-h-10 transition-colors ${
        active
          ? 'text-ink-700 bg-ink-100 hover:bg-ink-200'
          : 'text-ink-500 hover:text-ink-900 hover:bg-ink-100 active:bg-ink-200'
      }`}
      {...rest}
    >
      <Icon size={13} className="opacity-80" aria-hidden />
      {children}
    </button>
  );
}
