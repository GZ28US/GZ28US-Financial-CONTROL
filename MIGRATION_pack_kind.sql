-- CC 0.2.1 — KIND do pack (João, 26/ago/2026): a anatomia é sempre a mesma
-- (parts+services+duties), o papel no catálogo é que muda:
--   PACK   = produto principal (Demonized, GoldenEye)
--   ADDON  = opcional de venda por cima do pack ("Demonized PLUS Lowering Springs")
--   BLOCK  = unidade de construção (Engine Build, Crank Pinning) composta via
--            🧱 IMPORT A BLOCK no editor
-- Coluna aditiva com default — segura pro app BR que compartilha a tabela.
-- Rode UMA vez no SQL Editor do projeto US.
alter table packs add column if not exists kind text not null default 'PACK';
do $$ begin
  alter table packs add constraint packs_kind_check check (kind in ('PACK','ADDON','BLOCK'));
exception when duplicate_object then null; end $$;
