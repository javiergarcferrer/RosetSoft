import { useCallback, useEffect, useRef } from 'react';
import { safeDynamicImport } from '../../lib/dynamicImport.js';
import { swatchProxyUrl, swatchUrl } from '../../lib/swatchImage.js';
import { buildTogoGroup, setupTogoStage, sceneRadius, disposeGroup } from './togoSceneBuilder.js';

/**
 * The Togo 3D preview — a real-time three.js view of the SAME placed layout the
 * 2D plan edits, with each piece upholstered in its chosen fabric (the swatch
 * image, read through `swatch-proxy` so WebGL can use it cross-origin). three.js
 * + its addons load ONLY when this mounts (via safeDynamicImport — the engine is
 * fully code-split and never weighs on the initial widget), and the scene is
 * lit by a built-in RoomEnvironment (no HDR asset to ship).
 *
 * Props: `scene3d` (a `resolveTogoScene` projection). Re-renders the furniture
 * group when it changes; the renderer/camera/orbit/lighting persist so the
 * user's viewpoint survives an edit. Geometry is procedural for now (sized to the
 * real footprints); when the dealer's pCon/OFML Togo GLBs land, the per-piece
 * build swaps to a glTF load with the rest of the wiring unchanged.
 */
export default function TogoScene3D({ scene3d, autoRotate = true, className = '' }) {
  const mountRef = useRef(null);
  const api = useRef(null);      // three objects, kept across renders
  const sceneRef = useRef(scene3d);
  sceneRef.current = scene3d;

  const rebuild = useCallback(async () => {
    const l = api.current;
    if (!l) return;
    const sd = sceneRef.current || { pieces: [], overallCm: { widthCm: 0, depthCm: 0 } };
    // Preload the distinct fabric swatches as textures (CORS via swatch-proxy).
    const codes = [...new Set((sd.pieces || []).map((p) => p.fabricCode).filter(Boolean))];
    await Promise.all(codes.map(async (code) => {
      if (l.texCache.has(code)) return;
      const url = swatchProxyUrl(code) || swatchUrl(code);
      if (!url) return;
      try { l.texCache.set(code, await new l.THREE.TextureLoader().loadAsync(url)); } catch { /* 404 → default colour */ }
    }));
    if (!api.current) return; // unmounted while awaiting
    if (l.group) { l.scene.remove(l.group); disposeGroup(l.group); }
    l.group = buildTogoGroup(l.deps, sd, {
      textureFor: (c) => { const t = l.texCache.get(c); return t ? t.clone() : null; },
      repeat: 3,
    });
    l.scene.add(l.group);
    // Frame the camera once the first pieces appear; keep the viewpoint after.
    const r = sceneRadius(sd);
    l.controls.minDistance = r * 0.45;
    l.controls.maxDistance = r * 8;
    if (!l.framed && (sd.pieces || []).length) {
      l.camera.position.set(r * 1.0, r * 0.95, r * 1.6);
      l.controls.target.set(0, 28, 0);
      l.camera.lookAt(0, 28, 0);
      l.controls.update();
      l.framed = true;
    }
  }, []);

  // Mount once: load three, build renderer/scene/camera/controls/stage + loop.
  useEffect(() => {
    let alive = true; let raf = 0; let ro = null;
    (async () => {
      let mods;
      try {
        mods = await Promise.all([
          safeDynamicImport(() => import('three')),
          safeDynamicImport(() => import('three/examples/jsm/controls/OrbitControls.js')),
          safeDynamicImport(() => import('three/examples/jsm/environments/RoomEnvironment.js')),
          safeDynamicImport(() => import('three/examples/jsm/geometries/RoundedBoxGeometry.js')),
        ]);
      } catch { return; }
      const mount = mountRef.current;
      if (!alive || !mount) return;
      const [THREE, { OrbitControls }, { RoomEnvironment }, { RoundedBoxGeometry }] = mods;
      const deps = { THREE, RoomEnvironment, RoundedBoxGeometry };
      const w = mount.clientWidth || 640, h = mount.clientHeight || 440;

      let renderer;
      try { renderer = new THREE.WebGLRenderer({ antialias: true }); }
      catch { return; }
      renderer.setSize(w, h);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.domElement.style.display = 'block';
      renderer.domElement.style.outline = 'none';
      mount.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, w / h, 1, 12000);
      camera.position.set(300, 300, 480);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.08;
      controls.enablePan = false;
      controls.maxPolarAngle = Math.PI * 0.49; // never dip under the floor
      controls.autoRotate = autoRotate;
      controls.autoRotateSpeed = 0.7;
      controls.target.set(0, 28, 0);
      const stopAuto = () => { controls.autoRotate = false; };
      renderer.domElement.addEventListener('pointerdown', stopAuto, { once: true });

      const disposeStage = setupTogoStage(deps, renderer, scene, 300);
      api.current = { THREE, deps, renderer, scene, camera, controls, disposeStage, stopAuto, group: null, texCache: new Map(), framed: false };

      await rebuild();
      if (!alive) return;
      const loop = () => { if (!alive) return; controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
      loop();

      ro = new ResizeObserver(() => {
        const W = mount.clientWidth, H = mount.clientHeight;
        if (W && H) { renderer.setSize(W, H); camera.aspect = W / H; camera.updateProjectionMatrix(); }
      });
      ro.observe(mount);
    })();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro?.disconnect();
      const l = api.current;
      api.current = null;
      if (l) {
        l.renderer?.domElement?.removeEventListener?.('pointerdown', l.stopAuto);
        l.controls?.dispose?.();
        disposeGroup(l.group);
        l.disposeStage?.();
        l.texCache?.forEach((t) => t.dispose());
        l.renderer?.dispose?.();
        l.renderer?.domElement?.remove?.();
      }
    };
  }, [autoRotate, rebuild]);

  // Re-render the furniture whenever the layout/fabrics change.
  useEffect(() => { if (api.current) rebuild(); }, [scene3d, rebuild]);

  return <div ref={mountRef} className={className} aria-label="Vista 3D de la configuración Togo" />;
}
