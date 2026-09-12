-- ═══════════════════════════════════════════════════════════════════════════
-- HAPVIDA APAGADA SEMPRE, AUTOMÁTICO — OS REMETENTES QUE FALTAVAM NA LISTA
--
--   "HP Vida é coisa do BR, a Chris paga por lá, não estamos registrando isso
--    ainda, apague sempre os emails" — Márcio, 11/set/2026
--   "Apagar sempre, automático" — Márcio, 11/set/2026, ao fechar o pacote
--
-- A ideia antiga de PROTEGER a Hapvida em lib/mailProtected.ts CAIU: ele quer o
-- contrário, que suma sozinha. Mas o robô (lib/marketingKill.server.ts) só toca
-- em remetente LISTADO, e dos quatro endereços automáticos só um estava na
-- lista — contato@pagoufacil.com.br, desde 10/set. Os outros três nunca seriam
-- apagados pelo robô, por mais exceção que a coluna tivesse. É o que este
-- arquivo conserta; o resto do conserto é código, no mesmo commit.
--
-- ── O QUE FOI MEDIDO (11/set/2026, 20h Orlando, só leitura em mail_processed) ─
-- Mensagens DISTINTAS que a rodada de e-mail mandou à mão pros Itens Excluídos,
-- todas na CAIXA 2 (galpaoz28@hotmail.com) — nenhuma nas outras cinco:
--   comunicacao@contato.hapvidandi.com.br  11  "…Não identificamos seu pagamento"  sem anexo
--   boleto.notredamesp@hapvida.com.br       8  "Seu Boleto Notredame Intermedica chegou!"  COM anexo
--   ccg@contato.comunicacaoccg.com.br       1  o mesmo aviso, de abr/2025          sem anexo
--   contato@pagoufacil.com.br              10  já está na lista desde 21/ago, exceção em 10/set
--
-- ── O QUE NÃO ENTRA (de propósito) ──────────────────────────────────────────
--   • lucas.sena@hapvida.com.br ("DEPOSITO IDENTIFICADO", 1 mensagem) é GENTE.
--     Correspondência de gente não se apaga sozinha — lib/mailProtected.ts.
--   • Os 36 antigos da Intermédica (2021–2024) estão ARQUIVADOS em pasta, e o
--     robô não varre pasta: só caixa de entrada e lixo eletrônico.
--   • comunicado.importante@intermedica.com.br (2 mensagens, 11/set: "Comunicado
--     importante!" e "COMUNICADO IMPORTANTE: INADIMPLÊNCIA DA MENSALIDADE") é um
--     QUARTO automático que apareceu na medição de hoje e que ele NÃO citou.
--     Fica de fora: preencher a exceção é decisão dele, linha a linha, nunca por
--     volume. Se ele disser "esse também", é uma linha igual às de baixo.
--
-- RODAR UMA VEZ no SQL Editor do projeto US (fvgpkbpqacnqxtrjsmpi).
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. O COMENTÁRIO DA COLUNA PASSA A DIZER A VERDADE NOVA ──────────────────
-- Desde 10/set a exceção derrubava SÓ a trava de palavra. Não bastava: o boleto
-- da Notredame vem COM anexo nas 8 de 8, e a trava de anexo o prenderia para
-- sempre. A partir deste commit a exceção derruba palavra E anexo.
comment on column public.marketing_senders.hard_stop_waived_at is
  'Remetente que o Márcio mandou apagar SEMPRE: preenchida, a trava de PALAVRA transacional (HARD_STOP: fatura, boleto, invoice…) E a trava de ANEXO deixam de valer para ESTE endereço. Conversa (In-Reply-To/References) e remetente protegido (lib/mailProtected.ts) continuam travando. NULL = regra normal. Decisão dele, linha a linha — nunca por volume.';

-- ── 2. OS TRÊS AUTOMÁTICOS QUE FALTAVAM, JÁ COM A EXCEÇÃO PREENCHIDA ────────
-- `email` é a PRIMARY KEY (medido em 11/set no schema do PostgREST; a tabela foi
-- criada à mão e não tem DDL no repo), e `hits`/`blocked` já nascem 0 por default.
-- Mesmo assim o insert vai de `where not exists` e não de `on conflict`: rodar
-- duas vezes não duplica nem estoura, e linha que já exista fica INTOCADA — as
-- contagens e o histórico de quem já está na lista não podem ser sobrescritos.
insert into public.marketing_senders (email, account, active, evidence, verified_at, note, hard_stop_waived_at)
select v.email, 'BR', true, v.evidence, current_date, v.note, now()
  from (values
    ('comunicacao@contato.hapvidandi.com.br', 11,
     '11/set/2026 Márcio: "apague sempre os emails" da HP Vida — plano de saúde do BR, a Chris paga por lá, nada disso é registrado no app. Aviso automático "Não identificamos seu pagamento", sem anexo; 11 mensagens medidas na caixa 2 (galpaoz28), zero nas outras cinco.'),
    ('boleto.notredamesp@hapvida.com.br', 8,
     '11/set/2026 Márcio: "apague sempre os emails" da HP Vida. Boleto automático "Seu Boleto Notredame Intermedica chegou!", 8 de 8 COM ANEXO — por isso a exceção passou a derrubar também a trava de anexo. NÃO confundir com lucas.sena@hapvida.com.br, que é gente e não entra na lista.'),
    ('ccg@contato.comunicacaoccg.com.br', 1,
     '11/set/2026 Márcio: "apague sempre os emails" da HP Vida. Terceiro emissor do mesmo aviso "Não identificamos seu pagamento" (abr/2025), 1 mensagem medida na caixa 2.')
  ) as v(email, evidence, note)
 where not exists (select 1 from public.marketing_senders m where m.email = v.email);

-- ── CONFERÊNCIA: os quatro automáticos da Hapvida ativos e com data na exceção,
--    e NENHUMA linha de gente (lucas.sena) na lista.
select email, account, active, evidence, hits, blocked, hard_stop_waived_at
  from public.marketing_senders
 where email in ('comunicacao@contato.hapvidandi.com.br',
                 'boleto.notredamesp@hapvida.com.br',
                 'ccg@contato.comunicacaoccg.com.br',
                 'contato@pagoufacil.com.br')
    or email ilike '%hapvida%'
    or email ilike '%intermedica%'
 order by email;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK (cola e roda se der errado — tira só o que este arquivo pôs)
--
-- delete from public.marketing_senders
--  where email in ('comunicacao@contato.hapvidandi.com.br',
--                  'boleto.notredamesp@hapvida.com.br',
--                  'ccg@contato.comunicacaoccg.com.br');
--
-- comment on column public.marketing_senders.hard_stop_waived_at is
--   'Remetente que o Márcio mandou apagar SEMPRE: preenchida, a trava de PALAVRA transacional (HARD_STOP: fatura, boleto, invoice…) não vale para ESTE endereço. Anexo, conversa (In-Reply-To/References) e remetente protegido continuam travando. NULL = regra normal. Decisão dele, linha a linha — nunca por volume.';
--
-- O rollback do SQL sozinho NÃO desfaz o código: com o commit no ar e as três
-- linhas removidas, o robô simplesmente volta a ignorar esses remetentes (ele
-- só toca em quem está na lista) e a Hapvida volta a ser apagada à mão pela
-- rodada de e-mail. Ninguém fica apagando nada indevido.
-- ═══════════════════════════════════════════════════════════════════════════
