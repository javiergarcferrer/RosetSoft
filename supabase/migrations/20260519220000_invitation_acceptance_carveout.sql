-- Invitation acceptance flow: allow an invitee to flip themselves
-- from active=false to active=true exactly once, on their first
-- sign-in. The prevent_self_privilege_escalation trigger added in
-- migration 20260518160000 was blocking this case unconditionally:
-- an admin invites a new user with active=false, the invitee clicks
-- the magic link, ensureDefaultProfile() in db/database.ts tries to
-- patch them to active=true + stamp last_sign_in_at, and the
-- trigger raised '42501 No puedes cambiar tu propio estado activo'.
-- The application code swallowed the error and the invitee landed
-- on the "Cuenta pendiente de aprobación" gate even though the
-- admin had explicitly approved them.
--
-- The carve-out below preserves the original security boundary —
-- an active user can't reactivate themselves after being disabled,
-- and a never-signed-in employee can't promote themselves except
-- via this exact one-shot path:
--
--   old.active = false
--   old.last_sign_in_at IS NULL  (this user has never signed in)
--   new.active = true            (the flip we're letting through)
--
-- Once last_sign_in_at is non-null (the next sign-in, or any other
-- update that stamps it), the exception no longer applies and the
-- trigger continues to block self-mutation of active. So the
-- invitee can complete their own acceptance but never re-activate
-- themselves after an admin disables them.
--
-- role + commission_pct guards stay strict; this carve-out only
-- relaxes the active check, which is the field the invitation flow
-- legitimately needs to flip on the user's behalf.

create or replace function public.prevent_self_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.id = auth.uid()::text and not public.is_admin(auth.uid()) then
    if new.role is distinct from old.role then
      raise exception 'No puedes cambiar tu propio rol.'
        using errcode = '42501';
    end if;
    if new.active is distinct from old.active then
      -- First-acceptance carve-out — see the header for the rule.
      if not (
        coalesce(old.active, false) = false
        and old.last_sign_in_at is null
        and coalesce(new.active, false) = true
      ) then
        raise exception 'No puedes cambiar tu propio estado activo.'
          using errcode = '42501';
      end if;
    end if;
    if new.commission_pct is distinct from old.commission_pct then
      raise exception 'No puedes cambiar tu propia comisión.'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- Trigger definition itself doesn't change — we just swapped out
-- the function body. Re-create defensively in case the function
-- name or signature changes in a future migration.
drop trigger if exists profiles_prevent_self_privilege_escalation on public.profiles;
create trigger profiles_prevent_self_privilege_escalation
  before update on public.profiles
  for each row
  execute function public.prevent_self_privilege_escalation();

notify pgrst, 'reload schema';
