-- QUOTE PORTAL M3 (06/11/2026): PROMISED TO = invoices.expected_conclusion_date (C-23). duties_self_load gains the key; delivery_date stays (additive).
CREATE OR REPLACE FUNCTION public.duties_self_load(p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        'expected_conclusion_date', i.expected_conclusion_date,
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
