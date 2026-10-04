-- PARTS DB «GZ28 SHOP LOCKED» (Márcio, 04/10/2026, pedido vindo da sessão Parts & Packs):
-- «The parts from the pack here should be in the app as GZ28 Shop LOCKED as well, not deletable or editable there, only
-- from here, with these exact same infos, LOCKED.»
-- As peças usadas nos packs da vitrine da loja ficam congeladas no Parts DB: só a sessão Parts & Packs (chave de serviço)
-- mexe. Mesmo desenho de packs.shop_locked (MIGRATION_packs_shop_locked.sql): trava DE BANCO — usuário do app
-- (authenticated/anon, US e ponte do BR) recebe erro ao editar ou apagar peça travada e não liga a marca; service_role e SQL
-- direto passam. É OUTRA coisa que o cadeado antigo (locked_at): aquele o próprio usuário liga e desliga na tela e a compra
-- real do mesmo fornecedor atualiza o custo; ESTA não — decisão dele no mesmo dia: compra real NÃO toca na peça travada da
-- loja, e o app fica calado («Don't touch, stay silent»). O enroller (lib/partsDb.ts) e os robôs de categoria/fornecedor
-- pulam essas peças no código, porque os robôs do servidor usam a chave de serviço e passariam pelo trigger.
begin;

alter table public.parts_database add column if not exists shop_locked boolean not null default false;

create or replace function public.parts_shop_lock_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  papel text := auth.role();
begin
  if papel is null or papel = 'service_role' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.shop_locked then
      raise exception 'GZ28 SHOP LOCKED — this part cannot be deleted in the app (only through the Parts & Packs session)' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.shop_locked then
    raise exception 'GZ28 SHOP LOCKED — this part cannot be edited in the app (only through the Parts & Packs session)' using errcode = '42501';
  end if;
  if new.shop_locked then
    raise exception 'GZ28 SHOP LOCKED can only be set through the Parts & Packs session' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger parts_shop_lock_guard
  before insert or update or delete on public.parts_database
  for each row execute function public.parts_shop_lock_guard();

-- As 4 primeiras (bloco TUNE dos 36 packs), conferidas antes: PCM-00-000, UC-0000, H-002-01, RTD.
update public.parts_database set shop_locked = true where id in (
  'd782b2b6-5b82-4174-9f04-abf03216bb35','f9751f1b-2fe8-46e2-af0c-0ad7c493b570',
  'a337c0c6-df0f-49a0-937c-5aec8c9e4b3a','503959e6-b60a-4759-aa64-f0b2eeac7270'
);

commit;
