-- Pin search_path on the functions flagged by the Supabase security advisor
-- (lint 0011_function_search_path_mutable). A function with a mutable search_path
-- resolves unqualified object names against whatever search_path the caller
-- happens to have set, which lets a caller shadow public/built-in objects.
-- Pinning it to `public, pg_temp` is Supabase's recommended hardening and is
-- non-breaking here: every one of these functions already resolves the objects
-- it touches from the public schema. None are SECURITY DEFINER.
--
-- Idempotent: ALTER FUNCTION ... SET is safe to re-run.

alter function public.catalog_categories(text, text)  set search_path = public, pg_temp;
alter function public.customers_touch_updated_at()     set search_path = public, pg_temp;
alter function public.enforce_open_period()            set search_path = public, pg_temp;
alter function public.materials_set_updated_at()       set search_path = public, pg_temp;
alter function public.profiles_touch_updated_at()      set search_path = public, pg_temp;

notify pgrst, 'reload schema';
