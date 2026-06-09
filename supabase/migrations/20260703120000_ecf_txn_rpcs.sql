-- Audit fixes: atomic e-NCF assignment + transactional sale posting.
--
-- 1. assign_next_encf — the client used to read ecf_sequences, format the
--    e-NCF and bump next_seq in a SECOND write: a read-modify-write race where
--    two concurrent invoices could be issued the SAME e-NCF (the unique index
--    on sales_postings(ncf) only turns the duplicate into a late failure).
--    This RPC does pick + bump in one transaction under a row lock, so a
--    number is handed out exactly once. A burned number on a downstream
--    failure stays a GAP — gaps are fiscally fine, reuse is not.
--
-- 2. post_sale — the sale used to land as three separate client writes
--    (asiento header → lines → sales_posting). A failure in between left a
--    posted asiento with no invoice, and since "por facturar" derives from
--    sales_postings, a retry DOUBLE-BOOKED the revenue. This RPC inserts all
--    three in one transaction and assigns both human numbers, retrying on a
--    number collision. Runs as the calling user (security invoker) so the
--    team RLS policies still apply; anon cannot execute either function.
--
-- sales_postings also gains the e-CF emission fields the send layer needs:
-- the sequence expiry (FechaVencimientoSecuencia goes into the payload) and
-- the signature date (fechafirma goes into the consulta-timbre QR).

alter table public.sales_postings
  add column if not exists ecf_expires_at timestamptz,
  add column if not exists fecha_firma    text default '';

create or replace function public.assign_next_encf(p_profile_id text, p_ecf_type text)
returns table (sequence_id text, e_ncf text, seq_expires_at timestamptz)
language plpgsql
set search_path = public
as $$
declare
  seq public.ecf_sequences;
begin
  select * into seq
    from public.ecf_sequences s
   where s.profile_id = coalesce(nullif(p_profile_id, ''), 'team')
     and s.ecf_type = p_ecf_type
     and s.active
     and (s.expires_at is null or s.expires_at >= now())
     and s.next_seq <= s.seq_to
   order by s.next_seq
   limit 1
   for update;
  if not found then
    return; -- no usable sequence: empty result, caller falls back / warns
  end if;

  update public.ecf_sequences
     set next_seq = seq.next_seq + 1, updated_at = now()
   where id = seq.id;

  sequence_id := seq.id;
  e_ncf := 'E' || p_ecf_type || lpad(trunc(seq.next_seq)::text, 10, '0');
  seq_expires_at := seq.expires_at;
  return next;
end;
$$;

create or replace function public.post_sale(p_entry jsonb, p_lines jsonb, p_posting jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  e  public.journal_entries;
  jl public.journal_lines;
  sp public.sales_postings;
  ln jsonb;
  imbalance numeric;
begin
  -- Last-gate balance check (the client validates too via assertBalanced).
  select coalesce(sum(coalesce((l->>'debit')::numeric, 0) - coalesce((l->>'credit')::numeric, 0)), 0)
    into imbalance
    from jsonb_array_elements(p_lines) l;
  if abs(imbalance) > 0.005 then
    raise exception 'El asiento no cuadra (descuadre %).', imbalance;
  end if;

  e  := jsonb_populate_record(null::public.journal_entries, p_entry);
  sp := jsonb_populate_record(null::public.sales_postings, p_posting);
  e.created_at  := now();  e.updated_at  := now();
  sp.created_at := now();  sp.updated_at := now();
  sp.journal_entry_id := e.id;

  for attempt in 1..5 loop
    begin
      e.number := coalesce((select max(number) from public.journal_entries
                             where profile_id = e.profile_id), 0) + 1;
      sp.number := coalesce((select max(number) from public.sales_postings
                              where profile_id = sp.profile_id), 0) + 1;
      insert into public.journal_entries values (e.*);
      for ln in select * from jsonb_array_elements(p_lines) loop
        jl := jsonb_populate_record(null::public.journal_lines, ln);
        jl.created_at := now();
        insert into public.journal_lines values (jl.*);
      end loop;
      insert into public.sales_postings values (sp.*);
      return;
    exception when unique_violation then
      -- A concurrent post took our number — retry with fresh ones. (A real
      -- duplicate — same quote or same NCF — keeps violating and surfaces.)
      if attempt = 5 then raise; end if;
    end;
  end loop;
end;
$$;

revoke all on function public.assign_next_encf(text, text) from public;
grant execute on function public.assign_next_encf(text, text) to authenticated;
revoke all on function public.post_sale(jsonb, jsonb, jsonb) from public;
grant execute on function public.post_sale(jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
