-- Re-apply the e-CF transactional RPCs (assign_next_encf + post_sale) and the
-- sales_postings emission columns.
--
-- The original migration (20260703120000_ecf_txn_rpcs.sql) is recorded as
-- APPLIED in supabase_migrations.schema_migrations, but its DDL never ran in
-- prod: Supabase keys applied migrations by the 14-digit VERSION prefix, so
-- once that version was marked applied the file's later-added body was never
-- executed. Result in prod: ecf_sequences exists, but assign_next_encf /
-- post_sale and the sales_postings.ecf_expires_at / fecha_firma columns are
-- all missing — so "Facturar" dies on
--   Could not find the function public.assign_next_encf(...) in the schema cache
-- and would next die on post_sale. Editing the old file can't fix it (the
-- version is already applied), so this carries the same idempotent DDL under a
-- fresh, later version. See the original file for the rationale on each object.

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
