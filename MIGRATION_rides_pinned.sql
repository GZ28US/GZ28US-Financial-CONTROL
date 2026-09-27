-- rides.pinned — código do carro FIXO (pedido da AutoBook GZ28US, aprovado pelo Márcio em
-- 27/09/2026: «everything»). Pinned = o número nunca é sugerido a outro carro, nunca é
-- realocado numa renumeração e nunca é liberado; a tela mostra 📌. A AutoBook marca os
-- pinned depois (SC.028, US.033, SC.057, SC.062, SC.170). Só app US.
begin;
alter table rides add column if not exists pinned boolean not null default false;
comment on column rides.pinned is
  'Código FIXO: nunca sugerido, nunca realocado, nunca liberado (renumeração e carro novo pulam). 📌 nas telas. 27/09/2026.';
commit;
select count(*) filter (where pinned) as pinned, count(*) as rides from rides;
