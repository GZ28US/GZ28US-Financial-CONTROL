-- PARTS REFINEMENT R1 — fornecedor com identidade (24/ago/2026). Idempotente.
-- O catálogo tem 188 grafias de fornecedor pra 40 nomes oficiais da tabela
-- suppliers ("HHP" / "High Horse Performance" / "high horse" são três estranhos).
-- part → supplier_id fecha o triângulo de identidade (peça ↔ estoque/stream ↔
-- fornecedor) e destrava o lead time por fornecedor no Crew Chief.
alter table public.parts_database add column if not exists supplier_id uuid references public.suppliers (id) on delete set null;
create index if not exists parts_database_supplier_idx on public.parts_database (supplier_id) where supplier_id is not null;
