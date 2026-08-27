-- MIGRATION — PASSAPORTE NO CADASTRO DE STAFF (Márcio, 27/ago/2026:
-- "inclua o campo passaporte e data de expiração no cadastro do staff").
--
-- POR QUE DUAS COLUNAS NOVAS, e não o campo `cpf` que já existe: para staff
-- estrangeiro é o PASSAPORTE que é o documento de identidade — o Eliel (US.012)
-- entrou com GN633265 e não tem SSN. Enfiar passaporte no campo de CPF quebra a
-- lei de um campo por informação, e a validade não teria onde morar. Validade é
-- dado operacional de verdade: passaporte vencido trava embarque e visto.
--
-- Ambas são OPCIONAIS: staff americano não tem passaporte e o formulário não
-- pode travar por causa disso.

begin;

alter table public.staff add column if not exists passport        text;
alter table public.staff add column if not exists passport_expiry date;

-- As RPCs do self-service ganham os dois campos. Como a lista de argumentos do
-- update muda, CREATE OR REPLACE criaria uma SOBRECARGA e o PostgREST passaria a
-- responder "could not choose the best candidate function". Então derrubamos
-- todas as versões pelo catálogo — sem depender da assinatura antiga.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('staff_self_get', 'staff_self_update')
  loop
    execute 'drop function ' || r.sig;
  end loop;
end $$;

create or replace function public.staff_self_get(p_id uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object(
    'name', name, 'email', email, 'instagram', instagram, 'phone', phone,
    'cpf', cpf, 'birth_date', birth_date,
    'passport', passport, 'passport_expiry', passport_expiry,
    'zip', zip, 'address', address, 'city', city, 'state', state,
    'preferred_message_method', preferred_message_method
  )
  from public.staff where id = p_id;
$$;

create or replace function public.staff_self_update(
  p_id uuid, p_name text, p_email text, p_instagram text, p_phone text,
  p_cpf text, p_birth_date date, p_passport text, p_passport_expiry date,
  p_zip text, p_address text, p_city text, p_state text, p_preferred text
) returns void language sql security definer set search_path = public as $$
  update public.staff set
    name = p_name, email = p_email, instagram = p_instagram, phone = p_phone,
    cpf = p_cpf, birth_date = p_birth_date,
    passport = p_passport, passport_expiry = p_passport_expiry,
    zip = p_zip, address = p_address, city = p_city, state = p_state,
    preferred_message_method = p_preferred, updated_at = now()
  where id = p_id;
$$;

-- anon (+ authenticated) só pode EXECUTAR as duas; acesso à tabela continua fechado.
grant execute on function
  public.staff_self_get(uuid),
  public.staff_self_update(uuid,text,text,text,text,text,date,text,date,text,text,text,text,text)
to anon, authenticated;

commit;

-- O passaporte do Eliel, que ele já mandou no WhatsApp em 27/ago.
update public.staff set passport = 'GN633265' where staff_code = 'US.012' and passport is null;
