# invite-user

Admin-only Edge Function that creates a new team member by email.

The app's `/admin/users` page POSTs to this function with `{ email, name,
role, commissionPct }`. The function authenticates the caller via the JWT
they send, verifies they're an active admin, then uses Supabase's
service-role key to call `auth.admin.inviteUserByEmail()` and pre-create
the matching `profiles` row. The invitee receives Supabase's "Invite
User" email; clicking the link lands them on the password-setup screen,
and on first sign-in they're already active with the role and commission
the admin assigned.

## Deploy

From the project root, with the Supabase CLI authenticated against this
project:

```sh
# 1. Set the service-role key as a function secret (one time).
#    Find the key in Supabase Dashboard → Project Settings → API →
#    "service_role" (NOT the anon key — the anon key has none of the
#    admin-API permissions this function needs).
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<the-service-role-key>

# 2. Deploy the function.
#    --no-verify-jwt because we do our own JWT verification inside
#    (we need to read the auth.users row to confirm admin role).
supabase functions deploy invite-user --no-verify-jwt
```

## Re-deploy after edits

```sh
supabase functions deploy invite-user --no-verify-jwt
```

Secrets persist between deploys; you only set them once unless you need
to rotate.

## Bootstrap the first admin

The function refuses to run unless the caller is already an active
admin — so the very first admin can't invite themselves. Bootstrap is
a one-time manual step:

1. In **Supabase Dashboard → Authentication → Users**, click **Add user**
   → **Create new user**. Enter `javier@alcover.do` and a temporary
   password.
2. Sign in to the app at `/login` with that email + password.
3. The app reads `settings.admin_emails` (seeded with
   `javier@alcover.do` by migration
   `20260518110000_user_roles_and_commissions.sql`), recognizes the
   email, and auto-creates the matching profile row with `role='admin'`
   and `active=true`.
4. From that point on, every other user comes through this function.

Adding another bootstrap admin later is a one-row update on the
`settings` row:

```sql
update public.settings
   set admin_emails = '["javier@alcover.do","other@example.com"]'::jsonb
 where profile_id = 'team';
```

The auto-promotion logic in `ensureDefaultProfile()` (`src/db/database.js`)
runs every sign-in and promotes any allowlisted email to admin if they
aren't already.

## Endpoint

The deployed function lives at:

```
https://<your-project-ref>.supabase.co/functions/v1/invite-user
```

The app constructs this URL from `VITE_SUPABASE_URL`, so no extra env
var is needed in the frontend.

## Email template

Supabase's "Invite User" email template (Auth → Email Templates) is what
the invitee sees. It includes the magic link to your site's confirm page.
Customize the subject line and body in the dashboard if you want the
copy to match Roset Soft's voice.
