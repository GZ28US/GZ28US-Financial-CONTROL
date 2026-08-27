-- MIGRATION — DUAS CASAS PRO QUE AINDA ESTAVA NO TEXTO (Márcio, 27/ago/2026:
-- "o textão continua lá, vc não tinha mudado isso?").
--
-- A descrição da passagem virou um parágrafo com reserva, forma de pagamento,
-- voo, horários, localizador e bagagem — tudo isso JÁ tem campo hoje. Sobraram
-- duas informações sem casa, e é por elas que o texto não encolhia:
--
--   • as TAXAS do bilhete (US$ 53,20 do Eliel, US$ 52,70 da Chris) — estão no
--     recibo e são parte do preço da passagem, então moram no voo;
--   • o ID DA TRANSAÇÃO do pagamento (PayPal 8A880271M18021822) — é como se
--     acha o pagamento na origem. Serve pra QUALQUER expense, não só passagem.
--
-- O "cartão final 9785" fica de fora de propósito: isso é dado do extrato, e
-- quem sabe disso é o bank_transactions.

begin;

alter table public.staff_flights add column if not exists taxes_usd numeric;
alter table public.expenses      add column if not exists payment_reference text;

commit;

-- Tira do texto o que agora tem campo.
update public.staff_flights set taxes_usd = 53.20 where booking_ref = 'BUSA-36857155';
update public.staff_flights set taxes_usd = 52.70 where booking_ref = 'BUSA-36424606';

update public.expenses
   set payment_reference = '8A880271M18021822',
       description = 'Passagem aérea (ida)'
 where order_number = 'BUSA-36857155';

update public.expenses
   set description = 'Passagem aérea (ida)'
 where order_number = 'BUSA-36424606';
