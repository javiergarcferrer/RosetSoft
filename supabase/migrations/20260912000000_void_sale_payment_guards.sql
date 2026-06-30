-- Reversal integrity — make anulación atomic and keep cobros honest.
--
-- 1. void_sale — the client used to anul a factura in THREE separate writes
--    (asiento header → lines → set voided_at). A failure between them left the
--    reversing asiento posted but the posting still "active", so a retry posted
--    a SECOND reversal (double-crediting the revenue). This RPC posts the
--    reversal asiento + lines AND flags the posting in ONE transaction, under a
--    row lock, with the same guards the UI shows — and refuses to anul a
--    factura that still has cobros applied (otherwise the receivables FIFO would
--    silently re-apply that money to the customer's other invoices and the
--    refund we now owe would vanish from the books). It also stamps the audit
--    link both ways (reverses_id on the new entry, reversed_by_id on the sale's).
--
-- 2. post_payment — add a backstop so a cobro can NEVER be allocated to a voided
--    posting (a stale UI could otherwise orphan the allocation). Keeps the
--    currency default fix from 20260906.

create or replace function public.void_sale(
  p_posting_id text, p_reason text, p_entry jsonb, p_lines jsonb
)
returns void
language plpgsql
set search_path = public
as $$
declare
  sp public.sales_postings;
  e  public.journal_entries;
  jl public.journal_lines;
  ln jsonb;
  imbalance numeric;
begin
  -- Lock the posting so two anulaciones can't both post a reversal.
  select * into sp from public.sales_postings where id = p_posting_id for update;
  if not found then raise exception 'Factura no encontrada.'; end if;
  if sp.voided_at is not null then raise exception 'La factura ya está anulada.'; end if;
  if sp.ecf_status in ('sent', 'accepted') then
    raise exception 'Un e-CF ya transmitido a la DGII sólo se cancela con una nota de crédito.';
  end if;
  if sp.ncf like 'E34%' then raise exception 'Una nota de crédito no se anula por aquí.'; end if;
  -- Books-honesty gate: never anul a factura with cobros applied.
  if exists (
    select 1
      from public.payments p,
           jsonb_array_elements(coalesce(p.allocations, '[]'::jsonb)) a
     where a->>'docId' = p_posting_id
  ) then
    raise exception 'Esta factura tiene cobros aplicados. Revierte el cobro antes de anular.';
  end if;

  -- The reversal must cuadrar (the client validates too via assertBalanced).
  select coalesce(sum(coalesce((l->>'debit')::numeric, 0) - coalesce((l->>'credit')::numeric, 0)), 0)
    into imbalance
    from jsonb_array_elements(p_lines) l;
  if abs(imbalance) > 0.005 then
    raise exception 'El asiento de anulación no cuadra (descuadre %).', imbalance;
  end if;

  e := jsonb_populate_record(null::public.journal_entries, p_entry);
  e.created_at := now();  e.updated_at := now();

  for attempt in 1..5 loop
    begin
      e.number := coalesce((select max(number) from public.journal_entries
                             where profile_id = e.profile_id), 0) + 1;
      insert into public.journal_entries values (e.*);
      for ln in select * from jsonb_array_elements(p_lines) loop
        jl := jsonb_populate_record(null::public.journal_lines, ln);
        jl.created_at := now();
        insert into public.journal_lines values (jl.*);
      end loop;
      -- Audit link: the sale's asiento now points to the reversal that undid it.
      if sp.journal_entry_id is not null then
        update public.journal_entries
           set reversed_by_id = e.id, updated_at = now()
         where id = sp.journal_entry_id;
      end if;
      update public.sales_postings
         set voided_at = now(), voided_reason = coalesce(p_reason, ''), updated_at = now()
       where id = p_posting_id;
      return;
    exception when unique_violation then
      -- A concurrent post took our number — retry with a fresh one.
      if attempt = 5 then raise; end if;
    end;
  end loop;
end;
$$;

create or replace function public.post_payment(p_entry jsonb, p_lines jsonb, p_payment jsonb)
returns void
language plpgsql
set search_path = public
as $$
declare
  e  public.journal_entries;
  jl public.journal_lines;
  pm public.payments;
  ln jsonb;
  imbalance numeric;
begin
  -- Last-gate balance check (the client validates too via assertBalanced).
  select coalesce(sum(coalesce((l->>'debit')::numeric, 0) - coalesce((l->>'credit')::numeric, 0)), 0)
    into imbalance
    from jsonb_array_elements(p_lines) l;
  if abs(imbalance) > 0.005 then
    raise exception 'El asiento del pago no cuadra (descuadre %).', imbalance;
  end if;

  e  := jsonb_populate_record(null::public.journal_entries, p_entry);
  pm := jsonb_populate_record(null::public.payments, p_payment);

  -- Backstop: a cobro/pago can never be applied to a voided invoice.
  if exists (
    select 1
      from jsonb_array_elements(coalesce(pm.allocations, '[]'::jsonb)) a
      join public.sales_postings sp on sp.id = a->>'docId'
     where sp.voided_at is not null
  ) then
    raise exception 'No se puede aplicar un cobro a una factura anulada.';
  end if;

  e.created_at  := now();  e.updated_at  := now();
  pm.created_at := now();  pm.updated_at := now();
  pm.journal_entry_id := e.id;
  -- jsonb_populate_record ignores the column default, so re-apply it here.
  if pm.currency is null then pm.currency := 'DOP'; end if;

  for attempt in 1..5 loop
    begin
      e.number  := coalesce((select max(number) from public.journal_entries
                              where profile_id = e.profile_id), 0) + 1;
      pm.number := coalesce((select max(number) from public.payments
                              where profile_id = pm.profile_id), 0) + 1;
      insert into public.journal_entries values (e.*);
      for ln in select * from jsonb_array_elements(p_lines) loop
        jl := jsonb_populate_record(null::public.journal_lines, ln);
        jl.created_at := now();
        insert into public.journal_lines values (jl.*);
      end loop;
      insert into public.payments values (pm.*);
      return;
    exception when unique_violation then
      -- A concurrent post took our number — retry with fresh ones.
      if attempt = 5 then raise; end if;
    end;
  end loop;
end;
$$;

revoke all on function public.void_sale(text, text, jsonb, jsonb) from public;
grant execute on function public.void_sale(text, text, jsonb, jsonb) to authenticated;
revoke all on function public.post_payment(jsonb, jsonb, jsonb) from public;
grant execute on function public.post_payment(jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
