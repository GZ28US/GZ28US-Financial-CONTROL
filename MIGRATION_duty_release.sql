-- DUTY DESTRAVA SOZINHA QUANDO A PEÇA CHEGA (17/10/2026) — lib/dutyRelease.server.ts
-- Márcio (via Staff Cronogram 2): «à medida que as coisas vão chegando, vá desbloqueando a duty e levando pra cima na ordem de
-- prioridade equivalente. Ponha isso pra rodar, crie um robô no app, se preciso, pra ser automático, sem precisar de nós aqui.»
-- Projeto: Supabase US.
--
-- Duty STANDBY com bloqueio: o robô libera quando TODAS as linhas de invoice_expenses chegaram (delivered_at preenchido ou
-- picked_up) e TODAS as duties-bloqueio estão done. Liberar = priority ← release_priority, released_at, bloqueios guardados
-- na trilha (data_fixes 'duty-release') e limpos. O aviso «🔓 DUTY LIBERADA» no grupo STAFF sai na janela 07–22 de Orlando.
alter table public.invoice_duties add column if not exists blocked_by_expenses uuid[];   -- linhas que precisam CHEGAR
alter table public.invoice_duties add column if not exists blocked_by_duties   uuid[];   -- duties que precisam estar done
alter table public.invoice_duties add column if not exists release_priority    text;     -- para onde vai ao destravar: '0'..'4'
alter table public.invoice_duties add column if not exists blocked_reason      text;     -- a frase humana da tela (não é a fonte da verdade)
alter table public.invoice_duties add column if not exists release_issue       text;     -- o que o robô viu de errado (linha-bloqueio sumiu…)
alter table public.invoice_duties add column if not exists released_at         timestamptz;
alter table public.invoice_duties add column if not exists release_notified_at timestamptz;

do $$ begin
  alter table public.invoice_duties add constraint invoice_duties_release_priority_chk check (release_priority is null or release_priority in ('0','1','2','3','4'));
exception when duplicate_object then null; end $$;

create index if not exists invoice_duties_blocked_idx on public.invoice_duties (priority)
  where done = false and (blocked_by_expenses is not null or blocked_by_duties is not null);
create index if not exists invoice_duties_release_notice_idx on public.invoice_duties (released_at)
  where released_at is not null and release_notified_at is null;
