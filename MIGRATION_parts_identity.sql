-- PARTS IDENTITY — pré-P1 do Crew Chief (24/ago/2026, João + Márcio + Claude). Idempotente.
--
-- "Uma peça, uma linha, muitos ponteiros": parts_database é o catálogo canônico;
-- estoque e stream passam a APONTAR pra peça em vez de descrevê-la em texto livre
-- (medido: inventory achava a peça em 5/47, stream em 21/178). O cadeado do Márcio
-- sobe de posto: vive na PRÓPRIA peça (uma conferência serve todos os packs) e
-- congela edição — inventado por ele pra se proteger de si mesmo, formalizado aqui.

-- O cadeado, na peça canônica
alter table public.parts_database add column if not exists locked_at timestamptz;
alter table public.parts_database add column if not exists locked_by text;

-- Ponteiros de identidade
alter table public.inventory add column if not exists part_id uuid references public.parts_database (id) on delete set null;
alter table public.part_streams add column if not exists part_id uuid references public.parts_database (id) on delete set null;
alter table public.invoice_expenses add column if not exists part_id uuid references public.parts_database (id) on delete set null;

create index if not exists inventory_part_idx on public.inventory (part_id) where part_id is not null;
create index if not exists part_streams_part_idx on public.part_streams (part_id) where part_id is not null;
create index if not exists invoice_expenses_part_idx on public.invoice_expenses (part_id) where part_id is not null;

-- Plataforma do pack (Crew Chief: LT4/LT1/HEMI/… — o Poltergeist serve duas)
alter table public.packs add column if not exists platform text;
