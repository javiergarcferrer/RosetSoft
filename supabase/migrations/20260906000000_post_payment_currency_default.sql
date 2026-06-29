-- Fix: post_payment crashed with "null value in column currency of relation
-- payments violates not-null constraint" whenever the payment JSON omitted
-- `currency` (the deposit cobro in Facturación and the Pay-Bills batch in
-- Cuentas both build the payment row without an fx block).
--
-- The payments.currency column is NOT NULL DEFAULT 'DOP', but
-- jsonb_populate_record leaves the field NULL when the key is absent — and
-- `insert ... values (pm.*)` then writes that explicit NULL, bypassing the
-- column default. Re-apply the default inside the RPC so every caller that
-- doesn't specify a currency books in DOP (the account currency), exactly as
-- the column intends.
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

revoke all on function public.post_payment(jsonb, jsonb, jsonb) from public;
grant execute on function public.post_payment(jsonb, jsonb, jsonb) to authenticated;

notify pgrst, 'reload schema';
