-- 08/10/2026 (Márcio: «deixe os pacotes HellKing e Apocalypse em CINZA, indisponíveis por enquanto»): pack que aparece na loja mas NÃO
-- pode ser comprado (card cinza, «UNAVAILABLE FOR NOW»; o checkout recusa). Reabrir = false. Tabela compartilhada com o app do BR (só coluna nova).
alter table public.packs add column if not exists shop_unavailable boolean not null default false;
comment on column public.packs.shop_unavailable is 'Shop shows the pack greyed out and refuses it at checkout (Márcio 08/10/2026: HellKing + Apocalypse unavailable for now)';
update public.packs set shop_unavailable = true
 where shop_locked = true and status = 'CLOSED' and (name ilike '%HellKing%' or name ilike '%Apocalypse%');
