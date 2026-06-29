import { useCallback, useEffect, useRef, useState } from 'react';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { swatchProxyUrl, swatchUrl } from '../../lib/swatchImage.js';
import { inferTogoForm } from '../../lib/togo/togoModel.js';
import { footprintOf, snapPlacement, clampToPlan, resolvePlacement } from '../../core/quote/index.js';
import { loadTogoModels } from './togoModelLoader.js';
import { buildTogoGroup, setupTogoStage, disposeGroup, makeQuiltNormalMap, sampleSwatchColor } from './togoSceneBuilder.js';

const DEFAULT_FINISH = { sheen: 0.7, sheenRoughness: 0.6, roughness: 0.85, repeat: 3, normalScale: 0.45 };
const norm360 = (d) => (((d % 360) + 360) % 360);
const PLAN_W = 760, PLAN_H = 540;

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
  onSelect, onMove, className = '',
}) {
  const mountRef = useRef(null);
  const api = useRef(null);
  const [failed, setFailed] = useState(false);

  // Latest props the imperative three loop reads without re-subscribing.
  const stateRef = useRef({ placed, resolvedById, mode, material, selectedUid, onSelect, onMove });
  stateRef.current = { placed, resolvedById, mode, material, selectedUid, onSelect, onMove };

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
      radius: has ? Math.max(110, Math.hypot(maxX - minX, maxZ - minZ) / 2) : 170,
    };
  }, []);

  // The camera pose for a mode, around the layout centre.
  const poseFor = useCallback((m, center, radius) => (
    m === '2d'
      // Straight-down (the +0.001 z-offset avoids the look-straight-down gimbal),
      // high enough that the whole layout fits with margin on any aspect.
      ? { px: center.x, py: radius * 3.8, pz: center.z + 0.001, tx: center.x, ty: 0, tz: center.z }
      : { px: center.x + radius * 0.85, py: radius * 1.15, pz: center.z + radius * 2.0, tx: center.x, ty: radius * 0.12, tz: center.z }
  ), []);

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
    // Tag every object with its piece uid (raycast → selection/drag).
    group.children.forEach((pg, i) => {
      const uid = scene.pieces[i]?.uid;
      pg.userData.uid = uid;
      pg.traverse((o) => { o.userData.uid = uid; });
    });
    l.group = group;
    l.scene.add(group);
    applyHighlight(l, sel);
    // Frame the camera on the layout when the piece COUNT changes (add/remove) —
    // so a new piece is always in view — but NOT on a position-only change (a drag
    // commit), and never mid-drag, so arranging stays stable.
    if (scene.pieces.length !== l.framedCount && !l.drag) {
      l.framedCount = scene.pieces.length;
      const pose = poseFor(stateRef.current.mode, scene.center, scene.radius);
      l.camera.position.set(pose.px, pose.py, pose.pz);
      l.controls.target.set(pose.tx, pose.ty, pose.tz);
      l.controls.update();
    }
    l.requestRender();
  }, [buildScene, poseFor]);

  // Subtle warm emissive on the selected piece (reads in both camera modes).
  function applyHighlight(l, sel) {
    if (!l?.group) return;
    const seen = new Set();
    l.group.children.forEach((pg) => {
      const on = sel != null && pg.userData.uid === sel;
      pg.traverse((o) => {
        const m = o.material; if (!m || !m.emissive || seen.has(m)) return; seen.add(m);
        m.emissive.setHex(on ? 0x3a342b : 0x000000);
        m.emissiveIntensity = on ? 0.5 : 0;
      });
    });
    l.requestRender();
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
    let alive = true; let ro = null; let raf = 0;
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
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.domElement.style.cssText = 'display:block;outline:none;touch-action:none';
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(33, w / h, 1, 20000);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.enablePan = false;
      controls.maxPolarAngle = Math.PI * 0.495;

      const renderNow = () => { renderer.render(scene, camera); };
      let scheduled = false;
      const requestRender = () => { if (scheduled || !alive) return; scheduled = true; raf = requestAnimationFrame(() => { scheduled = false; if (alive) renderNow(); }); };
      controls.addEventListener('change', requestRender);

      const disposeStage = setupTogoStage(deps, renderer, scene, 320);
      const quilt = makeQuiltNormalMap(THREE); if (quilt) quilt.repeat.set(5, 5);

      api.current = {
        THREE, deps, renderer, scene, camera, controls, disposeStage, quilt,
        group: null, scene3d: { pieces: [], center: { x: PLAN_W / 2, z: PLAN_H / 2 }, radius: 170 },
        framedCount: -1, colorCache: new Map(), modelCache: new Map(), requestRender,
        raycaster: new THREE.Raycaster(), floor: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
        drag: null, tween: null,
      };

      await rebuild();
      if (!alive) return;
      // Place the camera at the current mode's pose immediately (no intro tween on
      // first paint — the toggle tweens thereafter).
      const l = api.current;
      const pose = poseFor(stateRef.current.mode, l.scene3d.center, l.scene3d.radius);
      camera.position.set(pose.px, pose.py, pose.pz);
      controls.target.set(pose.tx, pose.ty, pose.tz);
      controls.enableRotate = stateRef.current.mode === '3d';
      controls.update();
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
        renderer.domElement.setPointerCapture?.(e.pointerId);
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
        controls.enabled = true;
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

      ro = new ResizeObserver(() => { const W = mount.clientWidth, H = mount.clientHeight; if (W && H) { renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix(); requestRender(); } });
      ro.observe(mount);
    })();

    return () => {
      alive = false; cancelAnimationFrame(raf); ro?.disconnect();
      const l = api.current; api.current = null;
      if (l) {
        l.cleanupPointer?.();
        if (l.tween) cancelAnimationFrame(l.tween);
        l.controls?.dispose?.();
        disposeGroup(l.group);
        l.disposeStage?.();
        l.quilt?.dispose?.();
        l.colorCache?.forEach?.(() => {});
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
    const { camera, controls } = l;
    const to = poseFor(mode, l.scene3d.center, l.scene3d.radius);
    const from = { px: camera.position.x, py: camera.position.y, pz: camera.position.z, tx: controls.target.x, ty: controls.target.y, tz: controls.target.z };
    controls.enableRotate = false;        // lock during the tween
    if (l.tween) cancelAnimationFrame(l.tween);
    let t0 = null; const dur = 700;
    const step = (ts) => {
      if (!api.current) return;
      if (t0 == null) t0 = ts;
      const p = Math.min(1, (ts - t0) / dur);
      const e = p < 0.5 ? 2 * p * p : 1 - ((-2 * p + 2) ** 2) / 2;   // easeInOutQuad
      camera.position.set(from.px + (to.px - from.px) * e, from.py + (to.py - from.py) * e, from.pz + (to.pz - from.pz) * e);
      controls.target.set(from.tx + (to.tx - from.tx) * e, from.ty + (to.ty - from.ty) * e, from.tz + (to.tz - from.tz) * e);
      controls.update();
      l.renderer.render(l.scene, camera);
      if (p < 1) { l.tween = requestAnimationFrame(step); }
      else { l.tween = null; controls.enableRotate = mode === '3d'; }
    };
    l.tween = requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  return (
    <div className={`relative ${className}`} aria-label="Configurador Togo">
      <div ref={mountRef} className="absolute inset-0" />
      {failed && (
        <div className="absolute inset-0 grid place-items-center text-center px-6 text-xs text-ink-500">
          La vista 3D no está disponible en este dispositivo.
        </div>
      )}
    </div>
  );
}
