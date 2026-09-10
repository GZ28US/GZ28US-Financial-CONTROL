-- ═══════════════════════════════════════════════════════════════════════════
-- O REMETENTE QUE O MÁRCIO MANDOU APAGAR SEMPRE, MESMO COM "FATURA" NO ASSUNTO
--
--   "apague a HPVida sempre" — Márcio, 10/set/2026 (pela sessão do email round)
--
-- ── O QUE FOI MEDIDO (10/set/2026) ─────────────────────────────────────────
--   contato@pagoufacil.com.br está em marketing_senders desde 21/ago:
--   hits 4 · blocked 8.296 · último travado "HAPVIDA: atenção ao vencimento do
--   seu boleto hoje!"
-- O HARD_STOP de lib/marketingKill.server.ts casa "fatura" e "boleto", então o
-- cron reencontra o mesmo e-mail a cada 5 minutos, trava e deixa na caixa.
--
-- A trava de palavra é certa para a lista inteira e continua valendo. O que
-- entra é uma exceção POR REMETENTE, gravada no banco e com data: preenchida,
-- só a trava de PALAVRA deixa de valer para aquele endereço exato. Anexo,
-- conversa (In-Reply-To/References) e remetente protegido continuam barrando.
--
-- Os boletos reais da Hapvida vêm de boleto.notredamesp@hapvida.com.br
-- (contrato 1T9UC.000000) — esse endereço NÃO está na lista, e o robô só toca
-- em remetente listado. A conferência no fim mostra as duas coisas.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.marketing_senders
  add column if not exists hard_stop_waived_at timestamptz;

comment on column public.marketing_senders.hard_stop_waived_at is
  'Remetente que o Márcio mandou apagar SEMPRE: preenchida, a trava de PALAVRA transacional (HARD_STOP: fatura, boleto, invoice…) não vale para ESTE endereço. Anexo, conversa (In-Reply-To/References) e remetente protegido continuam travando. NULL = regra normal. Decisão dele, linha a linha — nunca por volume.';

update public.marketing_senders
   set hard_stop_waived_at = now(),
       note = coalesce(note || ' · ', '') || '10/set/2026 Márcio: apagar SEMPRE, mesmo com "fatura"/"boleto" no assunto (boleto real vem de @hapvida.com.br, fora da lista)'
 where email = 'contato@pagoufacil.com.br'
   and hard_stop_waived_at is null;

-- CONFERÊNCIA: a linha do pagoufacil com a data — e NENHUM endereço da Hapvida na lista.
select email, active, hits, blocked, hard_stop_waived_at, note
  from public.marketing_senders
 where email = 'contato@pagoufacil.com.br'
    or email ilike '%hapvida%';
