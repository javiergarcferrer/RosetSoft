-- Track OUR commercial approval/rejection (ACECF) of a received supplier e-CF,
-- sent from the Comprobantes-recibidos inbox. Lets the inbox show what we've
-- already actioned and avoid a double-send. Additive + idempotent.

alter table public.ecf_received
  add column if not exists commercial_estado text,   -- '1' aprobado, '2' rechazado
  add column if not exists commercial_at timestamptz,
  add column if not exists commercial_motivo text;

notify pgrst, 'reload schema';
