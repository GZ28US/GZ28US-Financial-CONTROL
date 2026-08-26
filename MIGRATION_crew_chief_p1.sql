-- CREW CHIEF P1 — mineração de blueprints com curadoria (26/ago/2026, plano
-- validado por fan-out adversarial de 11 agentes; decisões do João no chat).
-- Rode UMA vez no SQL Editor do projeto US. As tabelas vivem no banco físico
-- compartilhado, mas SÓ o app US as consulta (br-port-system-not-data).
--
-- blueprint_candidates: nasce quando um humano ADOTA um candidato minerado —
-- a mineração em si NUNCA grava nada. Guarda blocos + proveniência completa.
-- O artefato final é um PACK (status DRAFT, zone US) criado no PROMOTE.
create table if not exists blueprint_candidates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  family text,
  platform text,
  status text not null default 'PROPOSED' check (status in ('PROPOSED','PROMOTED','DISMISSED')),
  blocks jsonb not null default '[]',
  source jsonb not null default '{}',
  dismiss_reason text,
  promoted_pack_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists blueprint_events (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid,
  action text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- RLS no padrão do app: authenticated lê/escreve.
alter table blueprint_candidates enable row level security;
alter table blueprint_events enable row level security;
do $$ begin
  create policy bc_all on blueprint_candidates for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy be_all on blueprint_events for all to authenticated using (true) with check (true);
exception when duplicate_object then null; end $$;
