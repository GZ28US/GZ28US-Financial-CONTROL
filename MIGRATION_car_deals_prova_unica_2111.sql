-- UMA INFO, UM CAMPO (lei do Márcio, 21/11/2026) — o COMPROVANTE mora num lugar só: deal_documents.
-- Antes a mesma URL ia em deal_movements.receipt_urls (selo NO PROOF) E em deal_documents.file_url (aba DOCUMENTS).
-- Agora: documento com movement_id = prova daquele movimento (aparece em todo deal em que ele foi alocado);
-- documento com deal_id = papel do carro (título, proforma, BL…). «Sem prova» = não há documento com o movement_id.
alter table public.deal_documents add column if not exists movement_id uuid references public.deal_movements(id) on delete cascade;
alter table public.deal_documents alter column deal_id drop not null;
do $$ begin
  alter table public.deal_documents add constraint deal_documents_dono_chk check (deal_id is not null or movement_id is not null);
exception when duplicate_object then null; end $$;
create index if not exists deal_documents_mov_idx on public.deal_documents (movement_id);

-- o que já estava gravado em dobro vira um registro só
update public.deal_documents d set movement_id = m.id
  from public.deal_movements m where d.movement_id is null and m.receipt_urls ? d.file_url;
insert into public.deal_documents (movement_id, kind, file_url)
select m.id, 'PAYMENT_PROOF', u.url
  from public.deal_movements m, jsonb_array_elements_text(m.receipt_urls) u(url)
 where not exists (select 1 from public.deal_documents d where d.movement_id = m.id and d.file_url = u.url);

alter table public.deal_movements drop column if exists receipt_urls;

-- edição do carro: uma grafia só (a do catálogo, lib/carData.ts: «JailBreak»)
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'edicao-jailbreak-grafia', 'rides', id::text, 'special_edition', special_edition, 'JailBreak', coalesce(project_code, '') || ' — edição na grafia do catálogo (21/11/2026)'
  from public.rides where special_edition = 'Jailbreak';
update public.rides set special_edition = 'JailBreak' where special_edition = 'Jailbreak';
