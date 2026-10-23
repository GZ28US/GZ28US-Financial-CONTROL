alter table public.clients drop column if exists grade_at;
alter table public.clients drop column if exists grade_note;
alter table public.clients drop column if exists grade;
notify pgrst, 'reload schema';
