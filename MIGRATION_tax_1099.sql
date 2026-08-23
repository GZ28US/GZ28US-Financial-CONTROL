-- TAX HUB v0.1.0 — rastreador de 1099-NEC (23/ago/2026)
-- Rodar no SQL Editor do Supabase (projeto GZ28US). Idempotente.
--
-- tax_contractors: a CLASSIFICAÇÃO de cada beneficiário pago pela LLC (Zelle/
-- wire/cheque). O extrato diz QUEM recebeu e QUANTO; o humano diz O QUE era
-- (serviço = 1099-NEC se ≥ $600/ano e não-corporação; mercadoria e corporação
-- ficam de fora — regra geral, a Drummond confirma). name_key = nome normalizado.
create table if not exists public.tax_contractors (
  id             uuid primary key default gen_random_uuid(),
  name_key       text not null unique,
  display_name   text not null,
  classification text check (classification in ('SERVICE', 'GOODS', 'CORPORATION', 'PERSONAL', 'IGNORE')),
  w9_on_file     boolean not null default false,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

alter table public.tax_contractors enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where tablename = 'tax_contractors' and policyname = 'auth all tax_contractors') then
    create policy "auth all tax_contractors" on public.tax_contractors for all to authenticated using (true) with check (true);
  end if;
end $$;
