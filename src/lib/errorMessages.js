/**
 * Convert technical errors (Supabase / fetch / generic) into a single Spanish
 * sentence the user can act on. Falls back to the original message when we
 * can't classify, so we never hide diagnostic information — we just put a
 * friendlier label on top of it for the common cases.
 */

export function userMessageFor(err) {
  if (!err) return 'Error desconocido.';
  const code = err.code || err.status || '';
  const raw = (err.message || String(err)).toLowerCase();

  // Network / offline
  if (raw.includes('failed to fetch') || raw.includes('networkerror') || raw.includes('load failed')) {
    return 'Sin conexión con el servidor. Revisa tu internet y vuelve a intentar.';
  }
  if (code === 'PGRST301' || raw.includes('jwt') || raw.includes('expired')) {
    return 'La sesión expiró. Recarga la página para volver a iniciar sesión.';
  }
  if (raw.includes('row-level security') || raw.includes('permission denied') || code === '42501') {
    return 'No tienes permiso para esta acción.';
  }
  if (raw.includes('duplicate key') || raw.includes('unique constraint') || code === '23505') {
    return 'Ya existe un registro con esos datos.';
  }
  if (raw.includes('foreign key') || code === '23503') {
    return 'Hay datos relacionados que impiden esta operación.';
  }
  if (raw.includes('payload too large') || code === 413) {
    return 'El archivo es demasiado grande.';
  }
  if (raw.includes('429') || raw.includes('too many requests')) {
    return 'Demasiadas solicitudes. Espera unos segundos y vuelve a intentar.';
  }
  if (raw.includes('502') || raw.includes('503') || raw.includes('504')) {
    return 'El servidor no responde. Vuelve a intentar en un momento.';
  }
  return err.message || String(err);
}
