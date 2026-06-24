-- Atomic payment posting RPC — mirror of post_sale for cobros/pagos.
--
-- The page was writing a payment in THREE steps: assignSequenceNumber for the
-- journal_entries row, then journal_lines.bulkPut, then assignSequenceNumber for
-- the payments row. A failure between them left a balanced asiento (the bill
-- looks paid in the Mayor) with NO payments row — so CxP still showed the bill
-- open and the cobro could be entered twice (double payment). This wraps all
-- three inserts in ONE server-side transaction (both numbers assigned here,
-- retried on a concurrent-number collision) — exactly like post_sale.
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
