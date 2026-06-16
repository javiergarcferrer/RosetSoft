# Togo configurator — research + roadmap

Research into online furniture/sofa configurators and room planners, scoped to
what's worth building for our 2D top-down Togo planner, plus the CAD-export spec
behind the **DXF download** feature. Facts are web-sourced (citations at the
end); the DXF spec is grounded in the Autodesk DXF reference and ezdxf.

## The strategic finding

**No consumer sofa configurator exports CAD.** Lovesac, Burrow, Article and
Joybird top out at PDF + image + share-link + add-to-cart. CAD export (DXF/DWG)
exists only behind paywalls in prosumer floor planners (Planner5D PRO,
Floorplanner, SketchUp Pro) and as static per-product symbol libraries from
contract brands (Herman Miller, Steelcase, Knoll) — never from a live
configurator. **A live Togo planner that emits a designer-grade DXF of the exact
layout the customer just built is genuine white space**, and the single most
defensible differentiator here. The closest comparable to study is **Lovesac
Sactionals** (atomic parts, drag-drop assembly, snapping, live price, save/share)
— its export ceiling (PDF + link + cart) is exactly what we leapfrog.

## Prioritized features (impact / effort)

Effort assumes our existing 2D SVG canvas + `lib/pricing` engine.

| # | Feature | Impact | Effort | Status |
|---|---------|--------|--------|--------|
| 1 | Edge-snapping with manufacturability rules (valid-neighbour table per piece) | Very high | Low–Med | snapping shipped; buildability rules = TODO |
| 2 | **Live assembled dimensions** (overall W×D) + live price | Very high | Low | **shipped** (`resolveConfigurator.overallCm`) |
| 3 | **Downloadable DXF/CAD plan** (scaled, layered, cm) | Very high | Med | **shipped** (`lib/togo/planToDxf.js`) |
| 4 | Toggleable dimension annotations (per-piece + overall) | High | Low | partial (overall shown; per-piece overlay TODO) |
| 5 | Undo/redo + duplicate | High | Low–Med | TODO |
| 6 | Custom room dimensions (enter W×L, sofa snaps inside) | High | Med | TODO (also exports as the DXF room outline) |
| 7 | Layout presets (popular L / U / straight Togo layouts) | High | Low | TODO — cheapest big win (seed data only) |
| 8 | Group/ungroup the assembled sofa (move as one) | High | Low–Med | TODO |
| 9 | Keyboard nudge (arrows) + snap toggle | Med | Low | TODO |
| 10 | Fabric→price + swatch legend (not photoreal in 2D) | Med–High | Med | shipped (MaterialColorPicker) |
| 11 | Mobile/touch ergonomics | Med | Med | partial (pointer drag works) |
| 12 | "View in room" / AR | Med (sales) | High | defer (true AR needs 3D assets) |
| 13 | Full 2D↔3D switching | Med (wow) | Very high | defer (lowest impact-for-effort) |

**Build order from here:** snapping buildability rules (#1) → presets (#7) →
undo/redo + duplicate (#5) → room dimensions (#6) → group/ungroup (#8). Skip true
AR and 2D↔3D.

### Designer-facing presentation (the DXF audience)

Mirror the contract-furniture A&D world: a clear format menu ("Plano — DXF"),
real 1:1 scale with explicit units, clean named layers, and always pair the
download with "request quote / send to dealer." Treat a public CAD download as
lead-gen.

## DXF authoring spec (what we built)

### Format decision: DXF, not DWG

- **DWG authoring in pure JS/WASM is not viable.** The leading stack
  (`@mlightcad/libredwg-web`) is **read-only** ("supports reading DWG and DXF
  file only") and its libredwg core is **GPL/LGPL** — a licensing landmine.
- **DXF is the standard interchange** — plain ASCII, opens in AutoCAD, LibreCAD,
  Vectorworks, ArchiCAD, SketchUp Pro, and every online viewer.
- **Version: R12 (`AC1009`)** — the most forgiving target and, crucially, it
  needs **no handles** (`$HANDSEED` / per-entity code 5). The cost: R12 has **no
  `LWPOLYLINE`**, so closed outlines use the heavyweight `POLYLINE`/`VERTEX`/
  `SEQEND`. (R2000 `AC1015` gets `LWPOLYLINE` but expects handles — not worth the
  bookkeeping for a hand-rolled, zero-dependency writer.)

### Structure (`src/lib/togo/planToDxf.js`)

- **HEADER**: `$ACADVER=AC1009`, `$INSUNITS=5` (centimetres), `$MEASUREMENT=1`
  (metric), `$EXTMIN`/`$EXTMAX` (the bounding box → Zoom Extents frames it).
- **TABLES**: `LTYPE` (CONTINUOUS), `STYLE` (STANDARD, so TEXT is robust),
  `LAYER` — three layers: `TOGO-MUEBLES` (outlines), `TOGO-TEXTO` (labels),
  `TOGO-CONJUNTO` (overall-size frame).
- **ENTITIES**: each piece's plan outline (the real "Mobilier 2D" geometry) as
  `LINE` (2-pt strokes) / `POLYLINE` (multi-pt) / `CIRCLE`; a `TEXT` label per
  piece; a closed `POLYLINE` frame of the overall footprint + a `TEXT` heading
  "Togo · W×D cm". `EOF` terminates.
- **Units**: 1 drawing unit = 1 cm, real-world size; the recipient picks the plot
  scale.
- **Geometry**: the configurator works in cm, y-DOWN; the DXF flips to y-UP once,
  at emit, and shifts to a clean (0,0) origin. Each piece's SVG is scaled to its
  footprint, centred, and rotated by the 90° step EXACTLY as the on-screen tile,
  so the DXF matches the configurator. No SVG → the footprint rectangle (still
  carries the right size).
- **Dimensions trap avoided**: a true `DIMENSION` entity needs an anonymous `*D`
  block + `DIMSTYLE` — the #1 "opens but looks broken" failure. We draw the
  overall size as a labelled frame instead (visually identical, opens everywhere).
- **Line endings**: CRLF (AutoCAD prefers it).

Validated by re-parsing the output with `dxf-parser` (the reader behind many web
DXF viewers): all entities, layers, header vars and labels round-trip. Pinned by
`tests/togoPlanDxf.test.js`.

### Where it's wired

- **Solicitudes** (received web requests) → "Plano DXF" per request card.
- **Public configurator** (`TogoEmbed`) → "Plano" download (the differentiator).
- **Quote** (`TotalsDock`) → "Plano DXF", shown only when the quote carries a
  Togo plan line — so a request promoted out of the inbox stays exportable.

## Sources

- DXF technical: [ezdxf file structure](https://ezdxf.readthedocs.io/en/stable/dxfinternals/filestructure.html) ·
  [ezdxf data model (R12 handles / LWPOLYLINE)](https://ezdxf.readthedocs.io/en/stable/dxfinternals/datamodel.html) ·
  [ezdxf LWPolyline (requires R2000)](https://github.com/mozman/ezdxf/blob/master/docs/source/dxfentities/lwpolyline.rst) ·
  [ezdxf units ($INSUNITS)](https://ezdxf.readthedocs.io/en/stable/concepts/units.html) ·
  [Autodesk: manually writing a minimal DXF](https://forums.autodesk.com/t5/visual-lisp-autolisp-and-general/manually-writing-a-minimal-dxf/td-p/2081140) ·
  [Entity DXF group codes](https://techshelps.github.io/AutoLispTutorial/autolispexp_enti.html) ·
  [AutoCAD R12 DXF reference (PDF)](https://damassets.autodesk.net/content/dam/autodesk/www/developer-network/platform-technologies/autocad-dxf-archive/acad_r12_dxf.pdf)
- JS DWG/DXF feasibility: [realdwg-web (read-only, GPL)](https://github.com/mlightcad/realdwg-web) ·
  [libredwg-web npm](https://www.npmjs.com/package/@mlightcad/libredwg-web) ·
  [@tarikjabiri/dxf writer](https://github.com/dxfjs/writer) · [dxf-parser](https://github.com/gdsestimating/dxf-parser)
- Configurators & export: [Lovesac via Threekit](https://www.threekit.com/blog/lovesac-the-ultimate-magento-product-configurator) ·
  [DFS Room Planner](https://www.dfs.co.uk/brands/sofables-modular-furniture) ·
  [West Elm Room Planner](https://www.westelm.com/pages/ideas-and-advice/room-planner/) ·
  [IKEA planners](https://www.ikea.com/us/en/planners/) ·
  [Planner5D CAD export](https://planner5d.com/pro/exportcad) ·
  [Floorplanner project levels](https://floorplanner.com/project-levels) ·
  [RoomSketcher download options](https://help.roomsketcher.com/hc/en-us/articles/21708083291933-What-Options-Do-I-Have-When-I-Download-or-Print-My-Floor-Plans) ·
  [Herman Miller symbol libraries](https://www.hermanmiller.com/resources/3d-models-and-planning-tools/symbol-libraries/) ·
  [DWG vs DXF (Scan2CAD)](https://www.scan2cad.com/blog/tips/use-dwg-dxf/)
