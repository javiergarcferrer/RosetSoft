-- Coexistence (Embedded Signup) needs two NON-SECRET Meta identifiers the
-- browser uses to launch the hosted signup dialog: the Meta App ID and the
-- Facebook Login for Business Configuration ID. They live on settings (the
-- secrets — token, app secret — stay in write-only whatsapp_config).
alter table settings add column if not exists whatsapp_app_id text;
alter table settings add column if not exists whatsapp_config_id text;

notify pgrst, 'reload schema';
