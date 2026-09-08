-- A DISPENSA ENSINA (BL 1.2.0, 8/set/2026). Rode UMA vez no SQL Editor do projeto US. Idempotente.
--
-- «IGNORAR» na pergunta do motor marcava as linhas de hoje e o fornecedor voltava a perguntar
-- no mês seguinte (levantamento de 8/set). Agora IGNORAR também vira regra HUMANA com padrão,
-- alvo IGNORE: a próxima linha do mesmo comerciante nasce IGNORED, com trilha — sem perguntar.
alter table public.bank_merchant_rules drop constraint if exists bank_merchant_rules_target_check;
alter table public.bank_merchant_rules add constraint bank_merchant_rules_target_check check (target in ('FIXED_EXPENSE','INPUT','TRANSFER','BUCKET','IGNORE'));
alter table public.bank_merchant_rules drop constraint if exists bank_merchant_rules_ignore_check;
alter table public.bank_merchant_rules add constraint bank_merchant_rules_ignore_check check (target <> 'IGNORE' or (origin = 'HUMAN' and pattern is not null));

-- Conferência (só leitura):
--   select label, pattern from public.bank_merchant_rules where target = 'IGNORE';
