/**
 * Togo 3D scene builder — the three.js half of the preview, with three.js
 * DEPENDENCY-INJECTED so it carries no static `three` import. That keeps the
 * heavy engine fully code-split (the React viewer loads it via safeDynamicImport
 * and passes it in) AND lets the screenshot harness build the identical scene
 * for visual QA off one implementation.
 *
 * It turns a `resolveTogoScene` spec into a furniture THREE.Group: each piece is
 * a pile of RoundedBoxes (lib/togo/togoModel) sized to its real footprint,
 * upholstered in the chosen fabric (a swatch texture, or a tasteful default
 * Togo colour), placed + rotated to match the 2D plan. When real Togo GLBs land
 * (the dealer's pCon/OFML channel), swap the per-piece build for a glTF load —
 * the layout/material wiring here is unchanged.
 */
import { togoParts, autoUnitScale } from '../../lib/togo/togoModel.js';
import { traceGridLoops } from '../../lib/togo/meshToPlan.js';

// sRGB ↔ linear-light transfer (the exact IEC 61966-2-1 curve). Used to average
// swatch pixels in LINEAR light (gamma-correct) so the sampled colour isn't
// biased lighter — averaging sRGB bytes directly is a classic "too light" error.
const S2L = (b) => { const c = b / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const L2S = (l) => { const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, c)) * 255); };

// Default Togo upholstery when no fabric is picked — a warm, mid neutral that
// reads as fabric under the studio IBL (not flat plastic).
const DEFAULT_COLOR = 0xB8AFA3;
const DEG = Math.PI / 180;

/**
 * Procedural fabric GRAIN normal map — the fine woven micro-relief that keeps
 * the upholstery from reading as smooth plastic (the big quilt CHANNELS are real
 * geometry now, see togoModel.togoParts). Built once (canvas heightfield →
 * finite-difference normals), tiled on every fabric material. A non-zero
 * `channels` still bakes in soft horizontal grooves if ever wanted.
 * Returns a THREE.Texture (linear — it's a normal map, not colour).
 */
export function makeQuiltNormalMap(THREE, { size = 256, channels = 0, weave = 150, strength = 1.4 } = {}) {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const TAU = Math.PI * 2;
  // Height field: a fine woven grain (+ optional soft horizontal grooves).
  const H = (x, y) => {
    const v = y / size, u = x / size;
    const ch = channels ? (Math.cos(v * TAU * channels) * 0.5 + 0.5) ** 1.7 : 0;
    const grain = (Math.sin(u * TAU * weave) + Math.sin(v * TAU * weave)) * 0.5;
    return ch + grain * 0.18;
  };
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const hL = H((x - 1 + size) % size, y), hR = H((x + 1) % size, y);
      const hD = H(x, (y - 1 + size) % size), hU = H(x, (y + 1) % size);
      let nx = (hL - hR) * strength, ny = (hD - hU) * strength, nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
      const i = (y * size + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * A physically-based fabric material — the single biggest fidelity lever for
 * upholstery. MeshPhysicalMaterial adds a SHEEN lobe (the soft retro-reflective
 * glow real fabric has at grazing angles), tuned by the material editor. Takes
 * the swatch texture (tiled, sRGB) or a neutral colour, plus an optional weave
 * normal map. `tex` is an already-loaded THREE.Texture or null.
 */
export function makeFabricMaterial(THREE, tex, opts = {}) {
  const base = new THREE.Color(opts.color ?? (tex ? 0xffffff : DEFAULT_COLOR));
  const mat = new THREE.MeshPhysicalMaterial({
    color: base,
    roughness: opts.roughness ?? 0.85,             // matte cloth
    metalness: 0,                                  // dielectric — never plastic/metal
    // A moderate sheen lobe tinted to the FABRIC's own hue (NOT white): velvet
    // glow at grazing angles without washing the colour to a pale film. Kept
    // moderate (not maxed) so it reads as velvet but doesn't lighten the body.
    sheen: opts.sheen ?? 0.7,
    sheenRoughness: opts.sheenRoughness ?? 0.6,
    sheenColor: new THREE.Color(opts.sheenColor ?? base),
    // A thin clearcoat lobe for coated finishes (leather) — off by default so
    // matte/cloth finishes pay nothing. Layers on top of the sheen.
    clearcoat: opts.clearcoat ?? 0,
    clearcoatRoughness: opts.clearcoatRoughness ?? 0.4,
    envMapIntensity: opts.envMapIntensity ?? 0.7,
  });
  if (tex) {
    tex.colorSpace = THREE.SRGBColorSpace;        // base colour is sRGB
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;  // tile the small swatch
    tex.repeat.set(opts.repeat || 3, opts.repeat || 3);
    tex.anisotropy = opts.anisotropy || 8;
    mat.map = tex;
  }
  if (opts.normalMap) {
    mat.normalMap = opts.normalMap;
    const ns = opts.normalScale ?? 0.5;
    mat.normalScale = new THREE.Vector2(ns, ns);
  }
  return mat;
}

/**
 * The DOMINANT colour of a Ligne Roset swatch image (a packed 0xRRGGBB int) or
 * null. LR swatches are a folded fabric photo with an A–F letter strip down the
 * LEFT edge, so we average the right ~75% and drop near-white/near-black pixels
 * (the strip, blown highlights, fold shadows) for a true, saturated velvet
 * colour. Reading the pixels needs a CORS-clean image — the swatch-proxy gives
 * that; a direct (tainted) load throws on getImageData → null → default colour.
 * Returns null under Node (no `document`) so the export path stays test-safe.
 */
export function sampleSwatchColor(image) {
  try {
    if (typeof document === 'undefined' || !image || !image.width || !image.height) return null;
    const cv = document.createElement('canvas');
    const w = (cv.width = 96), h = (cv.height = 96);
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    const x0 = Math.floor(w * 0.18), x1 = Math.floor(w * 0.97);
    const y0 = Math.floor(h * 0.06), y1 = Math.floor(h * 0.94);
    // Pass 1 — gather opaque-pixel luminances to find the swatch's MEDIAN tone.
    const lums = [];
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 8) continue;
        lums.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
      }
    }
    if (!lums.length) return null;
    lums.sort((a, b) => a - b);
    const med = lums[lums.length >> 1];
    // Pass 2 — average (in LINEAR light) only the MATTE MIDTONES around the median.
    // Velvet swatches are shot with a bright diagonal sheen fold; that fold is a
    // specular highlight, NOT the fabric colour, and averaging it in is exactly
    // what made deep colours sample out pale. Reject it (and the deep shadow
    // folds) by keeping a band around the median → the true diffuse colour.
    const lo = Math.max(14, med * 0.5), hi = Math.min(240, med * 1.28);
    let lr = 0, lg = 0, lb = 0, n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        if (data[i + 3] < 8) continue;
        const R = data[i], G = data[i + 1], B = data[i + 2];
        const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
        if (lum < lo || lum > hi) continue;
        lr += S2L(R); lg += S2L(G); lb += S2L(B); n++;
      }
    }
    if (!n) return null;
    // Encode the linear average back to an sRGB hex; THREE.Color reads it as sRGB
    // and decodes once → the material's working colour is the true linear mean.
    return (L2S(lr / n) << 16) | (L2S(lg / n) << 8) | L2S(lb / n);
  } catch { return null; }
}

/**
 * Drop a loaded REAL model (a pCon export — GLB/OBJ/FBX/DAE/3DS, already
 * tessellated) into a piece group: clone it, upholster every mesh in the piece's
 * fabric material (so "drag a fabric" works exactly like in pCon), apply the
 * descriptor's axis/facing fixups, scale it UNIFORMLY (true to the FBX — never a
 * per-axis squash), then recentre on its footprint and sit it on the floor — so the
 * export's own origin/scale/up-axis don't matter and the piece lands EXACTLY where
 * the 2D plan shows it.
 */
function placeRealModel(THREE, object, material, desc, pieceGroup, footprint) {
  const clone = object.clone(true);
  clone.traverse((o) => {
    if (o.isMesh) {
      o.material = material;
      // clone(true) shares the source geometry by reference; clone it so the group
      // OWNS its buffers and disposeGroup never frees the cached model's.
      if (o.geometry) o.geometry = o.geometry.clone();
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  // Orientation fixups. The loader ALREADY applies the file's up-axis, so these are
  // MANUAL overrides: stand up a mis-tagged Z-up export, then spin the open front
  // toward the viewer.
  if (desc?.upAxis === 'z') clone.rotation.x = -Math.PI / 2;
  if (desc?.rotateY) clone.rotation.y += (desc.rotateY * Math.PI) / 180;
  clone.updateMatrixWorld(true);

  // ONE uniform scale — the FBX keeps its TRUE size and proportions (a square corner
  // stays square; a per-axis "fit to tile" is what once turned it rectangular). A
  // dealer-set desc.scale wins (a manual override); otherwise the auto-unit guard
  // only corrects a gross mm/cm/m export (a power of ten off the real ~72 cm Togo
  // height), so the model renders at its real modelled size — true to the FBX.
  const wrap = new THREE.Group();
  wrap.add(clone);
  const size0 = new THREE.Box3().setFromObject(clone).getSize(new THREE.Vector3());
  const base = Number(desc?.scale) > 0 ? Number(desc.scale) : autoUnitScale(size0.y);
  wrap.scale.setScalar(base);
  wrap.updateMatrixWorld(true);

  // FILL THE FOOTPRINT. The modelled Togo sits a couple % INSIDE its catalogue
  // footprint, so two pieces snapped flush (footprint edges touching) still showed
  // a visible gap between the cushions — "the white space". Stretch the wrap in X
  // and Z just enough that the mesh's footprint EXACTLY matches widthCm × depthCm,
  // so flush pieces actually touch. The correction is tiny (~1.0–1.05) and per-axis
  // ratios are near-equal, so it doesn't visibly distort; clamped so a grossly
  // wrong mesh is never warped. Height (Y) is untouched (stays the true ~72 cm).
  const sz = new THREE.Box3().setFromObject(wrap).getSize(new THREE.Vector3());
  const w = Number(footprint?.widthCm) || 0, d = Number(footprint?.depthCm) || 0;
  if (w > 0 && d > 0 && sz.x > 1e-3 && sz.z > 1e-3) {
    const clamp = (r) => Math.max(0.85, Math.min(1.18, r));
    wrap.scale.x = base * clamp(w / sz.x);
    wrap.scale.z = base * clamp(d / sz.z);
    wrap.updateMatrixWorld(true);
  }

  // Recentre on the footprint and sit it on the floor — the export's own origin and
  // up-axis stop mattering, and the piece lands where the 2D plan shows it.
  const box = new THREE.Box3().setFromObject(wrap);
  const c = box.getCenter(new THREE.Vector3());
  wrap.position.set(-c.x, -box.min.y, -c.z);
  pieceGroup.add(wrap);
}

/**
 * Build the furniture group from a scene spec. `textureFor(fabricCode)` returns
 * a THREE.Texture or null (the caller owns loading/caching). `modelFor(piece)`
 * returns `{ object, desc }` for a real loaded model (or null to fall back to
 * procedural geometry) — so the SAME scene shows real Togo models the moment
 * they're wired and generated cushions until then. Pieces share one material
 * each (one per piece), so a fabric swap is a single `.map` change.
 */
export function buildTogoGroup(deps, scene3d, opts = {}) {
  const { THREE, RoundedBoxGeometry } = deps;
  const colorFor = opts.colorFor || (() => null);
  const modelFor = opts.modelFor || (() => null);
  const group = new THREE.Group();

  for (const piece of (scene3d?.pieces || [])) {
    const pieceGroup = new THREE.Group();
    // Upholster in the swatch's DOMINANT colour (sampled from the LR swatch, the
    // A–F letter strip skipped) rather than tiling the folded swatch PHOTO, which
    // repeats its letters/folds/seams; the quilt normal supplies the micro-weave.
    const material = makeFabricMaterial(THREE, null, { ...opts, color: colorFor(piece.fabricCode) ?? opts.color });
    const real = modelFor(piece);
    if (real && real.object) {
      placeRealModel(THREE, real.object, material, real.desc, pieceGroup, { widthCm: piece.widthCm, depthCm: piece.depthCm });
    } else {
      for (const part of togoParts(piece.widthCm, piece.depthCm, piece.form)) {
        let mesh;
        if (part.shape === 'ridge') {
          // A channel: a capsule laid along the width (x) or depth (z).
          mesh = new THREE.Mesh(new THREE.CapsuleGeometry(part.radius, part.length, 8, 18), material);
          mesh.rotation[part.axis === 'x' ? 'z' : 'x'] = Math.PI / 2;
        } else {
          const seg = Math.max(2, Math.round(part.r / 4));
          mesh = new THREE.Mesh(new RoundedBoxGeometry(part.w, part.h, part.d, seg, part.r), material);
        }
        mesh.position.set(part.x, part.y, part.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        pieceGroup.add(mesh);
      }
    }
    // Plan x→world x, plan y→world z; the plan's clockwise screen rotation is a
    // negative rotation about the up axis in three's right-handed XZ floor.
    pieceGroup.position.set(piece.x, 0, piece.z);
    pieceGroup.rotation.y = -(piece.rotationDeg || 0) * DEG;
    group.add(pieceGroup);
  }
  return group;
}

/**
 * Bake a piece group's mesh vertices into a flat Float32Array in the GROUP'S OWN
 * local frame (so it's invariant to the group's placement/rotation — a drag just
 * moves the group, the cache stays valid). Snapshot it once per selection; project
 * it every frame. The pad/contour helper meshes are skipped.
 */
export function collectLocalVerts(THREE, group) {
  if (!group) return new Float32Array(0);
  group.updateMatrixWorld(true);
  const inv = group.matrixWorld.clone().invert();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  const out = [];
  group.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position || o.userData?.contour || o.userData?.pad) return;
    o.updateWorldMatrix(true, false);
    m.multiplyMatrices(inv, o.matrixWorld);
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      out.push(v.x, v.y, v.z);
    }
  });
  return new Float32Array(out);
}

/**
 * The EXACT on-screen silhouette of a piece, in CSS pixels — the perspectivally-
 * correct outline you'd trace around the rendered model.
 *
 * The math is the standard graphics pipeline, the same a GPU runs per vertex:
 *   world = groupWorld · vLocal            (place the snapshot in the world)
 *   clip  = projection · view · world       (camera.project does view·proj + the
 *   ndc   = clip.xyz / clip.w               perspective divide, w = −view-space z)
 *   px    = ((ndc.x+1)/2·W, (1−ndc.y)/2·H)  (NDC → viewport)
 * Because the divide by w is where perspective lives, a vertex sitting higher on
 * the cushion (nearer the lens) lands FARTHER out in px than one at the floor —
 * which is exactly why a flat floor ring never matched the bulge, and why we must
 * project the real geometry. We then splat the projected vertices into a pixel
 * occupancy grid (a small dilation bridges the gaps between samples), trace the
 * outer boundary with the shared `traceGridLoops`, and Chaikin-smooth it. The
 * result hugs the model to the pixel at any camera pose, piece position, or zoom.
 *
 * `verts` is the local snapshot from `collectLocalVerts`; `worldMatrix` is the
 * group's CURRENT matrixWorld; `camera` the live camera; `w`,`h` the canvas CSS
 * size. Returns the largest loop as `[{x,y}, …]` px, or null if it can't be built.
 */
export function projectScreenSilhouette(THREE, verts, worldMatrix, camera, w, h, { target = 230, dilate = 2, smooth = 2 } = {}) {
  const n = (verts?.length || 0) / 3;
  if (n < 3 || !(w > 0) || !(h > 0)) return null;
  const v = new THREE.Vector3();
  const px = new Float64Array(n * 2);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    v.set(verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]).applyMatrix4(worldMatrix).project(camera);
    const x = (v.x * 0.5 + 0.5) * w, y = (-v.y * 0.5 + 0.5) * h;
    px[i * 2] = x; px[i * 2 + 1] = y;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const spanX = maxX - minX, spanY = maxY - minY;
  if (!(spanX > 0) || !(spanY > 0)) return null;
  const cell = Math.max(0.5, Math.max(spanX, spanY) / target);
  const pad = dilate + 1;
  const gw = Math.ceil(spanX / cell) + 1 + 2 * pad;
  const gh = Math.ceil(spanY / cell) + 1 + 2 * pad;
  const occ = new Uint8Array(gw * gh);
  for (let i = 0; i < n; i++) {
    const gx = Math.floor((px[i * 2] - minX) / cell) + pad;
    const gy = Math.floor((px[i * 2 + 1] - minY) / cell) + pad;
    for (let dy = -dilate; dy <= dilate; dy++) {
      const ay = gy + dy; if (ay < 0 || ay >= gh) continue;
      for (let dx = -dilate; dx <= dilate; dx++) {
        const ax = gx + dx; if (ax < 0 || ax >= gw) continue;
        occ[ay * gw + ax] = 1;
      }
    }
  }
  const loops = traceGridLoops(occ, gw, gh, cell, cell);
  if (!loops.length) return null;
  let best = loops[0], bestA = polyArea(best);
  for (let i = 1; i < loops.length; i++) { const a = polyArea(loops[i]); if (a > bestA) { bestA = a; best = loops[i]; } }
  const ox = minX - pad * cell, oy = minY - pad * cell;
  return chaikinClosed(best.map((p) => ({ x: p.x + ox, y: p.y + oy })), smooth);
}

function polyArea(poly) {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; s += p.x * q.y - q.x * p.y; }
  return Math.abs(s) / 2;
}

// Chaikin corner-cutting on a CLOSED polygon: each pass replaces every vertex
// with two points 1/4 and 3/4 along its outgoing edge, so the polyline converges
// to a smooth quadratic B-spline — the grid's stair-steps melt into a flowing
// curve. A few passes are plenty (each roughly halves the residual jaggedness).
function chaikinClosed(pts, iters = 3) {
  let p = pts;
  if (p.length < 4) return p;
  for (let k = 0; k < iters; k++) {
    const out = [];
    const n = p.length;
    for (let i = 0; i < n; i++) {
      const u = p[i], w = p[(i + 1) % n];
      out.push({ x: u.x * 0.75 + w.x * 0.25, y: u.y * 0.75 + w.y * 0.25 });
      out.push({ x: u.x * 0.25 + w.x * 0.75, y: u.y * 0.25 + w.y * 0.75 });
    }
    p = out;
  }
  return p;
}

/** The radius of the layout (cm) for framing the camera — half the footprint
 *  diagonal, with a floor for a single small piece. */
export function sceneRadius(scene3d) {
  const o = scene3d?.overallCm || { widthCm: 0, depthCm: 0 };
  return Math.max(90, Math.hypot(o.widthCm, o.depthCm) / 2);
}

/**
 * Studio rig: a neutral image-based environment (RoomEnvironment — no HDR asset
 * to ship) for soft realistic fabric shading, a key light that casts a soft
 * ground shadow, fill, and a large floor that only catches shadow. Mutates
 * `scene` and returns a dispose(). The caller owns the renderer/camera/controls.
 */
export function setupTogoStage(deps, renderer, scene, radius) {
  const { THREE, RoomEnvironment } = deps;
  scene.background = new THREE.Color(0xF4F1EC);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new RoomEnvironment();
  const envRT = pmrem.fromScene(envScene, 0.04);
  scene.environment = envRT.texture;

  // Colour-accurate AND fold-accentuating product lighting. The IBL still does
  // the fill (so a dark/saturated swatch keeps its TRUE depth — a hot key once
  // washed deep velvets pale), but the KEY now comes in at a LOW, RAKING angle so
  // it skims ACROSS the Togo's channels and throws a shadow into every fold
  // valley — the contrast that makes the quilting read plush instead of flat. A
  // steep top-down key (what we had) lit the fold crests and floors equally and
  // flattened them. Slightly warm + a touch stronger to deepen those shadows.
  const key = new THREE.DirectionalLight(0xfff4e8, 1.55);
  key.position.set(radius * 1.2, radius * 0.95, radius * 0.5);   // low & to the side → grazes the folds
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  const d = radius * 2.2;
  Object.assign(key.shadow.camera, { left: -d, right: d, top: d, bottom: -d, near: 1, far: radius * 6 });
  key.shadow.bias = -0.0004;
  key.shadow.radius = 3.5;     // a touch crisper → the channel/contact shadows read
  scene.add(key);
  // A dim, low rim from the opposite side carves the shadow-side folds (so they
  // don't go to mush) WITHOUT lifting the body — keeps the deep-crease contrast.
  const rim = new THREE.DirectionalLight(0xe8f0ff, 0.34);
  rim.position.set(-radius * 0.95, radius * 0.45, -radius * 0.85);
  scene.add(rim);
  // Lower hemisphere fill so the channel valleys stay genuinely shadowed — drives
  // most of the seat's depth (a high fill is what flattened the quilting).
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b2a6, 0.1));

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 12, radius * 12),
    new THREE.ShadowMaterial({ opacity: 0.34 }),   // deeper ground-contact shadow under each seat
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0;
  floor.receiveShadow = true;
  scene.add(floor);

  return () => {
    envRT.texture.dispose();
    pmrem.dispose();
    if (typeof envScene.dispose === 'function') envScene.dispose();
    floor.geometry.dispose();
    floor.material.dispose();
  };
}

/** Dispose every geometry/material/(swatch) texture under a group (free GPU
 *  memory). Idempotent per object via a seen-set, so a material/geometry shared
 *  across many meshes (the real-model path) is disposed exactly ONCE. The shared
 *  quilt normal map is intentionally NOT touched — the owner disposes it. */
export function disposeGroup(group) {
  const seen = new Set();
  const once = (o, fn) => { if (o && !seen.has(o)) { seen.add(o); fn(); } };
  group?.traverse?.((o) => {
    once(o.geometry, () => o.geometry.dispose());
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      once(m.map, () => m.map.dispose());
      once(m, () => m.dispose());
    }
  });
}
