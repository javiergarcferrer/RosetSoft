import { useCallback, useEffect, useRef, useState } from 'react';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { swatchProxyUrl, swatchUrl } from '../../lib/swatchImage.js';
import { glbForPiece } from '../../assets/togo/togoModels3d.js';
import { buildTogoGroup, setupTogoStage, sceneRadius, disposeGroup, makeQuiltNormalMap, sampleSwatchColor } from './togoSceneBuilder.js';

// Pick the three.js loader for a model URL by extension, loaded on demand (so a
// scene with no real models pulls in no loader at all). pCon exports OBJ/FBX/
// 3DS/DAE; GLB/glTF for anything authored web-side.
const extOf = (url) => String(url || '').split('?')[0].split('.').pop().toLowerCase();
async function loaderFor(ext) {
  switch (ext) {
    case 'glb': case 'gltf': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/GLTFLoader.js')); return new m.GLTFLoader(); }
    case 'obj': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/OBJLoader.js')); return new m.OBJLoader(); }
    case 'fbx': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/FBXLoader.js')); return new m.FBXLoader(); }
    case 'dae': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/ColladaLoader.js')); return new m.ColladaLoader(); }
    case '3ds': { const m = await safeDynamicImport(() => import('three/examples/jsm/loaders/TDSLoader.js')); return new m.TDSLoader(); }
    default: return null;
  }
}
// glTF/Collada return a wrapper with `.scene`; OBJ/FBX/3DS return the Object3D.
const normalizeLoaded = (ext, res) => ((ext === 'glb' || ext === 'gltf' || ext === 'dae') ? (res.scene || res.scenes?.[0] || res) : res);

// The default fabric finish (the material editor overrides these live).
const DEFAULT_FINISH = { sheen: 0.6, sheenRoughness: 0.55, roughness: 0.82, repeat: 3, normalScale: 0.45 };

/**
 * The Togo 3D visualizer — a real-time three.js view of the SAME placed layout
 * the 2D plan edits, each piece upholstered in its chosen fabric + finish. High
 * fidelity (physically-based fabric with a SHEEN lobe, a procedural quilt normal
 * map for the iconic channels, image-based studio lighting + a soft contact
 * shadow) yet low-latency: three.js loads only when this mounts (code-split via
 * safeDynamicImport, no HDR asset — the lighting is the built-in RoomEnvironment)
 * and the scene renders ON DEMAND (only on interaction, an edit, or a material
 * change — zero idle GPU).
 *
 * Props:
 *   • `scene3d`   — a `resolveTogoScene` projection (the layout + per-piece fabric)
 *   • `material`  — the live finish from the material editor (sheen/roughness/
 *                   tint/weave scale); re-skins every piece instantly
 *   • `autoRotate`— a gentle intro turntable that stops on first interaction
 *
 * Geometry is procedural (sized to the real footprints); a real Togo mesh
 * (pCon/OFML export → GLB/OBJ/FBX) drops in per kind via the manifest with the
 * material + layout wiring unchanged.
 */
export default function TogoScene3D({ scene3d, material, autoRotate = true, className = '' }) {
  const mountRef = useRef(null);
  const api = useRef(null);          // three objects, kept across renders
  const [failed, setFailed] = useState(false);  // WebGL/three unavailable → fallback
  const sceneRef = useRef(scene3d);
  sceneRef.current = scene3d;
  const finishRef = useRef(material);
  finishRef.current = material;

  const rebuild = useCallback(async () => {
    const l = api.current;
    if (!l) return;
    const sd = sceneRef.current || { pieces: [], overallCm: { widthCm: 0, depthCm: 0 } };
    // Preload the distinct fabric swatches as textures (CORS via swatch-proxy)…
    const codes = [...new Set((sd.pieces || []).map((p) => p.fabricCode).filter(Boolean))];
    // …and any REAL Togo models for the pieces in play (none → procedural). A
    // dealer-uploaded mesh (piece.mesh, from Storage) wins over the static
    // manifest; deduped by URL so two pieces sharing a model load it once.
    const descFor = (p) => ((p.mesh && p.mesh.url) ? p.mesh : glbForPiece(p));
    const descByUrl = new Map();
    for (const p of (sd.pieces || [])) { const d = descFor(p); if (d?.url) descByUrl.set(d.url, d); }
    await Promise.all([
      ...codes.map(async (code) => {
        if (l.texCache.has(code)) return;
        const url = swatchProxyUrl(code) || swatchUrl(code);
        if (!url) return;
        try {
          const tex = await new l.THREE.TextureLoader().loadAsync(url);
          l.texCache.set(code, tex);
          // Sample the swatch's dominant colour once — the material upholsters
          // with this (a true, saturated velvet colour), not the folded photo.
          const c = sampleSwatchColor(tex.image);
          if (c != null) l.colorCache.set(code, c);
        } catch { /* 404 / CORS-tainted → default colour */ }
      }),
      ...[...descByUrl.values()].map(async (desc) => {
        if (l.modelCache.has(desc.url)) return;
        const ext = extOf(desc.url);
        try {
          const loader = await loaderFor(ext);
          if (!loader) return;
          const object = normalizeLoaded(ext, await loader.loadAsync(desc.url));
          if (object) l.modelCache.set(desc.url, { object, desc });
        } catch { /* missing/unreadable → procedural */ }
      }),
    ]);
    if (!api.current) return; // unmounted while awaiting
    if (l.group) { l.scene.remove(l.group); disposeGroup(l.group); }
    l.group = buildTogoGroup(l.deps, sd, {
      ...DEFAULT_FINISH,
      ...(finishRef.current || {}),
      normalMap: l.quilt,
      colorFor: (c) => (l.colorCache.has(c) ? l.colorCache.get(c) : null),
      modelFor: (piece) => { const d = descFor(piece); return d ? (l.modelCache.get(d.url) || null) : null; },
    });
    l.scene.add(l.group);
    // Frame the camera once the first pieces appear; keep the viewpoint after.
    const r = sceneRadius(sd);
    l.controls.minDistance = r * 0.4;
    l.controls.maxDistance = r * 9;
    if (!l.framed && (sd.pieces || []).length) {
      l.camera.position.set(r * 0.7, r * 0.5, r * 1.45);
      l.controls.target.set(0, 18, 0);
      l.framed = true;                            // controls.update() derives the orientation
    }
    l.controls.update();
    l.requestRender();
  }, []);

  // Re-skin in place on a finish change — update the material scalars + texture
  // scale on the EXISTING meshes (no geometry rebuild), so the material editor
  // is instant and the weave slider rescales both the swatch and the quilt.
  const reskin = useCallback(() => {
    const l = api.current;
    if (!l || !l.group) return;
    const f = { ...DEFAULT_FINISH, ...(finishRef.current || {}) };
    const rep = f.repeat || 3;
    const seen = new Set();
    l.group.traverse((o) => {
      const m = o.material;
      if (!m || seen.has(m)) return;
      seen.add(m);
      if ('roughness' in m) m.roughness = f.roughness;
      if ('sheen' in m) m.sheen = f.sheen;
      if ('sheenRoughness' in m) m.sheenRoughness = f.sheenRoughness;
      if ('clearcoat' in m) m.clearcoat = f.clearcoat ?? 0;
      if ('clearcoatRoughness' in m) m.clearcoatRoughness = f.clearcoatRoughness ?? 0.4;
      if (m.normalScale) m.normalScale.set(f.normalScale, f.normalScale);
      if (m.map) m.map.repeat.set(rep, rep);
    });
    l.requestRender();
  }, []);

  // Mount once: load three, build renderer/scene/camera/controls/stage.
  useEffect(() => {
    let alive = true; let ro = null;
    let autoRaf = 0, pendingRaf = 0, autoTimer = 0;  // hoisted so cleanup can cancel them
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
      const mount = mountRef.current;
      if (!alive || !mount) return;
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
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 0.92;
      renderer.domElement.style.display = 'block';
      renderer.domElement.style.outline = 'none';
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(33, w / h, 1, 12000);
      camera.position.set(300, 240, 520);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;     // on-demand rendering: no idle loop needed
      controls.enablePan = false;
      controls.maxPolarAngle = Math.PI * 0.49; // never dip under the floor
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 0.7;
      controls.target.set(0, 18, 0);

      // On-demand rendering — render only when something changes (interaction,
      // edit, material). A single scheduled frame coalesces bursts of events.
      const renderNow = () => { controls.update(); renderer.render(scene, camera); };
      let scheduled = false;
      const requestRender = () => {
        if (scheduled || !alive) return;
        scheduled = true;
        pendingRaf = requestAnimationFrame(() => { scheduled = false; if (alive) renderNow(); });
      };
      controls.addEventListener('change', requestRender);

      // Gentle intro turntable; the ONLY continuous render. It stops on the first
      // interaction OR after a few seconds — a BOUNDED intro, never an idle GPU
      // spin — after which we're fully on-demand.
      const autoLoop = () => {
        if (!alive || !controls.autoRotate) { autoRaf = 0; return; }
        controls.update(); renderer.render(scene, camera);
        autoRaf = requestAnimationFrame(autoLoop);
      };
      const stopAuto = () => { controls.autoRotate = false; clearTimeout(autoTimer); autoTimer = 0; };
      renderer.domElement.addEventListener('pointerdown', stopAuto, { once: true });

      const disposeStage = setupTogoStage(deps, renderer, scene, 300);
      const quilt = makeQuiltNormalMap(THREE);     // fine fabric grain (channels are geometry)
      if (quilt) quilt.repeat.set(5, 5);
      api.current = {
        THREE, deps, renderer, scene, camera, controls, disposeStage, stopAuto, quilt,
        group: null, texCache: new Map(), colorCache: new Map(), modelCache: new Map(), framed: false,
        requestRender,
      };

      await rebuild();
      if (!alive) return;
      if (controls.autoRotate) { autoLoop(); autoTimer = setTimeout(stopAuto, 9000); } else requestRender();

      ro = new ResizeObserver(() => {
        const W = mount.clientWidth, H = mount.clientHeight;
        if (W && H) { renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix(); requestRender(); }
      });
      ro.observe(mount);
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(autoRaf);
      cancelAnimationFrame(pendingRaf);
      clearTimeout(autoTimer);
      ro?.disconnect();
      const l = api.current;
      api.current = null;
      if (l) {
        l.renderer?.domElement?.removeEventListener?.('pointerdown', l.stopAuto);
        l.controls?.dispose?.();
        disposeGroup(l.group);
        l.disposeStage?.();
        l.quilt?.dispose?.();
        l.texCache?.forEach((t) => t.dispose());
        l.modelCache?.forEach((m) => disposeGroup(m.object || m));
        l.renderer?.dispose?.();
        l.renderer?.domElement?.remove?.();
      }
    };
  }, [autoRotate, rebuild]);

  // Layout/fabric change → rebuild geometry; finish change → re-skin in place
  // (no geometry churn, so the material editor stays instant).
  useEffect(() => { if (api.current) rebuild(); }, [scene3d, rebuild]);
  useEffect(() => { if (api.current) reskin(); }, [material, reskin]);

  return (
    <div className={`relative ${className}`} aria-label="Vista 3D de la configuración Togo">
      <div ref={mountRef} className="absolute inset-0" />
      {failed && (
        <div className="absolute inset-0 grid place-items-center text-center px-6 text-xs text-ink-500">
          La vista 3D no está disponible en este dispositivo. Usa la vista 2D para diseñar tu sofá.
        </div>
      )}
    </div>
  );
}
