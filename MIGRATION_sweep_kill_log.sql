-- ═══════════════════════════════════════════════════════════════════════════
-- OS ROBÔS QUE APAGAM E-MAIL PASSAM A DIZER O QUE MOVERAM
--
--   Pacote decidido em 10–11/set/2026, item 9: "sweepSpam/sweepMarketing
--   registrarem o que movem".
--
-- ── O BURACO (medido em 11/set/2026, só leitura) ───────────────────────────
-- `marketing_kills` tem 397 linhas e TODAS são do marketing kill — o único dos
-- três robôs que anota. Por pasta: inbox 281 · junkemail 51 · INBOX 65 (as 65
-- do Gmail batem com as duas caixas @gmail.com: gz28us 57 + gz28speedshop 8).
-- Janela: 18/ago 19:34 → 11/set 18:40, hora de Orlando.
--
-- `sweepSpam` e `sweepMarketing` (`lib/streamMail.server.ts`, rodados pelo
-- mail-poll de 5 em 5 minutos) movem e-mail pros Itens Excluídos SEM DEIXAR
-- LINHA NENHUMA. Quando uma mensagem aparece no lixo, não há como dizer quem a
-- pôs lá — e "não tem registro" não distingue "nenhum robô fez" de "o robô fez
-- e não anotou". É a mesma lição que criou o rastro de `mail_processed` em
-- `lib/mailProtected.server.ts`, depois que a resposta do despachante apareceu
-- nos Itens Excluídos duas vezes sem nenhuma linha explicando.
--
-- ── O QUE MUDA ─────────────────────────────────────────────────────────────
-- A tabela que o matador já usa vira o registro dos TRÊS robôs que apagam. Ela
-- já responde DE / ASSUNTO / PASTA DE ORIGEM / QUANDO / QUAL CAIXA (sender,
-- subject, folder, killed_at, account); faltavam duas respostas: QUAL ROBÔ e
-- PARA ONDE. Tabela nova repetiria essas cinco colunas — a lei da casa proíbe
-- campo duplicado.
--
-- Rode UMA vez no SQL Editor do projeto US (fvgpkbpqacnqxtrjsmpi).
-- ═══════════════════════════════════════════════════════════════════════════

begin;

alter table public.marketing_kills
  add column if not exists robot    text,
  add column if not exists moved_to text;

comment on column public.marketing_kills.robot is
  'Qual robô moveu a mensagem: marketing-kill (cron próprio de 5 em 5 min) · spam-sweep · marketing-sweep (os dois pelo mail-poll). SEM DEFAULT de propósito: linha sem robô é linha de código velho, e um default esconderia isso.';

comment on column public.marketing_kills.moved_to is
  'Para onde foi: deleteditems (Itens Excluídos, caixas Outlook) ou trash (Lixeira, caixas Gmail). Sempre recuperável — robô da casa nunca apaga em definitivo.';

-- BACKFILL — as 397 linhas de hoje são todas do marketing kill, e o destino sai
-- da pasta: 'INBOX' em maiúsculo só existe no Gmail (o ramo Graph grava 'inbox'
-- e 'junkemail' em minúsculo), e Gmail vai pro trash.
update public.marketing_kills
   set robot    = 'marketing-kill',
       moved_to = case when folder = 'INBOX' then 'trash' else 'deleteditems' end
 where robot is null;

-- "O que este robô andou apagando na última semana" é a pergunta que se faz
-- desta tabela; sem índice ela vira varredura conforme o log cresce.
create index if not exists marketing_kills_robot_idx
  on public.marketing_kills (robot, killed_at desc);

commit;

-- CONFERÊNCIA (esperado agora: marketing-kill/deleteditems 332 e
-- marketing-kill/trash 65, nada com robot nulo).
select robot, moved_to, folder, count(*) as linhas
  from public.marketing_kills
 group by 1, 2, 3
 order by linhas desc;
