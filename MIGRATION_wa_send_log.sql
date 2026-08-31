-- WA SEND LOG (31/ago/2026, caso Gui): o aviso de duty morreu calado — só um
-- toast de 3s no celular. Toda tentativa de envio do /api/whatsapp (sucesso E
-- falha) passa a ficar gravada aqui; o Data Checker fiscaliza as falhas.
-- Rode UMA vez no SQL Editor do projeto US.
create table if not exists wa_send_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  destination text,
  group_name text,
  kind text,
  body_head text,
  ok boolean not null default false,
  error text,
  http_status int,
  ultra_id text
);
create index if not exists wa_send_log_at_idx on wa_send_log (at desc);
-- Escrita só pela rota (service role); authenticated lê pro card do DC.
alter table wa_send_log enable row level security;
do $$ begin
  create policy wsl_read on wa_send_log for select to authenticated using (true);
exception when duplicate_object then null; end $$;
