-- Fix: uploading the .p12 hit "new row violates row-level security policy for
-- table ecf_credentials". The table is write-only by design (RLS on, no client
-- read), but a direct PostgREST upsert against a policy-gated, no-SELECT table
-- is brittle. Replace the write path with a SECURITY DEFINER function: the
-- browser calls it (no table-level grant needed), it upserts the single 'team'
-- row, and the cert stays unreadable by clients. Only this function writes and
-- the ecf-send service role reads — RLS stays on with NO client policies.

drop policy if exists ecf_credentials_insert  on public.ecf_credentials;
drop policy if exists ecf_credentials_update  on public.ecf_credentials;
drop policy if exists ecf_credentials_team_rw on public.ecf_credentials;

create or replace function public.save_ecf_credentials(
  p_p12 text, p_password text, p_environment text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ecf_credentials (profile_id, p12_base64, password, environment, uploaded_at, updated_at)
  values ('team', p_p12, p_password, coalesce(nullif(p_environment, ''), 'cert'), now(), now())
  on conflict (profile_id) do update
    set p12_base64  = excluded.p12_base64,
        password    = excluded.password,
        environment = excluded.environment,
        updated_at  = now();
end;
$$;

revoke all on function public.save_ecf_credentials(text, text, text) from public;
grant execute on function public.save_ecf_credentials(text, text, text) to authenticated;

notify pgrst, 'reload schema';
