-- CNPJ obrigatório para quem cadastra um local. Aceita o formato alfanumérico
-- (12 caracteres [0-9A-Z] + 2 dígitos verificadores) em vigor desde julho de 2026.
-- Idempotente: pode rodar de novo sem erro.

create or replace function public.normalize_cnpj(_v text) returns text
language sql immutable set search_path = public as $$
  select upper(regexp_replace(coalesce(_v, ''), '[^0-9A-Za-z]', '', 'g'))
$$;

-- Cada caractere vale seu código ASCII menos 48 (dígitos mantêm o valor; A=17 … Z=42).
create or replace function public.is_valid_cnpj(_v text) returns boolean
language plpgsql immutable set search_path = public as $$
declare
  c text := public.normalize_cnpj(_v);
  w1 int[] := array[5,4,3,2,9,8,7,6,5,4,3,2];
  w2 int[] := array[6,5,4,3,2,9,8,7,6,5,4,3,2];
  s int; i int; d1 int; d2 int;
begin
  if c !~ '^[0-9A-Z]{12}[0-9]{2}$' or c ~ '^(.)\1{13}$' then return false; end if;
  s := 0;
  for i in 1..12 loop s := s + (ascii(substr(c, i, 1)) - 48) * w1[i]; end loop;
  d1 := case when s % 11 < 2 then 0 else 11 - s % 11 end;
  s := d1 * w2[13];
  for i in 1..12 loop s := s + (ascii(substr(c, i, 1)) - 48) * w2[i]; end loop;
  d2 := case when s % 11 < 2 then 0 else 11 - s % 11 end;
  return substr(c, 13, 1)::int = d1 and substr(c, 14, 1)::int = d2;
end $$;

-- Locais já existentes ficam sem CNPJ até o gestor preencher na Configuração.
alter table public.venues add column if not exists cnpj text;
alter table public.venues drop constraint if exists venues_cnpj_valid;
alter table public.venues add constraint venues_cnpj_valid
  check (cnpj is null or (cnpj = public.normalize_cnpj(cnpj) and public.is_valid_cnpj(cnpj)));
create unique index if not exists venues_cnpj_unique on public.venues(cnpj) where cnpj is not null;

-- Usado no cadastro (antes do login) para avisar que o CNPJ já tem local.
create or replace function public.cnpj_in_use(_cnpj text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.venues where cnpj = public.normalize_cnpj(_cnpj))
$$;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  _role app_role := case when new.raw_user_meta_data->>'role' = 'gestor' then 'gestor'::app_role else 'organizador'::app_role end;
  _cnpj text := public.normalize_cnpj(new.raw_user_meta_data->>'cnpj');
  vid uuid;
begin
  if _role = 'gestor' and not public.is_valid_cnpj(_cnpj) then
    raise exception 'CNPJ inválido';
  end if;
  insert into public.profiles(id, name, phone, email, privacy_accepted_at)
  values (new.id, coalesce(new.raw_user_meta_data->>'name',''), coalesce(new.raw_user_meta_data->>'phone',''), coalesce(new.email,''),
    case when new.raw_user_meta_data->>'privacy' = 'true' then now() else null end);
  insert into public.user_roles(user_id, role) values (new.id, _role);
  if _role = 'gestor' then
    insert into public.venues(name, whatsapp, cnpj)
      values (coalesce(nullif(trim(new.raw_user_meta_data->>'venue_name'), ''), 'Meu local'), coalesce(new.raw_user_meta_data->>'phone',''), _cnpj)
      returning id into vid;
    insert into public.venue_managers(venue_id, user_id) values (vid, new.id);
  end if;
  return new;
end $$;

drop function if exists public.create_my_venue(text);
create or replace function public.create_my_venue(_name text, _cnpj text) returns uuid
language plpgsql security definer set search_path = public as $$
declare vid uuid;
begin
  if not public.has_role(auth.uid(), 'gestor') then raise exception 'Sem permissão'; end if;
  if not public.is_valid_cnpj(_cnpj) then raise exception 'CNPJ inválido'; end if;
  if public.cnpj_in_use(_cnpj) then raise exception 'Esse CNPJ já tem um local cadastrado'; end if;
  insert into public.venues(name, cnpj) values (coalesce(nullif(trim(_name), ''), 'Meu local'), public.normalize_cnpj(_cnpj))
    returning id into vid;
  insert into public.venue_managers(venue_id, user_id) values (vid, auth.uid());
  return vid;
end $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on all functions in schema public from anon;
grant execute on function public.cnpj_in_use(text) to anon, authenticated;
