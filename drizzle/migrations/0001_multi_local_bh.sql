-- Idempotente: pode rodar de novo sem erro (já foi aplicada manualmente via Lovable).
-- Vários locais em BH: cada gestor administra só os locais dos quais é responsável;
-- o organizador vê os horários publicados de todos os locais.

alter table public.venues add column if not exists neighborhood text not null default '';
alter table public.venues add column if not exists city text not null default 'Belo Horizonte';

create table if not exists public.venue_managers (
  venue_id uuid not null references public.venues(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (venue_id, user_id)
);
grant select on public.venue_managers to authenticated;
grant all on public.venue_managers to service_role;
alter table public.venue_managers enable row level security;
drop policy if exists "own managed venues" on public.venue_managers;
create policy "own managed venues" on public.venue_managers for select to authenticated using (user_id = auth.uid());

-- O local que já existe continua com os gestores atuais.
insert into public.venue_managers(venue_id, user_id)
  select v.id, ur.user_id from public.venues v cross join public.user_roles ur where ur.role = 'gestor'
  on conflict do nothing;

create or replace function public.manages_venue(_venue uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.venue_managers where venue_id = _venue and user_id = auth.uid())
$$;

create or replace function public.manages_court(_court uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.courts c join public.venue_managers m on m.venue_id = c.venue_id
    where c.id = _court and m.user_id = auth.uid())
$$;

create or replace function public.manages_slot(_slot uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.slots s
    join public.courts c on c.id = s.court_id
    join public.venue_managers m on m.venue_id = c.venue_id
    where s.id = _slot and m.user_id = auth.uid())
$$;

-- Permissões passam de "qualquer gestor" para "gestor deste local".
drop policy if exists "venues write" on public.venues;
drop policy if exists "venues update" on public.venues;
create policy "venues update" on public.venues for update to authenticated
  using (public.manages_venue(id)) with check (public.manages_venue(id));

drop policy if exists "courts write" on public.courts;
create policy "courts write" on public.courts for all to authenticated
  using (public.manages_venue(venue_id)) with check (public.manages_venue(venue_id));

drop policy if exists "slots read" on public.slots;
drop policy if exists "slots write" on public.slots;
create policy "slots read" on public.slots for select to authenticated
  using (published or public.manages_court(court_id));
create policy "slots write" on public.slots for all to authenticated
  using (public.manages_court(court_id)) with check (public.manages_court(court_id));

drop policy if exists "bookings read" on public.bookings;
create policy "bookings read" on public.bookings for select to authenticated
  using (organizer_id = auth.uid() or public.manages_slot(slot_id));

drop policy if exists "waitlist read" on public.waitlist;
create policy "waitlist read" on public.waitlist for select to authenticated
  using (organizer_id = auth.uid() or public.manages_slot(slot_id));

-- O gestor só vê dados de quem reservou ou entrou na fila em um local dele.
drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select to authenticated using (
  id = auth.uid()
  or exists (select 1 from public.bookings b where b.organizer_id = profiles.id and public.manages_slot(b.slot_id))
  or exists (select 1 from public.waitlist w where w.organizer_id = profiles.id and public.manages_slot(w.slot_id))
);

-- Cria um local e torna o usuário responsável por ele.
create or replace function public.create_my_venue(_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare vid uuid;
begin
  if not public.has_role(auth.uid(), 'gestor') then raise exception 'Sem permissão'; end if;
  insert into public.venues(name) values (coalesce(nullif(trim(_name), ''), 'Meu local')) returning id into vid;
  insert into public.venue_managers(venue_id, user_id) values (vid, auth.uid());
  return vid;
end $$;

-- O perfil vem da escolha no cadastro; quem escolhe "tenho quadra" já ganha um local.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  _role app_role := case when new.raw_user_meta_data->>'role' = 'gestor' then 'gestor'::app_role else 'organizador'::app_role end;
  vid uuid;
begin
  insert into public.profiles(id, name, phone, email, privacy_accepted_at)
  values (new.id, coalesce(new.raw_user_meta_data->>'name',''), coalesce(new.raw_user_meta_data->>'phone',''), coalesce(new.email,''),
    case when new.raw_user_meta_data->>'privacy' = 'true' then now() else null end);
  insert into public.user_roles(user_id, role) values (new.id, _role);
  if _role = 'gestor' then
    insert into public.venues(name, whatsapp)
      values (coalesce(nullif(trim(new.raw_user_meta_data->>'venue_name'), ''), 'Meu local'), coalesce(new.raw_user_meta_data->>'phone',''))
      returning id into vid;
    insert into public.venue_managers(venue_id, user_id) values (vid, new.id);
  end if;
  return new;
end $$;

create or replace function public.request_booking(_slot uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare s record; v record; bid uuid; was_waiting boolean;
begin
  if auth.uid() is null then raise exception 'Faça login para reservar'; end if;
  perform public.expire_bookings();
  select * into s from public.slots where id = _slot for update;
  if s is null or not s.published then raise exception 'Horário indisponível'; end if;
  if s.blocked then raise exception 'Horário ocupado'; end if;
  if s.starts_at <= now() then raise exception 'Esse horário já passou'; end if;
  if exists (select 1 from public.bookings where slot_id = _slot and status in ('pendente','confirmada')) then
    raise exception 'Alguém já solicitou esse horário'; end if;
  select v2.* into v from public.venues v2 join public.courts c on c.venue_id = v2.id where c.id = s.court_id;
  was_waiting := exists (select 1 from public.waitlist where slot_id = _slot and organizer_id = auth.uid());
  insert into public.bookings(slot_id, organizer_id, expires_at, from_waitlist)
    values (_slot, auth.uid(), least(now() + make_interval(hours => v.payment_deadline_hours), s.starts_at), was_waiting)
    returning id into bid;
  delete from public.waitlist where slot_id = _slot and organizer_id = auth.uid();
  insert into public.notifications(user_id, message, link)
    select m.user_id, 'Nova solicitação: ' || public.slot_label(_slot) || ' por ' || coalesce((select name from public.profiles where id = auth.uid()),'organizador'), '/gestor/solicitacoes'
    from public.venue_managers m where m.venue_id = v.id;
  return bid;
end $$;

create or replace function public.confirm_booking(_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  select * into b from public.bookings where id = _booking for update;
  if b is null or not public.manages_slot(b.slot_id) then raise exception 'Sem permissão'; end if;
  if b.status <> 'pendente' then raise exception 'Solicitação não está mais pendente'; end if;
  update public.bookings set status = 'confirmada', updated_at = now() where id = _booking;
  insert into public.notifications(user_id, message, link) values (b.organizer_id, 'Pagamento confirmado! Reserva garantida: ' || public.slot_label(b.slot_id), '/minhas-reservas');
end $$;

create or replace function public.reject_booking(_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  select * into b from public.bookings where id = _booking for update;
  if b is null or not public.manages_slot(b.slot_id) then raise exception 'Sem permissão'; end if;
  if b.status <> 'pendente' then raise exception 'Solicitação não está mais pendente'; end if;
  update public.bookings set status = 'recusada', updated_at = now() where id = _booking;
  insert into public.notifications(user_id, message, link) values (b.organizer_id, 'Sua solicitação para ' || public.slot_label(b.slot_id) || ' foi recusada.', '/minhas-reservas');
  perform public.notify_waitlist(b.slot_id);
end $$;

create or replace function public.cancel_booking(_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record; s record; lim int; is_g boolean;
begin
  select * into b from public.bookings where id = _booking for update;
  if b is null or b.status not in ('pendente','confirmada') then raise exception 'Reserva não pode ser cancelada'; end if;
  is_g := public.manages_slot(b.slot_id);
  select * into s from public.slots where id = b.slot_id;
  if not is_g then
    if b.organizer_id <> auth.uid() then raise exception 'Sem permissão'; end if;
    select v.cancel_limit_hours into lim from public.venues v join public.courts c on c.venue_id = v.id where c.id = s.court_id;
    if b.status = 'confirmada' and s.starts_at - now() < make_interval(hours => lim) then
      raise exception 'Cancelamento só até % horas antes do jogo. Fale com a quadra.', lim; end if;
  end if;
  update public.bookings set status = 'cancelada', updated_at = now() where id = _booking;
  if is_g and b.organizer_id <> auth.uid() then
    insert into public.notifications(user_id, message, link) values (b.organizer_id, 'Sua reserva ' || public.slot_label(b.slot_id) || ' foi cancelada pela quadra.', '/minhas-reservas');
  end if;
  perform public.notify_waitlist(b.slot_id);
end $$;

create or replace function public.set_slot_blocked(_slot uuid, _blocked boolean, _note text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.manages_slot(_slot) then raise exception 'Sem permissão'; end if;
  if _blocked and exists (select 1 from public.bookings where slot_id = _slot and status in ('pendente','confirmada')) then
    raise exception 'Horário tem reserva no app; cancele-a antes'; end if;
  update public.slots set blocked = _blocked, block_note = case when _blocked then _note else null end where id = _slot;
  if not _blocked then perform public.notify_waitlist(_slot); end if;
end $$;

drop function if exists public.generate_week(date);
create or replace function public.generate_week(_monday date, _venue uuid) returns int
language plpgsql security definer set search_path = public as $$
declare c record; d int; h int; n int := 0; k int; v record;
begin
  if not public.manages_venue(_venue) then raise exception 'Sem permissão'; end if;
  select * into v from public.venues where id = _venue;
  for c in select * from public.courts where venue_id = _venue and active loop
    for d in 0..6 loop
      for h in v.open_hour..(v.close_hour - 1) loop
        insert into public.slots(court_id, starts_at)
          values (c.id, ((_monday + d)::timestamp + make_interval(hours => h)) at time zone 'America/Sao_Paulo')
          on conflict do nothing;
        get diagnostics k = row_count;
        n := n + k;
      end loop;
    end loop;
  end loop;
  return n;
end $$;

drop function if exists public.publish_week(date, boolean);
create or replace function public.publish_week(_monday date, _venue uuid, _publish boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.manages_venue(_venue) then raise exception 'Sem permissão'; end if;
  update public.slots set published = _publish
  where court_id in (select id from public.courts where venue_id = _venue)
    and starts_at >= (_monday::timestamp at time zone 'America/Sao_Paulo')
    and starts_at < ((_monday + 7)::timestamp at time zone 'America/Sao_Paulo');
end $$;

drop function if exists public.get_agenda(date);
create or replace function public.get_agenda(_day date) returns table (
  slot_id uuid, court_id uuid, court_name text, surface text, price numeric, photo_url text,
  venue_id uuid, venue_name text, neighborhood text,
  starts_at timestamptz, state text, my_booking_id uuid, my_booking_status booking_status, in_waitlist boolean
) language plpgsql security definer set search_path = public as $$
begin
  perform public.expire_bookings();
  return query
  select s.id, c.id, c.name, c.surface, c.price_per_hour, c.photo_url,
    v.id, v.name, v.neighborhood,
    s.starts_at,
    case when s.blocked then 'ocupado'
         when exists (select 1 from public.bookings b where b.slot_id = s.id and b.status = 'confirmada') then 'ocupado'
         when exists (select 1 from public.bookings b where b.slot_id = s.id and b.status = 'pendente') then 'aguardando'
         when s.starts_at <= now() then 'passado'
         else 'livre' end,
    mb.id, mb.status,
    exists (select 1 from public.waitlist w where w.slot_id = s.id and w.organizer_id = auth.uid())
  from public.slots s
  join public.courts c on c.id = s.court_id
  join public.venues v on v.id = c.venue_id
  left join lateral (select b.id, b.status from public.bookings b where b.slot_id = s.id and b.organizer_id = auth.uid() and b.status in ('pendente','confirmada') limit 1) mb on true
  where s.published and c.active
    and s.starts_at >= (_day::timestamp at time zone 'America/Sao_Paulo')
    and s.starts_at < ((_day + 1)::timestamp at time zone 'America/Sao_Paulo')
  order by s.starts_at, v.name, c.name;
end $$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on all functions in schema public from anon;
