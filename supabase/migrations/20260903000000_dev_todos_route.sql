-- Record WHERE a dev todo was written (the in-app route the owner was on when
-- they typed it), so the developer knows which screen/file the fix touches.
-- Additive.
alter table dev_todos add column if not exists route text;

notify pgrst, 'reload schema';
