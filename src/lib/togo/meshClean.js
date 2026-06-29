/**
 * Strip baked-in LABEL geometry from a loaded mesh, in place. Some dealer FBX
 * exports carry a flat text label (e.g. "Togo_pb") sitting next to the furniture;
 * it pollutes the top-down silhouette AND inflates the measured footprint, which
 * is exactly the "text + white space below the model" artifact. We can't edit the
 * uploaded file, so we drop the label meshes after load — then the plan, the tile
 * render and the 3D view all show only the furniture.
 *
 * `three` is injected (the caller already loaded it). CONSERVATIVE by design: it
 * only acts when the object has ≥2 meshes and only removes the genuinely FLAT ones
 * (a real Togo body is never a flat plane — it's puffy in every axis), so a
 * single merged mesh or normal furniture parts are never touched. Idempotent.
 *
 * @returns the number of label meshes removed.
 */
export function stripLabelMeshes(THREE, object) {
  if (!THREE || !object) return 0;
  object.updateMatrixWorld(true);
  const meshes = [];
  object.traverse((o) => { if (o.isMesh && o.geometry?.attributes?.position) meshes.push(o); });
  if (meshes.length < 2) return 0;   // one merged mesh → can't separate text safely

  const info = meshes.map((m) => {
    const s = new THREE.Box3().setFromObject(m).getSize(new THREE.Vector3());
    return { m, max: Math.max(s.x, s.y, s.z), min: Math.min(s.x, s.y, s.z) };
  });
  const furnitureMax = Math.max(...info.map((i) => i.max));
  if (!(furnitureMax > 0)) return 0;

  // A label is a flat plane: its thinnest dimension is a hair of the furniture's
  // largest. The sofa body, even a low Togo, is thick in every axis (≳ 30%).
  const labels = info.filter((i) => i.min < furnitureMax * 0.06);
  if (!labels.length || labels.length >= meshes.length) return 0;  // never strip all

  for (const { m } of labels) {
    m.parent?.remove(m);
    m.geometry?.dispose?.();
  }
  return labels.length;
}
