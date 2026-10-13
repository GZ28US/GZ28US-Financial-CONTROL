-- AutoBook / e-mail: regra por PALAVRA DO ITEM (Márcio 13/10/2026, via AutoBook GZ28US: «libera, mas monitoramos aqui,
-- pra ir calibrando ele caso erre»). A correção de um lançamento automático vira regra por fornecedor e/ou por palavra
-- do nome do item («hdmi» → assets), para o robô não repetir o erro.
alter table auto_book_mail_rules add column if not exists match_item text;
comment on column auto_book_mail_rules.match_item is 'Palavra (sem maiúsculas) que o nome do item lido do e-mail tem de conter para a regra valer.';
