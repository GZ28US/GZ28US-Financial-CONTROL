-- ============================================================================
-- GZ28US — DATA CHECK: trilha de auditoria dos consertos (v0.6.0)
-- ----------------------------------------------------------------------------
-- Cada conserto feito DENTRO do DATA CHECK (data, destino, tipo, baixa) vira
-- uma linha aqui: o quê, quando, valor antigo → novo. A tela agrupa por dia
-- ("sessão") pro Márcio revisar depois se uma sessão inteira ficou boa.
--
-- COMO RODAR: Supabase dashboard (fvgpkbpqacnqxtrjsmpi) → SQL Editor → Run.
-- Idempotente. RLS no padrão do app (authenticated faz tudo).
-- ============================================================================

begin;

create table if not exists public.data_fixes (
  id         uuid primary key default gen_random_uuid(),
  fixed_at   timestamptz not null default now(),
  check_key  text not null,        -- qual card do DATA CHECK originou o conserto
  table_name text not null,        -- tabela alterada
  row_id     text not null,        -- id da linha alterada
  field      text not null,        -- campo alterado
  old_value  text,
  new_value  text,
  label      text                  -- humano: 'US.032 · HellRaisin'
);

alter table public.data_fixes enable row level security;
drop policy if exists data_fixes_authenticated_all on public.data_fixes;
create policy data_fixes_authenticated_all on public.data_fixes
  for all to authenticated using (true) with check (true);

commit;

-- ROLLBACK: drop table if exists public.data_fixes;
