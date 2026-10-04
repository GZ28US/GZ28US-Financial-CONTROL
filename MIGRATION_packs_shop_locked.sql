-- PACKS «GZ28 SHOP LOCKED» (Márcio, 04/10/2026, pedido vindo da sessão Parts & Packs):
-- «Mark these packs as GZ28 Shop LOCKED, not editable/deletable in the app, only through here.»
-- 36 packs novos (6 tiers × 6 car_groups) são a vitrine da loja: quem mexe neles é só a sessão Parts & Packs, pela chave
-- de serviço. A trava é DE BANCO, não só de tela: usuário do app (authenticated — o do US e o da ponte do BR) recebe erro ao
-- editar ou apagar pack travado, e também não consegue ligar nem desligar a marca. service_role e SQL direto passam.
-- Ler continua livre (lista, VIEW, aplicar numa quote). Os packs antigos da escada não entram.
begin;

alter table public.packs add column if not exists shop_locked boolean not null default false;

create or replace function public.packs_shop_lock_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  papel text := auth.role();
begin
  -- Quem NÃO é usuário do app passa: chave de serviço (Parts & Packs) e SQL direto (migration, sem JWT).
  if papel is null or papel = 'service_role' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.shop_locked then
      raise exception 'GZ28 SHOP LOCKED — this pack cannot be deleted in the app (only through the Parts & Packs session)' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.shop_locked then
    raise exception 'GZ28 SHOP LOCKED — this pack cannot be edited in the app (only through the Parts & Packs session)' using errcode = '42501';
  end if;
  -- INSERT, ou UPDATE de pack livre: o app não liga a marca.
  if new.shop_locked then
    raise exception 'GZ28 SHOP LOCKED can only be set through the Parts & Packs session' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger packs_shop_lock_guard
  before insert or update or delete on public.packs
  for each row execute function public.packs_shop_lock_guard();

-- Os 36 da sessão Parts & Packs (grupo 1→6, tier UnChained→Apocalypse). Conferidos antes: existem, zone US, MOPAR CAT, DRAFT, vazios.
update public.packs set shop_locked = true where id in (
  '3932bae0-9c91-48e9-ac37-a838eb220b9b','1a2149c2-22ac-40a1-97be-8399e8cfb80b','b765343c-2b89-45b4-a05e-8b10b114ab98','77650fd2-16ce-4066-a4c6-bc3795b4aa30',
  'bfc72d22-965c-4125-9d82-398bd4ab7851','f92b9af1-ba40-43a2-980f-0584d00cfe1f','ef8b4b06-8b1a-4708-8fe2-69d4597c91da','7133d0f3-7faa-47cc-a135-48f3effb38ee',
  '70a01c89-468a-480f-a394-0e3086dcc706','f0ee3ea0-4d33-4e81-b9ee-1a0761ca4925','3a1e78df-ea35-4b02-a4ba-cbbcf8f774c2','39acde64-97ee-4084-acca-cc3425e7b0b4',
  '2e48d133-87a9-449c-a9d3-b98877bfbc13','1f3ed45a-f690-444e-ada3-5db0bb8c548f','a5eddb0f-0d35-44ea-9af7-cec50f588c7a','1745dde6-3825-476b-b45a-45f5002502fd',
  '18d0b724-3465-4623-a6e3-ea02492d02ba','6e95aae6-3cf8-46db-ad31-e04ab4772f80','37efaa95-f6d6-4683-b69d-ecbc5e386728','2a402ea3-fbf8-4f43-b076-7a1f9b72e6d8',
  '6d97f2f3-0747-480f-9c22-7d4c732bc13a','6e09f8de-2639-414c-8ef1-4afe541aaa1a','16f264b0-d23a-4839-bf80-506aa71af02e','37e1a3d3-7078-4398-bdd6-954a699e01e1',
  '21f89ec4-75f1-43ea-a0cc-5f4ab5dc1797','a5bb54ac-e6f5-4800-8e8c-5a57bdb4a544','666a252c-8376-4014-9397-7f6045941df3','0580c6b6-edab-49fb-ae3c-24f9b3898688',
  '45dcc4ba-6870-4be6-ae32-b034efb1a6b4','1ac15de7-c5f7-4618-900a-a305a40147b8','211a9211-e35b-4eb2-a32e-d84d3c1bbcc1','8ae809b5-82ae-4f25-bf68-24f2e4ee40b8',
  '4d291de8-4c88-4575-9a61-9eabd0bdc111','c9825a90-a739-48a7-8173-e71fdb79de9c','bce24eac-eabb-4fc9-8e46-12a5e5658800','9b81ea73-9abf-48b6-a973-11181055e283'
);

commit;
