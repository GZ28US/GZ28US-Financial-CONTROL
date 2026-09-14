-- HAPVIDA / INTERMÉDICA VOLTAM A SER CONTA DE VERDADE (13/set/2026, Márcio, respondendo sobre o remetente da Intermédica):
-- «este e HPVida tem que ser processados no app à partir de agora também, são contas reais».
-- Desfaz o «apague sempre» de 11/set (MIGRATION_hapvida_apaga_sempre.sql): os 4 remetentes da lista do marketing kill
-- deixam de ser apagados. Nada é apagado aqui — a linha fica, com active = false e a exceção das travas zerada
-- (se alguém religar, as travas de palavra e de anexo voltam a valer). A trilha guarda o estado anterior.
-- Projeto US (fvgpkbpqacnqxtrjsmpi), onde mora marketing_senders.

begin;

insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'hapvida-conta-real', 'marketing_senders', m.email, 'active+hard_stop_waived_at',
       m.active::text || ' · ' || coalesce(m.hard_stop_waived_at::text, 'null'), 'false · null',
       '13/set Márcio: Hapvida e Intermédica são contas reais, processar no app — sai do apagar sempre (' || m.email || ')'
  from public.marketing_senders m
 where m.email in ('boleto.notredamesp@hapvida.com.br', 'comunicacao@contato.hapvidandi.com.br',
                   'ccg@contato.comunicacaoccg.com.br', 'contato@pagoufacil.com.br')
   and (m.active or m.hard_stop_waived_at is not null);

update public.marketing_senders
   set active = false, hard_stop_waived_at = null,
       note = coalesce(note, '') || ' · 13/set/2026: SAIU do apagar sempre — Márcio: «são contas reais», processar no app.'
 where email in ('boleto.notredamesp@hapvida.com.br', 'comunicacao@contato.hapvidandi.com.br',
                 'ccg@contato.comunicacaoccg.com.br', 'contato@pagoufacil.com.br')
   and (active or hard_stop_waived_at is not null);

commit;

select email, active, hard_stop_waived_at from public.marketing_senders
 where email in ('boleto.notredamesp@hapvida.com.br', 'comunicacao@contato.hapvidandi.com.br',
                 'ccg@contato.comunicacaoccg.com.br', 'contato@pagoufacil.com.br')
 order by email;
