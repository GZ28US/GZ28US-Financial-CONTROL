-- US.015 (Alcatraz) — as duas puxadas de 25/06/2026 foram feitas em dinamômetro do BR (ServiTec), e o registro do BR e o do US
-- divergiam. Márcio, 23/11/2026: «if it was tested in a BR dyno, keep the BR numbers; if it was tested in an US dyno, keep US
-- numbers». Valem os números do registro do BR (tabela legada do BR, copiada em scratchpad/perf-br-legado-2311 antes de apagar).
-- A Alpha170 de 24/07 só existia no banco do US e não muda.
insert into public.data_fixes (check_key, table_name, row_id, field, old_value, new_value, label)
select 'dyno-us015-numeros-br-2311', 'dyno_pulls', id::text, 'whp/wnm/bhp/bnm/loss/cf/dyno/origin',
       concat_ws(' | ', whp, wnm, bhp, bnm, loss_pct, correction_factor, dyno, origin),
       case when pack = 'BoneStock' then '486.13 | 61.51 | 703.61 | 89.03 | 24 | 1.1 | GZ28BR ServiTec | BR' else '767.07 | 103.64 | 1090.05 | 147.28 | 24 | 1.08 | ArteCarros ServiTec | BR' end,
       'US.015 ' || pack || ' — testada em dyno do BR: valem os números do BR (Márcio, 23/11/2026)'
  from public.dyno_pulls where id in ('c1d59fbe-eed6-4c9e-bd98-7cb4d3c8dc9e', 'fabe9f93-08f7-4fd7-9494-ee07a5d566e3');
update public.dyno_pulls set whp = 486.13, wnm = 61.51, bhp = 703.61, bnm = 89.03, loss_pct = 24, correction_factor = 1.1, dyno = 'GZ28BR ServiTec', origin = 'BR'
 where id = 'c1d59fbe-eed6-4c9e-bd98-7cb4d3c8dc9e' and ride_code = 'US.015';
update public.dyno_pulls set bhp = 1090.05, bnm = 147.28, loss_pct = 24
 where id = 'fabe9f93-08f7-4fd7-9494-ee07a5d566e3' and ride_code = 'US.015';
