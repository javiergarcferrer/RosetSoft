import { useCallback, useEffect, useRef, useState } from 'react';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { swatchProxyUrl, swatchUrl } from '../../lib/swatchImage.js';
import { inferTogoForm, TOGO_HEIGHT_CM } from '../../lib/togo/togoModel.js';
import { footprintOf, snapPlacement, clampToPlan, resolvePlacement } from '../../core/quote/index.js';
import { loadTogoModels } from './togoModelLoader.js';
import { buildTogoGroup, setupTogoStage, disposeGroup, makeQuiltNormalMap, sampleSwatchColor, floorContourLoops } from './togoSceneBuilder.js';

const DEFAULT_FINISH = { sheen: 0.7, sheenRoughness: 0.6, roughness: 0.85, repeat: 3, normalScale: 0.45 };
const norm360 = (d) => (((d % 360) + 360) % 360);
const PLAN_W = 760, PLAN_H = 540;
const CONTOUR_INK = 0x726a5d, CONTOUR_SEL = 0xb08d57;   // neutral vs brand-gold
const FILL_OPACITY = 0.1, FILL_OPACITY_SEL = 0.2;       // the soft silhouette body
const EDGE_OPACITY = 0.85, EDGE_OPACITY_SEL = 1;

/**
 * The 2D contour for a piece, lying flat on the floor under the top-down camera —
 * the EXACT top-down silhouette of the piece (channels, arms, corner cut and all),
 * not a generic box. `loops` are closed cm polygons in the piece's local frame
 * (from `floorContourLoops`, derived from the SAME geometry that renders): the
 * largest is the body outline, any others are interior holes. Drawn as a soft
 * translucent FILL (a precise floor projection) plus a crisp edge LINE on top, so
 * the shape reads whether it peeks past the cushions or sits flush under them.
 * Returned group sits at the footprint centre; it rides the piece's placement
 * rotation because it's added as a child of the (rotated) piece group.
 */
function buildSilhouetteContour(THREE, loops, { color = CONTOUR_INK } = {}) {
  const holder = new THREE.Group();
  // Largest |area| loop is the body; the rest are holes punched into the fill.
  const area = (poly) => { let s = 0; for (let i = 0, n = poly.length; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; s += p.x * q.y - q.x * p.y; } return Math.abs(s) / 2; };
  const sorted = [...loops].sort((a, b) => area(b) - area(a));
  const toShapePts = (poly) => poly.map((p) => new THREE.Vector2(p.x, p.y));
  const shape = new THREE.Shape(toShapePts(sorted[0]));
  for (let i = 1; i < sorted.length; i++) shape.holes.push(new THREE.Path(toShapePts(sorted[i])));

  const fill = new THREE.Mesh(
    new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: FILL_OPACITY, depthWrite: false, side: THREE.DoubleSide }),
  );
  fill.userData.contourFill = true;
  holder.add(fill);

  for (const poly of sorted) {
    const geo = new THREE.BufferGeometry();
    const arr = new Float32Array(poly.length * 3);
    for (let i = 0; i < poly.length; i++) { arr[i * 3] = poly[i].x; arr[i * 3 + 1] = poly[i].y; arr[i * 3 + 2] = 0; }
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    // depthTest off → the crisp silhouette edge always draws on top in the
    // top-down view, so it reads even where the cushion bulge sits over its own
    // floor-level outline (the fill keeps depth-test, so it just peeks at the rim).
    const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: EDGE_OPACITY, depthWrite: false, depthTest: false }));
    line.userData.contourEdge = true;
    line.renderOrder = 3;
    holder.add(line);
  }

  holder.rotation.x = Math.PI / 2;   // Shape XY → floor XZ (Shape Y → world +Z = depth)
  holder.position.y = 1.2;
  holder.renderOrder = 2;
  return holder;
}

/**
 * Fallback contour when the silhouette can't be traced (degenerate geometry): a
 * flat rounded-rectangle OUTLINE ring at the footprint, built as a filled SHAPE
 * with a same-shape HOLE so its thickness is exact (WebGL line width is
 * unreliable). Rounded to match the Togo's soft corners.
 */
function buildFootprintRing(THREE, w, d, { thickness = 2.4, color = CONTOUR_INK, opacity = 0.9 } = {}) {
  const rr = (W, H, r) => {
    const s = new THREE.Shape();
    const x = -W / 2, y = -H / 2, k = Math.max(0, Math.min(r, W / 2, H / 2));
    s.moveTo(x + k, y);
    s.lineTo(x + W - k, y); s.quadraticCurveTo(x + W, y, x + W, y + k);
    s.lineTo(x + W, y + H - k); s.quadraticCurveTo(x + W, y + H, x + W - k, y + H);
    s.lineTo(x + k, y + H); s.quadraticCurveTo(x, y + H, x, y + H - k);
    s.lineTo(x, y + k); s.quadraticCurveTo(x, y, x + k, y);
    return s;
  };
  const r = Math.min(w, d) * 0.2;
  const outer = rr(w, d, r);
  outer.holes.push(rr(Math.max(1, w - 2 * thickness), Math.max(1, d - 2 * thickness), Math.max(0, r - thickness)));
  const geo = new THREE.ShapeGeometry(outer);
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;   // flat on the floor (Shape is XY → XZ)
  mesh.position.y = 1.2;
  mesh.userData.contourEdge = true;
  mesh.renderOrder = 2;
  return mesh;
}

/**
 * THE configurator stage — ONE three.js scene for BOTH "2D" and "3D". The 2D plan
 * is just this scene under a top-down camera with drag-to-arrange; "3D" is the
 * same scene under a perspective orbit camera. Switching modes ANIMATES the camera
 * between the two (the layout pans/tilts into position), so the views literally
 * flow into each other — no second renderer, no separate tile system, and material
 * changes are always live because there's only ever the one real scene.
 *
 * Editing (2D mode): tap a piece to select; drag it on the floor (raycast → ground
 * plane), snapped flush to its neighbours and clamped to the plan. Rotate/delete/
 * fabric live in the contextual strip the parent renders. The placed state stays
 * the single source of truth — a drag just commits new plan (x,y) on release.
 *
 * Props: placed, resolvedById, mode ('2d'|'3d'), material (finish), selectedUid,
 * onSelect(uid|null), onMove(uid, x, y), onCommitStart?(), className.
 */
export default function TogoStage({
  placed = [], resolvedById = {}, mode = '2d', material, selectedUid = null,
  onSelect, onMove, onSelectedScreenPos, onPlanBounds, className = '',
}) {
  const mountRef = useRef(null);
  const api = useRef(null);
  const [failed, setFailed] = useState(false);

  // Latest props the imperative three loop reads without re-subscribing.
  const stateRef = useRef({ placed, resolvedById, mode, material, selectedUid, onSelect, onMove, onSelectedScreenPos, onPlanBounds });
  stateRef.current = { placed, resolvedById, mode, material, selectedUid, onSelect, onMove, onSelectedScreenPos, onPlanBounds };

  // placed + resolved → absolute-world pieces (NOT recentred): plan-x→world-x,
  // plan-y→world-z 1:1, so dragging one piece never shifts the others.
  const buildScene = useCallback(() => {
    const { placed: pl, resolvedById: byId } = stateRef.current;
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    const pieces = (pl || []).map((p) => {
      const r = resolvePlacement(p, byId);
      const rot = norm360(p.rot);
      const w = Number(r.widthCm) || 0, d = Number(r.depthCm) || 0;
      const fp = footprintOf({ widthCm: w, depthCm: d }, rot);
      minX = Math.min(minX, p.x); minZ = Math.min(minZ, p.y);
      maxX = Math.max(maxX, p.x + fp.w); maxZ = Math.max(maxZ, p.y + fp.h);
      return {
        uid: p.uid, widthCm: w, depthCm: d, form: inferTogoForm(r.label || r.name, w, d),
        x: (Number(p.x) || 0) + fp.w / 2, z: (Number(p.y) || 0) + fp.h / 2,
        rotationDeg: rot, fabricCode: p.material?.code || r.code || '', mesh: r.mesh || null,
      };
    });
    const has = Number.isFinite(minX);
    return {
      pieces,
      center: has ? { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 } : { x: PLAN_W / 2, z: PLAN_H / 2 },
      // Bounding-sphere radius of the layout (rotation-invariant for framing).
      radius: has ? Math.max(45, Math.hypot(maxX - minX, maxZ - minZ) / 2) : 150,
      // Plan footprint AABB (world = plan coords) for the on-plan dimension lines.
      bounds: has ? { minX, maxX, minZ, maxZ } : null,
    };
  }, []);

  // The camera pose for a mode. Distance is derived from the FOV *and the canvas
  // aspect* so the layout fits with margin even on a tall portrait phone (where
  // the horizontal field of view is the tight one — the cause of the over-zoom).
  const poseFor = useCallback((m, center, radius, aspect) => {
    const halfFov = (33 * Math.PI / 180) / 2;
    const fit = Math.max(0.4, Math.min(1, aspect || 1));     // the tighter axis
    // The distance that fits the FOOTPRINT (floor level) with ~22% margin.
    const fitDist = (radius * 1.22) / (Math.tan(halfFov) * fit);
    return m === '2d'
      // DEAD straight-down. The top-down basis is supplied by camera.up=(0,0,-1).
      // CRITICAL: add the furniture HEIGHT to the camera height. A Togo is ~72 cm
      // tall, and from straight above its cushion TOPS sit that much closer to the
      // lens — perspective magnifies them, so framing the floor footprint alone
      // let the tops blow past the frame on a short (landscape) viewport where the
      // camera is already close. Lifting the camera by the height makes the TOP
      // surface the thing that fits the margin, so nothing clips in any aspect.
      ? { px: center.x, py: fitDist + TOGO_HEIGHT_CM, pz: center.z, tx: center.x, ty: 0, tz: center.z }
      // Low front-quarter angle. Pull back by the height too so a tall stack frames.
      : { px: center.x + fitDist * 0.32, py: fitDist * 0.46 + TOGO_HEIGHT_CM * 0.5, pz: center.z + fitDist * 0.83, tx: center.x, ty: radius * 0.15, tz: center.z };
  }, []);

  // Place the camera at a pose for a mode. In 2D we drive the camera DIRECTLY
  // (top-down `up`, lookAt, OrbitControls OFF) so it's a rock-solid plan view with
  // no polar-singularity wobble; in 3D OrbitControls owns it. This is the single
  // path every framing call goes through (mount, rebuild, resize, tween-end).
  const placeCamera = useCallback((l, pose, m) => {
    const { camera, controls } = l;
    if (m === '2d') {
      camera.up.set(0, 0, -1);                 // world -z is "up" on the plan
      camera.position.set(pose.px, pose.py, pose.pz);
      controls.target.set(pose.tx, pose.ty, pose.tz);
      controls.enabled = false;                // 2D = no orbit/zoom; drag does the editing
      camera.lookAt(pose.tx, pose.ty, pose.tz);
    } else {
      camera.up.set(0, 1, 0);
      camera.position.set(pose.px, pose.py, pose.pz);
      controls.target.set(pose.tx, pose.ty, pose.tz);
      controls.enabled = true;
      controls.enableRotate = true;
      controls.update();
    }
  }, []);

  // ── Rebuild the furniture group (swatch colours + real meshes), tag each piece
  // group with its uid for raycasting, and apply the selection highlight. Does NOT
  // move the camera (so an edit never re-frames mid-drag).
  const rebuild = useCallback(async () => {
    const l = api.current; if (!l) return;
    const scene = buildScene();
    l.scene3d = scene;
    const { material: finish, selectedUid: sel } = stateRef.current;
    const codes = [...new Set(scene.pieces.map((p) => p.fabricCode).filter(Boolean))];
    const [, loaded] = await Promise.all([
      Promise.all(codes.map(async (code) => {
        if (l.colorCache.has(code)) return;
        const url = swatchProxyUrl(code) || swatchUrl(code);
        if (!url) return;
        try { const tex = await new l.THREE.TextureLoader().loadAsync(url); const c = sampleSwatchColor(tex.image); tex.dispose?.(); if (c != null) l.colorCache.set(code, c); } catch { /* default colour */ }
      })),
      loadTogoModels({ pieces: scene.pieces }, l.modelCache),
    ]);
    if (!api.current) return;
    if (l.group) { l.scene.remove(l.group); disposeGroup(l.group); }
    const group = buildTogoGroup(l.deps, scene, {
      ...DEFAULT_FINISH, ...(finish || {}), normalMap: l.quilt,
      colorFor: (c) => (l.colorCache.has(c) ? l.colorCache.get(c) : null),
      modelFor: loaded.modelFor,
    });
    // Tag every object with its piece uid (raycast → selection/drag), and give
    // each piece an INVISIBLE full-footprint grab pad so the WHOLE tile is
    // draggable — not just where the raycast happens to land on upholstery. The
    // channeled Togo has gaps between cushions; tapping a groove would otherwise
    // miss the mesh, hit the floor, and feel like "the piece won't move". The pad
    // sits flat just above the floor, sized to the catalogue footprint, and rides
    // inside the (already-rotated) piece group so it always matches the tile.
    const { THREE } = l;
    group.children.forEach((pg, i) => {
      const sp = scene.pieces[i];
      const uid = sp?.uid;
      pg.userData.uid = uid;
      pg.traverse((o) => { o.userData.uid = uid; });
      const w = Number(sp?.widthCm) || 0, d = Number(sp?.depthCm) || 0;
      if (w > 0 && d > 0) {
        const pad = new THREE.Mesh(
          new THREE.PlaneGeometry(w, d),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
        );
        pad.rotation.x = -Math.PI / 2;     // lie flat on the floor
        pad.position.y = 2;                // just above ground, under the cushions
        pad.userData.uid = uid;
        pad.userData.pad = true;
        pg.add(pad);
        // The 2D contour tracing this piece's EXACT top-down silhouette (top-down
        // only). Traced from the same geometry that renders, so it can never
        // disagree with the piece; cached per model+footprint (it's independent of
        // position/rotation), with the footprint rectangle as a last-resort fallback.
        const realUrl = loaded.modelFor(sp)?.object ? sp?.mesh?.url : null;
        const key = `${realUrl || 'proc'}|${sp?.form || ''}|${Math.round(w)}x${Math.round(d)}`;
        let loops = l.contourCache.get(key);
        if (loops === undefined) { loops = floorContourLoops(THREE, pg); l.contourCache.set(key, loops); }
        const contour = (loops && loops.length) ? buildSilhouetteContour(THREE, loops) : buildFootprintRing(THREE, w, d);
        contour.userData.uid = uid;
        contour.userData.contour = true;
        contour.visible = stateRef.current.mode === '2d';
        pg.userData.contour = contour;
        pg.add(contour);
      }
    });
    l.group = group;
    l.scene.add(group);
    applyHighlight(l, sel);
    // Frame the camera on the layout when the piece COUNT changes (add/remove) —
    // so a new piece is always in view — but NOT on a position-only change (a drag
    // commit), and never mid-drag, so arranging stays stable.
    if (scene.pieces.length !== l.framedCount && !l.drag && !l.tween) {
      l.framedCount = scene.pieces.length;
      const pose = poseFor(stateRef.current.mode, scene.center, scene.radius, l.camera.aspect);
      placeCamera(l, pose, stateRef.current.mode);
    }
    l.requestRender();
  }, [buildScene, poseFor, placeCamera]);

  // Subtle warm emissive on the selected piece (reads in both camera modes).
  function applyHighlight(l, sel) {
    if (!l?.group) return;
    const seen = new Set();
    l.group.children.forEach((pg) => {
      const on = sel != null && pg.userData.uid === sel;
      pg.traverse((o) => {
        if (o.userData?.contour || o.userData?.contourFill || o.userData?.contourEdge) return;   // the contour keeps its own colour
        const m = o.material; if (!m || !m.emissive || seen.has(m)) return; seen.add(m);
        m.emissive.setHex(on ? 0x3a342b : 0x000000);
        m.emissiveIntensity = on ? 0.5 : 0;
      });
      // The 2D silhouette contour goes brand-gold + bolder when its piece is
      // selected — fill and edge each pick up the selection colour/opacity.
      pg.userData?.contour?.traverse((o) => {
        const m = o.material; if (!m || !m.color) return;
        m.color.setHex(on ? CONTOUR_SEL : CONTOUR_INK);
        if (o.userData?.contourFill) m.opacity = on ? FILL_OPACITY_SEL : FILL_OPACITY;
        else m.opacity = on ? EDGE_OPACITY_SEL : EDGE_OPACITY;
      });
    });
    l.requestRender();
  }

  // Show the 2D contour rings only under the top-down camera.
  function setContourMode(l, mode) {
    if (!l?.group) return;
    l.group.children.forEach((pg) => { const r = pg.userData?.contour; if (r) r.visible = mode === '2d'; });
  }

  // Re-skin (finish change) without rebuilding geometry.
  const reskin = useCallback(() => {
    const l = api.current; if (!l || !l.group) return;
    const f = { ...DEFAULT_FINISH, ...(stateRef.current.material || {}) };
    const rep = f.repeat || 3, seen = new Set();
    l.group.traverse((o) => {
      const m = o.material; if (!m || seen.has(m)) return; seen.add(m);
      if ('roughness' in m) m.roughness = f.roughness;
      if ('sheen' in m) m.sheen = f.sheen;
      if ('sheenRoughness' in m) m.sheenRoughness = f.sheenRoughness;
      if (m.normalScale) m.normalScale.set(f.normalScale, f.normalScale);
      if (m.map) m.map.repeat.set(rep, rep);
    });
    l.requestRender();
  }, []);

  // ── Mount: renderer / scene / camera / controls / stage, pointer editing. ──
  useEffect(() => {
    let alive = true; let ro = null; let raf = 0; let l_cleanupResize = null;
    (async () => {
      let mods;
      try {
        mods = await Promise.all([
          safeDynamicImport(() => import('three')),
          safeDynamicImport(() => import('three/examples/jsm/controls/OrbitControls.js')),
          safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
          safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
        ]);
      } catch { if (alive) setFailed(true); return; }
      const mount = mountRef.current; if (!alive || !mount) return;
      const [THREE, { OrbitControls }, { RoomEnvironment }, { RoundedBoxGeometry }] = mods;
      const deps = { THREE, RoomEnvironment, RoundedBoxGeometry };
      const w = mount.clientWidth || 640, h = mount.clientHeight || 440;

      let renderer;
      try { renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }); }
      catch { if (alive) setFailed(true); return; }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.NeutralToneMapping;
      // The canvas ALWAYS fills its container via CSS (width/height:100%); the
      // drawing buffer is reconciled to that displayed size every frame by
      // syncSize() below. This is the robust "resizeRendererToDisplaySize"
      // pattern — it self-corrects no matter what changed the size (rotation,
      // iOS URL-bar show/hide, a missed ResizeObserver tick) so the viewport can
      // never drift off-centre or out of aspect.
      renderer.domElement.style.cssText = 'display:block;outline:none;touch-action:none;width:100%;height:100%';
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(33, w / h, 1, 20000);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.enablePan = false;
      controls.maxPolarAngle = Math.PI * 0.495;

      // Reconcile the drawing buffer + camera aspect to the canvas's CURRENT
      // displayed size, and re-frame so the layout stays centred for the new
      // aspect. Returns true if anything changed. Called at the top of every
      // render so a stale size is fixed before it's ever shown.
      const _sz = new THREE.Vector2();
      const syncSize = () => {
        const l = api.current; if (!l) return false;
        const cw = renderer.domElement.clientWidth || mount.clientWidth;
        const ch = renderer.domElement.clientHeight || mount.clientHeight;
        if (!cw || !ch) return false;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        renderer.getSize(_sz);
        if (Math.round(_sz.x) === cw && Math.round(_sz.y) === ch && renderer.getPixelRatio() === dpr) return false;
        renderer.setPixelRatio(dpr);
        renderer.setSize(cw, ch, false);              // buffer only — CSS stays 100%
        camera.aspect = cw / ch;
        camera.updateProjectionMatrix();
        if (!l.drag && !l.tween) {
          const pose = poseFor(stateRef.current.mode, l.scene3d.center, l.scene3d.radius, camera.aspect);
          placeCamera(l, pose, stateRef.current.mode);
        }
        return true;
      };

      // Report the selected piece's on-screen box (centre-x, bottom-y in CSS px)
      // so the parent can float a control beneath it. Only in 2D, not mid-drag,
      // and only when it actually moves — so it never churns React every frame.
      const _selBox = new THREE.Box3(); const _v = new THREE.Vector3();
      let _lastSel = { uid: undefined, x: -1, y: -1 };
      const reportSelPos = () => {
        const cb = stateRef.current.onSelectedScreenPos; if (!cb) return;
        const l = api.current; if (!l) return;
        const uid = stateRef.current.selectedUid;
        const cw = renderer.domElement.clientWidth, ch = renderer.domElement.clientHeight;
        let pos = null;
        if (uid != null && l.group && stateRef.current.mode === '2d' && !l.tween && !l.drag) {
          const pg = l.group.children.find((g) => g.userData.uid === uid);
          if (pg) {
            _selBox.setFromObject(pg);
            let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (let xi = 0; xi < 2; xi++) for (let yi = 0; yi < 2; yi++) for (let zi = 0; zi < 2; zi++) {
              _v.set(xi ? _selBox.max.x : _selBox.min.x, yi ? _selBox.max.y : _selBox.min.y, zi ? _selBox.max.z : _selBox.min.z).project(camera);
              const sx = (_v.x * 0.5 + 0.5) * cw, sy = (-_v.y * 0.5 + 0.5) * ch;
              if (sx < minX) minX = sx; if (sx > maxX) maxX = sx; if (sy > maxY) maxY = sy;
            }
            pos = { x: (minX + maxX) / 2, y: maxY };
          }
        }
        const px = pos ? Math.round(pos.x) : -1, py = pos ? Math.round(pos.y) : -1;
        if (_lastSel.uid !== uid || Math.abs(_lastSel.x - px) > 1 || Math.abs(_lastSel.y - py) > 1) {
          _lastSel = { uid, x: px, y: py };
          cb(pos ? { x: px, y: py } : null);
        }
      };

      // Report the whole layout's footprint as a screen-space rect (2D only) so
      // the parent can draw on-plan dimension lines around it.
      let _lastB = '';
      const reportPlanBounds = () => {
        const cb = stateRef.current.onPlanBounds; if (!cb) return;
        const l = api.current; if (!l) return;
        const bb = l.scene3d?.bounds;
        const cw = renderer.domElement.clientWidth, ch = renderer.domElement.clientHeight;
        let rect = null;
        if (bb && stateRef.current.mode === '2d' && !l.tween && !l.drag) {
          let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
          for (const x of [bb.minX, bb.maxX]) for (const z of [bb.minZ, bb.maxZ]) {
            _v.set(x, 0, z).project(camera);
            const sx = (_v.x * 0.5 + 0.5) * cw, sy = (-_v.y * 0.5 + 0.5) * ch;
            if (sx < minX) minX = sx; if (sx > maxX) maxX = sx; if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
          }
          rect = { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) };
        }
        const key = rect ? `${rect.x},${rect.y},${rect.w},${rect.h}` : '';
        if (key !== _lastB) { _lastB = key; cb(rect); }
      };

      const renderNow = () => { syncSize(); renderer.render(scene, camera); reportSelPos(); reportPlanBounds(); };
      let scheduled = false;
      const requestRender = () => { if (scheduled || !alive) return; scheduled = true; raf = requestAnimationFrame(() => { scheduled = false; if (alive) renderNow(); }); };
      controls.addEventListener('change', requestRender);

      const disposeStage = setupTogoStage(deps, renderer, scene, 320);
      const quilt = makeQuiltNormalMap(THREE); if (quilt) quilt.repeat.set(5, 5);

      api.current = {
        THREE, deps, renderer, scene, camera, controls, disposeStage, quilt,
        group: null, scene3d: { pieces: [], center: { x: PLAN_W / 2, z: PLAN_H / 2 }, radius: 170 },
        framedCount: -1, colorCache: new Map(), modelCache: new Map(), contourCache: new Map(), requestRender,
        raycaster: new THREE.Raycaster(), floor: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        drag: null, tween: null,
      };

      await rebuild();
      if (!alive) return;
      // Place the camera at the current mode's pose immediately (no intro tween on
      // first paint — the toggle tweens thereafter).
      const l = api.current;
      const pose = poseFor(stateRef.current.mode, l.scene3d.center, l.scene3d.radius, camera.aspect);
      placeCamera(l, pose, stateRef.current.mode);
      requestRender();

      // ── Pointer editing (2D only): tap = select, drag = move on the floor. ──
      const ndc = new THREE.Vector2();
      const hit = new THREE.Vector3();
      const setNdc = (e) => { const r = mount.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); };
      const floorHit = () => { l.raycaster.setFromCamera(ndc, camera); return l.raycaster.ray.intersectPlane(l.floor, hit) ? hit.clone() : null; };
      const pieceUidAt = () => {
        l.raycaster.setFromCamera(ndc, camera);
        const hits = l.raycaster.intersectObjects(l.group ? l.group.children : [], true);
        for (const it of hits) { let o = it.object; while (o) { if (o.userData?.uid != null) return o.userData.uid; o = o.parent; } }
        return null;
      };
      const onDown = (e) => {
        if (stateRef.current.mode !== '2d') return;       // 3D → orbit owns the pointer
        setNdc(e);
        const uid = pieceUidAt();
        stateRef.current.onSelect?.(uid);
        if (uid == null) return;
        const pg = l.group.children.find((g) => g.userData.uid === uid);
        const fp = floorHit();
        if (!pg || !fp) return;
        l.drag = { uid, offX: fp.x - pg.position.x, offZ: fp.z - pg.position.z, pg, moved: false };
        controls.enabled = false;
        try { renderer.domElement.setPointerCapture?.(e.pointerId); } catch { /* iOS can refuse — moves still arrive on the element */ }
        e.preventDefault();
      };
      const onMovePtr = (e) => {
        if (!l.drag) return;
        setNdc(e);
        const fp = floorHit(); if (!fp) return;
        const { placed: pl, resolvedById: byId } = stateRef.current;
        const me = pl.find((p) => p.uid === l.drag.uid); if (!me) return;
        const r = resolvePlacement(me, byId);
        const box = footprintOf({ widthCm: Number(r.widthCm) || 0, depthCm: Number(r.depthCm) || 0 }, norm360(me.rot));
        const cx = fp.x - l.drag.offX, cz = fp.z - l.drag.offZ;        // new piece CENTRE
        const others = pl.filter((p) => p.uid !== l.drag.uid).map((p) => {
          const rr = resolvePlacement(p, byId);
          const f = footprintOf({ widthCm: Number(rr.widthCm) || 0, depthCm: Number(rr.depthCm) || 0 }, norm360(p.rot));
          return { x: p.x, y: p.y, w: f.w, h: f.h };
        });
        const snapped = snapPlacement({ x: cx - box.w / 2, y: cz - box.h / 2, w: box.w, h: box.h }, others);
        const c = clampToPlan(snapped.x, snapped.y, box.w, box.h);
        l.drag.pg.position.set(c.x + box.w / 2, 0, c.y + box.h / 2);   // live preview
        l.drag.next = { x: c.x, y: c.y };
        l.drag.moved = true;
        requestRender();
      };
      const onUp = (e) => {
        if (!l.drag) return;
        const d = l.drag; l.drag = null;
        controls.enabled = stateRef.current.mode === '3d';   // stays off in 2D
        renderer.domElement.releasePointerCapture?.(e.pointerId);
        if (d.moved && d.next) stateRef.current.onMove?.(d.uid, d.next.x, d.next.y);
      };
      renderer.domElement.addEventListener('pointerdown', onDown);
      renderer.domElement.addEventListener('pointermove', onMovePtr);
      window.addEventListener('pointerup', onUp);
      l.cleanupPointer = () => {
        renderer.domElement.removeEventListener('pointerdown', onDown);
        renderer.domElement.removeEventListener('pointermove', onMovePtr);
        window.removeEventListener('pointerup', onUp);
      };

      // Every signal that the displayed size MIGHT have changed just asks for a
      // render; renderNow → syncSize does the actual reconcile + recentre. We
      // listen broadly (ResizeObserver on the container, window resize/orientation,
      // and the iOS visualViewport which fires when the URL bar shows/hides) so no
      // device-specific quirk can leave the canvas stale.
      ro = new ResizeObserver(() => requestRender());
      ro.observe(mount);
      const onWin = () => requestRender();
      window.addEventListener('resize', onWin);
      window.addEventListener('orientationchange', onWin);
      window.visualViewport?.addEventListener('resize', onWin);
      window.visualViewport?.addEventListener('scroll', onWin);
      l_cleanupResize = () => {
        window.removeEventListener('resize', onWin);
        window.removeEventListener('orientationchange', onWin);
        window.visualViewport?.removeEventListener('resize', onWin);
        window.visualViewport?.removeEventListener('scroll', onWin);
      };
    })();

    return () => {
      alive = false; cancelAnimationFrame(raf); ro?.disconnect(); l_cleanupResize?.();
      const l = api.current; api.current = null;
      if (l) {
        l.cleanupPointer?.();
        if (l.tween) cancelAnimationFrame(l.tween);
        l.controls?.dispose?.();
        disposeGroup(l.group);
        l.disposeStage?.();
        l.quilt?.dispose?.();
        // colorCache holds plain hex numbers (sampleSwatchColor) — nothing to
        // dispose; just drop the reference with the rest of `l`.
        l.modelCache?.forEach?.((m) => disposeGroup(m.object || m));
        l.renderer?.dispose?.();
        l.renderer?.domElement?.remove?.();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Layout/selection change → rebuild; finish change → re-skin in place.
  useEffect(() => { if (api.current) rebuild(); }, [placed, resolvedById, rebuild]);
  useEffect(() => { if (api.current) applyHighlightLive(); /* eslint-disable-next-line */ }, [selectedUid]);
  useEffect(() => { if (api.current) reskin(); }, [material, reskin]);

  function applyHighlightLive() { const l = api.current; if (l) applyHighlight(l, stateRef.current.selectedUid); }

  // Mode change → tween the camera between the top-down and perspective poses, and
  // flip orbit-rotate (locked top-down in 2D, free orbit in 3D).
  useEffect(() => {
    const l = api.current; if (!l) return;
    setContourMode(l, mode);              // contours show in 2D, hide in 3D
    const { camera, controls } = l;
    const to = poseFor(mode, l.scene3d.center, l.scene3d.radius, camera.aspect);
    const from = { px: camera.position.x, py: camera.position.y, pz: camera.position.z, tx: controls.target.x, ty: controls.target.y, tz: controls.target.z };
    // Tween the camera UP too: top-down plan up=(0,0,-1) ↔ perspective up=(0,1,0),
    // so the basis rotates smoothly with the move instead of popping at the ends.
    const uFrom = { x: camera.up.x, y: camera.up.y, z: camera.up.z };
    const uTo = mode === '2d' ? { x: 0, y: 0, z: -1 } : { x: 0, y: 1, z: 0 };
    controls.enabled = false;             // we drive the camera by hand mid-tween
    if (l.tween) cancelAnimationFrame(l.tween);
    let t0 = null; const dur = 700;
    const step = (ts) => {
      if (!api.current) return;
      if (t0 == null) t0 = ts;
      const p = Math.min(1, (ts - t0) / dur);
      const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;   // easeInOutQuad
      camera.position.set(from.px + (to.px - from.px) * e, from.py + (to.py - from.py) * e, from.pz + (to.pz - from.pz) * e);
      const ux = uFrom.x + (uTo.x - uFrom.x) * e, uy = uFrom.y + (uTo.y - uFrom.y) * e, uz = uFrom.z + (uTo.z - uFrom.z) * e;
      const ul = Math.hypot(ux, uy, uz) || 1;
      camera.up.set(ux / ul, uy / ul, uz / ul);
      const tx = from.tx + (to.tx - from.tx) * e, ty = from.ty + (to.ty - from.ty) * e, tz = from.tz + (to.tz - from.tz) * e;
      controls.target.set(tx, ty, tz);
      camera.lookAt(tx, ty, tz);
      l.renderer.render(l.scene, camera);
      if (p < 1) { l.tween = requestAnimationFrame(step); }
      else { l.tween = null; placeCamera(l, to, mode); l.requestRender(); }   // snap to the exact end pose + restore controls
    };
    l.tween = requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    // position via INLINE STYLE, not classes: the caller passes `absolute inset-0`
    // but the root ALSO carried a hardcoded `relative`, and in the built CSS
    // `.relative` is emitted after `.absolute` so it WON the tie — the root became
    // `position: relative`, which ignores inset-0 for sizing and collapsed to auto
    // height (its only children are absolutely-positioned → contribute 0). The
    // canvas then never got a viewport-tracking height and the ResizeObserver read
    // H≈0 and bailed, so the stage couldn't respond to screen size. Forcing
    // absolute+inset:0 inline makes the root fill its parent regardless of class
    // order, and it's still a positioning context for the mount/overlay below.
    <div style={{ position: 'absolute', inset: 0 }} className={className} aria-label="Configurador Togo">
      <div ref={mountRef} className="absolute inset-0" />
      {failed && (
        <div className="absolute inset-0 grid place-items-center text-center px-6 text-xs text-ink-500">
          La vista 3D no está disponible en este dispositivo.
        </div>
      )}
    </div>
  );
}
