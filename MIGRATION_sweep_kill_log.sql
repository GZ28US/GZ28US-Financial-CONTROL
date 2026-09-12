-- ═══════════════════════════════════════════════════════════════════════════
-- OS ROBÔS QUE APAGAM E-MAIL PASSAM A DIZER O QUE MOVERAM
--
--   Pacote decidido em 10–11/set/2026, item 9: "sweepSpam/sweepMarketing
--   registrarem o que movem".
--
-- ── O BURACO (medido em 11/set/2026 às 21:28 de Orlando, só leitura) ───────
-- `marketing_kills` tem 398 linhas e TODAS são do marketing kill — o único dos
-- três robôs que anota. Por pasta: inbox 282 · junkemail 51 · INBOX 65 (as 65
-- do Gmail batem com as duas caixas @gmail.com: gz28us 57 + gz28speedshop 8).
-- Janela: 18/ago 19:34 → 11/set 20:45, hora de Orlando. A CONTAGEM CRESCE a
-- cada passada do cron (eram 397 na medição anterior, às ~20:45 do mesmo dia) —
-- os números aqui são retrato da medição, não gabarito de conferência.
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
-- A tabela que o matador já usa vira o registro dos TRÊS robôs que MOVEM
-- e-mail: marketing-kill, spam-sweep e marketing-sweep. Ela já responde DE /
-- ASSUNTO / PASTA DE ORIGEM / QUANDO / QUAL CAIXA (sender, subject, folder,
-- killed_at, account); faltavam duas respostas: QUAL ROBÔ e PARA ONDE. Tabela
-- nova repetiria essas cinco colunas — a lei da casa proíbe campo duplicado.
--
-- O QUE ELA NÃO RESPONDE: o inbox-zero (`lib/inboxZero.server.ts`, regra
-- 'DELETE') apaga DE VEZ pelo Graph e não escreve aqui. Linha nesta tabela
-- prova quem moveu; a AUSÊNCIA de linha não prova que robô nenhum encostou.
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
  'Para onde foi: deleteditems (Itens Excluídos, caixas Outlook) ou trash (Lixeira, caixas Gmail). Os dois recuperáveis — quem escreve nesta tabela só MOVE. Quem apaga de vez é o inbox-zero, e ele não escreve aqui.';

-- BACKFILL — as linhas de hoje são todas do marketing kill, e o destino sai da
-- pasta: 'INBOX' em maiúsculo só existe no Gmail (o ramo Graph grava 'inbox' e
-- 'junkemail' em minúsculo), e Gmail vai pro trash.
--
-- `where robot is null` SÓ É VERDADE porque a rede de segurança do código combina
-- com ele: se esta migration ainda não tiver rodado quando o código subir,
-- `registrarFaxina` (lib/streamMail.server.ts) repete o insert no formato antigo
-- APENAS para o marketing-kill — o único robô que já gravava. Sweep nesse
-- intervalo não grava linha nenhuma (e grita no `logFalhou` da resposta do
-- mail-poll), justamente para não deixar aqui uma linha sem robô que este update
-- batizaria de 'marketing-kill'. Log que mente sobre QUEM moveu é pior que log
-- faltando: quem moveu é a única pergunta que esta tabela existe para responder.
update public.marketing_kills
   set robot    = 'marketing-kill',
       moved_to = case when folder = 'INBOX' then 'trash' else 'deleteditems' end
 where robot is null;

-- "O que este robô andou apagando na última semana" é a pergunta que se faz
-- desta tabela; sem índice ela vira varredura conforme o log cresce.
create index if not exists marketing_kills_robot_idx
  on public.marketing_kills (robot, killed_at desc);

commit;

-- CONFERÊNCIA. O que TEM de valer é a linha de baixo: ZERO com robot nulo.
select count(*) as sem_robo from public.marketing_kills where robot is null;

-- E o retrato: tudo 'marketing-kill', partido entre deleteditems e trash. Em
-- 11/set às 21:28 de Orlando eram 333 e 65 (total 398), mas o cron grava a cada
-- 5 minutos — número diferente daquele é CRESCIMENTO, não erro. Erro é robô
-- diferente de marketing-kill aparecer aqui antes de o código novo subir, ou
-- destino que não seja deleteditems/trash.
select robot, moved_to, folder, count(*) as linhas
  from public.marketing_kills
 group by 1, 2, 3
 order by linhas desc;
