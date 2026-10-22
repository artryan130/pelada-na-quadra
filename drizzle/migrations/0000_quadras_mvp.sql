create type public.app_role as enum ('gestor','organizador');
create type public.booking_status as enum ('pendente','confirmada','recusada','expirada','cancelada');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null default '',
  phone text not null default '',
  email text not null default '',
  privacy_accepted_at timestamptz,
  created_at timestamptz not null default now()
);
grant select, insert, update on public.profiles to authenticated;
grant all on public.profiles to service_role;
alter table public.profiles enable row level security;

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role app_role not null,
  unique (user_id, role)
);
grant select on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;

create or replace function public.has_role(_user_id uuid, _role app_role)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.user_roles where user_id = _user_id and role = _role) $$;

create policy "own roles" on public.user_roles for select to authenticated using (user_id = auth.uid());
create policy "own profile read" on public.profiles for select to authenticated using (id = auth.uid() or public.has_role(auth.uid(),'gestor'));
create policy "own profile update" on public.profiles for update to authenticated using (id = auth.uid());

create table public.venues (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Minha Arena',
  address text not null default '',
  pix_key text not null default '',
  whatsapp text not null default '',
  payment_deadline_hours int not null default 2,
  cancel_limit_hours int not null default 24,
  open_hour int not null default 8,
  close_hour int not null default 23,
  created_at timestamptz not null default now()
);
grant select on public.venues to anon;
grant select, insert, update on public.venues to authenticated;
grant all on public.venues to service_role;
alter table public.venues enable row level security;
create policy "venues read" on public.venues for select to anon, authenticated using (true);
create policy "venues write" on public.venues for all to authenticated using (public.has_role(auth.uid(),'gestor')) with check (public.has_role(auth.uid(),'gestor'));

create table public.courts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references public.venues(id) on delete cascade,
  name text not null,
  surface text not null default 'Grama sintética',
  photo_url text,
  price_per_hour numeric(10,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
grant select on public.courts to anon;
grant select, insert, update, delete on public.courts to authenticated;
grant all on public.courts to service_role;
alter table public.courts enable row level security;
create policy "courts read" on public.courts for select to anon, authenticated using (true);
create policy "courts write" on public.courts for all to authenticated using (public.has_role(auth.uid(),'gestor')) with check (public.has_role(auth.uid(),'gestor'));

create table public.slots (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts(id) on delete cascade,
  starts_at timestamptz not null,
  duration_min int not null default 60,
  published boolean not null default false,
  blocked boolean not null default false,
  block_note text,
  created_at timestamptz not null default now(),
  unique (court_id, starts_at)
);
grant select, insert, update, delete on public.slots to authenticated;
grant all on public.slots to service_role;
alter table public.slots enable row level security;
create policy "slots read" on public.slots for select to authenticated using (published or public.has_role(auth.uid(),'gestor'));
create policy "slots write" on public.slots for all to authenticated using (public.has_role(auth.uid(),'gestor')) with check (public.has_role(auth.uid(),'gestor'));

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.slots(id) on delete cascade,
  organizer_id uuid not null,
  status booking_status not null default 'pendente',
  from_waitlist boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
create unique index bookings_one_active on public.bookings(slot_id) where status in ('pendente','confirmada');
grant select on public.bookings to authenticated;
grant all on public.bookings to service_role;
alter table public.bookings enable row level security;
create policy "bookings read" on public.bookings for select to authenticated using (organizer_id = auth.uid() or public.has_role(auth.uid(),'gestor'));

create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  slot_id uuid not null references public.slots(id) on delete cascade,
  organizer_id uuid not null,
  created_at timestamptz not null default now(),
  notified_at timestamptz,
  unique (slot_id, organizer_id)
);
grant select, insert, delete on public.waitlist to authenticated;
grant all on public.waitlist to service_role;
alter table public.waitlist enable row level security;
create policy "waitlist read" on public.waitlist for select to authenticated using (organizer_id = auth.uid() or public.has_role(auth.uid(),'gestor'));
create policy "waitlist insert" on public.waitlist for insert to authenticated with check (organizer_id = auth.uid());
create policy "waitlist delete" on public.waitlist for delete to authenticated using (organizer_id = auth.uid());

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  message text not null,
  link text,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
grant select, update on public.notifications to authenticated;
grant all on public.notifications to service_role;
alter table public.notifications enable row level security;
create policy "notif read" on public.notifications for select to authenticated using (user_id = auth.uid());
create policy "notif update" on public.notifications for update to authenticated using (user_id = auth.uid());

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, name, phone, email, privacy_accepted_at)
  values (new.id, coalesce(new.raw_user_meta_data->>'name',''), coalesce(new.raw_user_meta_data->>'phone',''), coalesce(new.email,''),
    case when new.raw_user_meta_data->>'privacy' = 'true' then now() else null end);
  if not exists (select 1 from public.user_roles where role = 'gestor') then
    insert into public.user_roles(user_id, role) values (new.id, 'gestor');
  else
    insert into public.user_roles(user_id, role) values (new.id, 'organizador');
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.slot_label(_slot uuid) returns text language sql stable security definer set search_path = public as $$
  select c.name || ' · ' || to_char(s.starts_at at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')
  from public.slots s join public.courts c on c.id = s.court_id where s.id = _slot
$$;

create or replace function public.notify_waitlist(_slot uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.slots where id = _slot and starts_at > now()) then
    insert into public.notifications(user_id, message, link)
      select organizer_id, 'Vagou! ' || public.slot_label(_slot) || ' está livre. Quem solicitar primeiro leva.', '/agenda'
      from public.waitlist where slot_id = _slot;
    update public.waitlist set notified_at = now() where slot_id = _slot;
  end if;
end $$;

create or replace function public.expire_bookings() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in update public.bookings set status = 'expirada', updated_at = now()
    where status = 'pendente' and expires_at < now() returning id, slot_id, organizer_id
  loop
    n := n + 1;
    insert into public.notifications(user_id, message, link)
      values (r.organizer_id, 'Sua solicitação para ' || public.slot_label(r.slot_id) || ' expirou por falta de pagamento.', '/minhas-reservas');
    perform public.notify_waitlist(r.slot_id);
  end loop;
  return n;
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
    select ur.user_id, 'Nova solicitação: ' || public.slot_label(_slot) || ' por ' || coalesce((select name from public.profiles where id = auth.uid()),'organizador'), '/gestor/solicitacoes'
    from public.user_roles ur where ur.role = 'gestor';
  return bid;
end $$;

create or replace function public.confirm_booking(_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  if not public.has_role(auth.uid(),'gestor') then raise exception 'Sem permissão'; end if;
  update public.bookings set status = 'confirmada', updated_at = now() where id = _booking and status = 'pendente' returning * into b;
  if b is null then raise exception 'Solicitação não está mais pendente'; end if;
  insert into public.notifications(user_id, message, link) values (b.organizer_id, 'Pagamento confirmado! Reserva garantida: ' || public.slot_label(b.slot_id), '/minhas-reservas');
end $$;

create or replace function public.reject_booking(_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  if not public.has_role(auth.uid(),'gestor') then raise exception 'Sem permissão'; end if;
  update public.bookings set status = 'recusada', updated_at = now() where id = _booking and status = 'pendente' returning * into b;
  if b is null then raise exception 'Solicitação não está mais pendente'; end if;
  insert into public.notifications(user_id, message, link) values (b.organizer_id, 'Sua solicitação para ' || public.slot_label(b.slot_id) || ' foi recusada.', '/minhas-reservas');
  perform public.notify_waitlist(b.slot_id);
end $$;

create or replace function public.cancel_booking(_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record; s record; lim int; is_g boolean := public.has_role(auth.uid(),'gestor');
begin
  select * into b from public.bookings where id = _booking for update;
  if b is null or b.status not in ('pendente','confirmada') then raise exception 'Reserva não pode ser cancelada'; end if;
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
  if not public.has_role(auth.uid(),'gestor') then raise exception 'Sem permissão'; end if;
  if _blocked and exists (select 1 from public.bookings where slot_id = _slot and status in ('pendente','confirmada')) then
    raise exception 'Horário tem reserva no app; cancele-a antes'; end if;
  update public.slots set blocked = _blocked, block_note = case when _blocked then _note else null end where id = _slot;
  if not _blocked then perform public.notify_waitlist(_slot); end if;
end $$;

create or replace function public.generate_week(_monday date) returns int
language plpgsql security definer set search_path = public as $$
declare c record; d int; h int; n int := 0; k int; v record;
begin
  if not public.has_role(auth.uid(),'gestor') then raise exception 'Sem permissão'; end if;
  for c in select * from public.courts where active loop
    select * into v from public.venues where id = c.venue_id;
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

create or replace function public.publish_week(_monday date, _publish boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.has_role(auth.uid(),'gestor') then raise exception 'Sem permissão'; end if;
  update public.slots set published = _publish
  where starts_at >= (_monday::timestamp at time zone 'America/Sao_Paulo')
    and starts_at < ((_monday + 7)::timestamp at time zone 'America/Sao_Paulo');
end $$;

create or replace function public.get_agenda(_day date) returns table (
  slot_id uuid, court_id uuid, court_name text, surface text, price numeric, photo_url text,
  starts_at timestamptz, state text, my_booking_id uuid, my_booking_status booking_status, in_waitlist boolean
) language plpgsql security definer set search_path = public as $$
begin
  perform public.expire_bookings();
  return query
  select s.id, c.id, c.name, c.surface, c.price_per_hour, c.photo_url, s.starts_at,
    case when s.blocked then 'ocupado'
         when exists (select 1 from public.bookings b where b.slot_id = s.id and b.status = 'confirmada') then 'ocupado'
         when exists (select 1 from public.bookings b where b.slot_id = s.id and b.status = 'pendente') then 'aguardando'
         when s.starts_at <= now() then 'passado'
         else 'livre' end,
    mb.id, mb.status,
    exists (select 1 from public.waitlist w where w.slot_id = s.id and w.organizer_id = auth.uid())
  from public.slots s join public.courts c on c.id = s.court_id
  left join lateral (select b.id, b.status from public.bookings b where b.slot_id = s.id and b.organizer_id = auth.uid() and b.status in ('pendente','confirmada') limit 1) mb on true
  where s.published and c.active
    and s.starts_at >= (_day::timestamp at time zone 'America/Sao_Paulo')
    and s.starts_at < ((_day + 1)::timestamp at time zone 'America/Sao_Paulo')
  order by s.starts_at, c.name;
end $$;

revoke execute on function public.notify_waitlist(uuid) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on all functions in schema public from anon;

with v as (insert into public.venues(name, address, pix_key) values ('Arena Society', 'Endereço a definir', 'pix@arena.com') returning id)
insert into public.courts(venue_id, name, surface, price_per_hour)
select v.id, x.n, 'Grama sintética', x.p from v, (values ('Quadra 1',180),('Quadra 2',180),('Quadra 3',200),('Quadra 4',200)) as x(n,p);

alter publication supabase_realtime add table public.notifications;