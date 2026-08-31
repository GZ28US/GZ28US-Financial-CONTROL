-- BANK MATCH LOG (31/ago/2026): o diário indelével da conciliação. Nasceu do
-- reset proposital do Márcio — o trabalho humano de casamento foi perdido
-- porque só vivia nas colunas de bank_transactions. A partir de agora TODA
-- decisão (MATCH/UNMATCH/TRANSFER/IGNORE/QUEUE/UNQUEUE, humana ou do motor)
-- é gravada aqui em forma ESTRUTURADA e re-aplicável: depois de qualquer
-- reset, o botão RESTAURAR DIÁRIO no Bank Link reencena o estado final de
-- cada linha (action=restore_log). Append-only — nunca apague nada daqui.
-- Rode UMA vez no SQL Editor do projeto US.
create table if not exists bank_match_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  bank_id text not null,
  bank_date text,
  bank_name text,
  bank_amount numeric,
  action text not null,
  matched_table text,
  matched_id text,
  note text,
  engine text,
  batch text,
  members jsonb
);
create index if not exists bank_match_log_bank_idx on bank_match_log (bank_id, at desc);
alter table bank_match_log enable row level security;
do $$ begin
  create policy bml_read on bank_match_log for select to authenticated using (true);
exception when duplicate_object then null; end $$;
