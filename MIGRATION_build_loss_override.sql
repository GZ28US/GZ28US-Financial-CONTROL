-- PERDA PRÓPRIA DE UM BUILD (Márcio, 13/10/2026, via AutoBook GZ28US): «O SublimeHell usa rodas 20" de HellCat WideBody,
-- sua loss deve ser a de um Hellcat WideBody, 17%, use 17% pras passagens do Build novo, mantenha o que já temos pra
-- BoneStock. Isso só pro SublimeHell.»
-- Regra geral continua: a perda do carro é a do BoneStock de referência (Lucifer, 15,5% para os D170). Um BUILD pode ter
-- perda própria quando a configuração dele muda a transmissão (rodas, câmbio) — e então ela manda nas puxadas DELE, e a
-- propagação da referência não a sobrescreve. O BoneStock fica como está.
alter table ride_builds add column if not exists loss_pct numeric;
alter table ride_builds add column if not exists loss_note text;
comment on column ride_builds.loss_pct is 'Perda própria deste build (sobrepõe a do BoneStock de referência nas puxadas do build). Null = a do carro.';

update ride_builds set loss_pct = 17, loss_note = 'rodas 20" de Hellcat WideBody — perda de Hellcat WideBody (Márcio 13/10/2026)'
where ride_code = 'US.038' and build_no = 2;

insert into data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'sublimehell-build2-loss17', 'dyno_pulls', id::text, 'loss_pct/bhp/bnm',
       coalesce(loss_pct::text, '-') || ' / ' || coalesce(bhp::text, '-') || ' / ' || coalesce(bnm::text, '-'),
       '17 / ' || coalesce(round(whp / 0.83, 2)::text, '-') || ' / ' || coalesce(round(wnm / 0.83, 2)::text, '-'),
       'SublimeHell build 2: perda de Hellcat WideBody (rodas 20") — Márcio 13/10/2026'
from dyno_pulls where ride_code = 'US.038' and build_no = 2 and imported_from is null and pack !~* '^(bonestock|stock)';

update dyno_pulls set loss_pct = 17,
  bhp = case when whp is null then null else round(whp / 0.83, 2) end,
  bnm = case when wnm is null then null else round(wnm / 0.83, 2) end
where ride_code = 'US.038' and build_no = 2 and imported_from is null and pack !~* '^(bonestock|stock)';
