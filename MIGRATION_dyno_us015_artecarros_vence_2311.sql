-- US.015 (Alcatraz) — Márcio, 23/11/2026: «It was never tested at the GZ28BR ServiTec, ArteCarros wins».
-- O registro legado do BR dizia «GZ28BR ServiTec» na BoneStock; o carro nunca passou por lá. Voltam os números que o banco
-- do US tinha (todas as puxadas na ArteCarros ServiTec, 20% de perda), desfazendo o MIGRATION_dyno_us015_numeros_br_2311.sql.
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'dyno-us015-artecarros-vence-2311', 'dyno_pulls', id::text, 'whp/wnm/bhp/bnm/loss/cf/dyno/origin',
       concat_ws(' | ', whp, wnm, bhp, bnm, loss_pct, correction_factor, dyno, origin),
       case when pack = 'BoneStock' then '568.00 | 516.00 | 710 | 645 | 20 | (sem fator) | ArteCarros ServiTec | US' else '767.07 | 103.64 | 1035.54 | 139.91 | 20 | 1.08 | ArteCarros ServiTec | BR' end,
       'US.015 ' || pack || ' — nunca testada na GZ28BR ServiTec: vale o registro da ArteCarros (Márcio, 23/11/2026)'
  from public.dyno_pulls where id in ('c1d59fbe-eed6-4c9e-bd98-7cb4d3c8dc9e', 'fabe9f93-08f7-4fd7-9494-ee07a5d566e3');
update public.dyno_pulls set whp = 568.00, wnm = 516.00, bhp = 710, bnm = 645, loss_pct = 20, correction_factor = null, dyno = 'ArteCarros ServiTec', origin = 'US'
 where id = 'c1d59fbe-eed6-4c9e-bd98-7cb4d3c8dc9e' and ride_code = 'US.015';
update public.dyno_pulls set bhp = 1035.54, bnm = 139.91, loss_pct = 20
 where id = 'fabe9f93-08f7-4fd7-9494-ee07a5d566e3' and ride_code = 'US.015';
