-- DUTY COMPARTILHADA (Márcio, 01/10/2026, via Staff Cronogram): «permitir adicionar mais de um homem
-- pra uma tarefa, daí a mesma duty aparece pros 2, e quem abrir primeiro, some a tarefa pro outro, fica
-- pra ele.» Caso: duties do Jeff (deportado) redistribuídas entre Eliel e Vanza.
--
-- staff_id continua sendo o DONO. shared_staff_ids = os OUTROS homens que também podem pegar a duty
-- enquanto ninguém deu START (o dono não se repete aqui — sem campo duplicado). No primeiro START,
-- duty_take() passa a duty para quem apertou e limpa a lista: ela some da lista dos outros. A troca é
-- atômica (UPDATE com condição): dois START ao mesmo tempo → só um pega, o outro recebe false.
begin;

alter table invoice_duties add column if not exists shared_staff_ids uuid[];
comment on column invoice_duties.shared_staff_ids is
  'Outros homens que podem pegar a duty antes do 1º START (o dono fica em staff_id). duty_take() passa a duty a quem deu START e limpa. 01/10/2026.';

create or replace function public.duty_take(p_id uuid, p_staff_id uuid)
returns boolean language sql security definer set search_path to 'public' as $$
  with t as (
    update public.invoice_duties
       set staff_id = p_staff_id, shared_staff_ids = null
     where id = p_id
       and (staff_id = p_staff_id or p_staff_id = any(coalesce(shared_staff_ids, '{}'::uuid[])))
       and (work_started_at is null or staff_id = p_staff_id)
    returning 1
  )
  select exists (select 1 from t);
$$;
grant execute on function public.duty_take(uuid, uuid) to anon, authenticated;

create or replace function public.duties_self_load(p_staff_id uuid)
returns jsonb language sql security definer set search_path to 'public' as $function$
  select case when s.id is null then null else jsonb_build_object(
    'staff', jsonb_build_object('name', s.name, 'phone', s.phone),
    'duties', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', d.id, 'description', d.description, 'done', d.done,
        'priority', d.priority, 'time_seconds', d.time_seconds,
        'time_started_at', d.time_started_at, 'work_started_at', d.work_started_at,
        'work_ended_at', d.work_ended_at, 'invoice_code', i.invoice_code,
        'ride_project_code', r.project_code, 'ride_project_name', r.project_name,
        'delivery_date', i.delivery_date, 'conclusion_date', i.conclusion_date,
        'shared_with', case when coalesce(array_length(d.shared_staff_ids, 1), 0) > 0 then
          (select jsonb_agg(st.name order by st.name) from public.staff st
            where (st.id = d.staff_id or st.id = any(d.shared_staff_ids)) and st.id <> p_staff_id) end
      ) order by d.created_at asc)
      from public.invoice_duties d
      left join public.invoices i on i.id = d.invoice_id
      left join public.rides r on r.id = i.ride_id
      where d.staff_id = p_staff_id
         or (p_staff_id = any(coalesce(d.shared_staff_ids, '{}'::uuid[])) and d.work_started_at is null and not d.done)
    ), '[]'::jsonb)
  ) end
  from (select * from public.staff where id = p_staff_id) s;
$function$;

commit;
