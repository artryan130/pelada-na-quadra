-- Reserva por intervalo (fase 2).
-- Reservas, bloqueios e fila de espera passam a ter quadra + início + fim, em
-- múltiplos de 30 min. A publicação vira "semana publicada por local" e a grade
-- do gestor sai do funcionamento de cada quadra, então "gerar horários" acaba.
-- Os slots de 1h ficam só como histórico; os dados existentes são copiados.
-- Idempotente: pode rodar de novo sem erro.

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------- reservas

alter table public.bookings add column if not exists court_id uuid references public.courts(id) on delete cascade;
alter table public.bookings add column if not exists starts_at timestamptz;
alter table public.bookings add column if not exists ends_at timestamptz;
update public.bookings b
  set court_id = s.court_id, starts_at = s.starts_at, ends_at = s.starts_at + make_interval(mins => s.duration_min)
  from public.slots s
  where s.id = b.slot_id and b.court_id is null;
alter table public.bookings alter column court_id set not null;
alter table public.bookings alter column starts_at set not null;
alter table public.bookings alter column ends_at set not null;
alter table public.bookings alter column slot_id drop not null;
alter table public.bookings drop constraint if exists bookings_intervalo_valido;
alter table public.bookings add constraint bookings_intervalo_valido check (starts_at < ends_at);

-- Uma quadra, uma reserva ativa por vez: nenhuma pendente/confirmada pode se sobrepor.
drop index if exists public.bookings_one_active;
alter table public.bookings drop constraint if exists bookings_sem_sobreposicao;
alter table public.bookings add constraint bookings_sem_sobreposicao
  exclude using gist (court_id with =, tstzrange(starts_at, ends_at) with &&)
  where (status in ('pendente', 'confirmada'));
create index if not exists bookings_organizer on public.bookings(organizer_id, starts_at);
create index if not exists bookings_pendentes on public.bookings(expires_at) where status = 'pendente';

-- ---------------------------------------------------------------- bloqueios do dono

create table if not exists public.bloqueios (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  nota text,
  created_by uuid,
  created_at timestamptz not null default now(),
  check (starts_at < ends_at)
);
create index if not exists bloqueios_court_periodo on public.bloqueios using gist (court_id, tstzrange(starts_at, ends_at));

insert into public.bloqueios(court_id, starts_at, ends_at, nota)
  select s.court_id, s.starts_at, s.starts_at + make_interval(mins => s.duration_min), s.block_note
  from public.slots s
  where s.blocked
    and not exists (select 1 from public.bloqueios b where b.court_id = s.court_id and b.starts_at = s.starts_at);

grant select on public.bloqueios to authenticated;
grant all on public.bloqueios to service_role;
alter table public.bloqueios enable row level security;
drop policy if exists "bloqueios gestor" on public.bloqueios;
create policy "bloqueios gestor" on public.bloqueios for select to authenticated using (public.manages_court(court_id));

-- ---------------------------------------------------------------- semanas publicadas

create table if not exists public.semanas_publicadas (
  venue_id uuid not null references public.venues(id) on delete cascade,
  segunda date not null check (extract(isodow from segunda) = 1),
  publicada_em timestamptz not null default now(),
  primary key (venue_id, segunda)
);
insert into public.semanas_publicadas(venue_id, segunda)
  select distinct c.venue_id, x.dia - (extract(isodow from x.dia)::int - 1)
  from (select s.court_id, (s.starts_at at time zone 'America/Sao_Paulo')::date dia from public.slots s where s.published) x
  join public.courts c on c.id = x.court_id
  on conflict do nothing;

grant select on public.semanas_publicadas to anon, authenticated;
grant all on public.semanas_publicadas to service_role;
alter table public.semanas_publicadas enable row level security;
drop policy if exists "semanas read" on public.semanas_publicadas;
create policy "semanas read" on public.semanas_publicadas for select to anon, authenticated using (true);

-- ---------------------------------------------------------------- fila de espera

alter table public.waitlist add column if not exists court_id uuid references public.courts(id) on delete cascade;
alter table public.waitlist add column if not exists starts_at timestamptz;
alter table public.waitlist add column if not exists ends_at timestamptz;
update public.waitlist w
  set court_id = s.court_id, starts_at = s.starts_at, ends_at = s.starts_at + make_interval(mins => s.duration_min)
  from public.slots s
  where s.id = w.slot_id and w.court_id is null;
alter table public.waitlist alter column court_id set not null;
alter table public.waitlist alter column starts_at set not null;
alter table public.waitlist alter column ends_at set not null;
alter table public.waitlist alter column slot_id drop not null;
create unique index if not exists waitlist_um_por_intervalo on public.waitlist(court_id, organizer_id, starts_at, ends_at);
create index if not exists waitlist_court_periodo on public.waitlist using gist (court_id, tstzrange(starts_at, ends_at));

-- Entrar na fila agora é pela função entrar_fila, que valida o intervalo.
drop policy if exists "waitlist insert" on public.waitlist;
revoke insert on public.waitlist from authenticated;

-- ---------------------------------------------------------------- permissões por quadra

drop policy if exists "bookings read" on public.bookings;
create policy "bookings read" on public.bookings for select to authenticated
  using (organizer_id = auth.uid() or public.manages_court(court_id));

drop policy if exists "waitlist read" on public.waitlist;
create policy "waitlist read" on public.waitlist for select to authenticated
  using (organizer_id = auth.uid() or public.manages_court(court_id));

drop policy if exists "own profile read" on public.profiles;
create policy "own profile read" on public.profiles for select to authenticated using (
  id = auth.uid()
  or exists (select 1 from public.bookings b where b.organizer_id = profiles.id and public.manages_court(b.court_id))
  or exists (select 1 from public.waitlist w where w.organizer_id = profiles.id and public.manages_court(w.court_id))
);

-- ---------------------------------------------------------------- funções antigas (por slot)

drop function if exists public.request_booking(uuid);
drop function if exists public.set_slot_blocked(uuid, boolean, text);
drop function if exists public.generate_week(date, uuid);
drop function if exists public.get_agenda(date);
drop function if exists public.notify_waitlist(uuid);
drop function if exists public.slot_label(uuid);

-- ---------------------------------------------------------------- textos e links

create or replace function public.reserva_label(_court uuid, _inicio timestamptz, _fim timestamptz) returns text
language sql stable security definer set search_path = public as $$
  select v.name || ' · ' || c.name || ' · '
    || to_char(_inicio at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI') || '–'
    || to_char(_fim at time zone 'America/Sao_Paulo', 'HH24:MI')
  from public.courts c join public.venues v on v.id = c.venue_id where c.id = _court
$$;

-- Abre a tela da quadra com o intervalo já escolhido.
create or replace function public.quadra_link(_court uuid, _inicio timestamptz, _fim timestamptz) returns text
language sql immutable as $$
  select '/quadra/' || _court || '?inicio=' || to_char(_inicio at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    || '&duracao=' || (extract(epoch from _fim - _inicio) / 60)::int
$$;

create or replace function public.motivo_texto(_motivo text) returns text
language sql immutable as $$
  select case _motivo
    when 'passado' then 'Esse horário já passou.'
    when 'antecedencia' then 'Esse horário está perto demais: a quadra pede mais antecedência.'
    when 'nao_publicado' then 'A quadra ainda não abriu a agenda dessa semana.'
    when 'fechado' then 'A quadra está fechada em parte desse horário.'
    when 'mensalista' then 'Esse horário é de um mensalista.'
    when 'sem_preco' then 'A quadra ainda não cadastrou o preço desse horário.'
    when 'bloqueado' then 'A quadra marcou esse horário como ocupado.'
    when 'reservado' then 'Alguém já pediu esse horário.'
    when 'quadra_indisponivel' then 'Essa quadra não está recebendo reservas.'
    else 'Horário inválido.' end
$$;

-- ---------------------------------------------------------------- disponibilidade

-- Mesmas regras da fase 1, agora lendo reservas e bloqueios por intervalo e exigindo
-- semana publicada. motivo: horario_invalido | quadra_indisponivel | passado |
-- antecedencia | nao_publicado | fechado | mensalista | sem_preco | bloqueado | reservado
create or replace function public.disponibilidade_quadra(_court uuid, _inicio timestamptz, _fim timestamptz)
returns table (livre boolean, motivo text, preco_total numeric)
language plpgsql security definer set search_path = public as $$
declare
  q record; b record; p numeric; total numeric := 0;
  local_inicio timestamp := _inicio at time zone 'America/Sao_Paulo';
begin
  if _fim <= _inicio or (extract(epoch from _fim - _inicio))::int % 1800 <> 0
     or extract(minute from local_inicio)::int % 30 <> 0 or extract(second from local_inicio) <> 0 then
    return query select false, 'horario_invalido'::text, null::numeric; return;
  end if;

  select co.active, co.venue_id, v.antecedencia_min_minutos into q
  from public.courts co join public.venues v on v.id = co.venue_id where co.id = _court;
  if not found or not q.active then
    return query select false, 'quadra_indisponivel'::text, null::numeric; return;
  end if;
  if _inicio <= now() then
    return query select false, 'passado'::text, null::numeric; return;
  end if;
  if _inicio < now() + make_interval(mins => q.antecedencia_min_minutos) then
    return query select false, 'antecedencia'::text, null::numeric; return;
  end if;

  for b in select * from public.blocos_30(_inicio, _fim) loop
    if not exists (
      select 1 from public.semanas_publicadas sp
      where sp.venue_id = q.venue_id and sp.segunda = b.dia - (extract(isodow from b.dia)::int - 1)
    ) then
      return query select false, 'nao_publicado'::text, null::numeric; return;
    end if;
    if not exists (
      select 1 from public.horarios_funcionamento h
      where h.court_id = _court and h.dia_semana = b.dow
        and public.minutos(h.abre) <= b.minuto and b.minuto + 30 <= public.minutos(h.fecha)
    ) then
      return query select false, 'fechado'::text, null::numeric; return;
    end if;
    if exists (
      select 1 from public.mensalistas m
      where m.court_id = _court and m.dia_semana = b.dow
        and public.minutos(m.inicio) < b.minuto + 30 and public.minutos(m.fim) > b.minuto
        and m.valido_de <= b.dia and (m.valido_ate is null or m.valido_ate >= b.dia)
    ) then
      return query select false, 'mensalista'::text, null::numeric; return;
    end if;
    p := public.preco_bloco(_court, b.dow, b.minuto);
    if p is null then
      insert into public.precos_faltando(court_id, dia_semana, bloco)
        values (_court, b.dow, make_time(b.minuto / 60, b.minuto % 60, 0))
        on conflict on constraint precos_faltando_pkey
        do update set vezes = public.precos_faltando.vezes + 1, visto_em = now();
      raise log 'busca: quadra % sem preço no dia % às %', _court, b.dow, make_time(b.minuto / 60, b.minuto % 60, 0);
      return query select false, 'sem_preco'::text, null::numeric; return;
    end if;
    total := total + p;
  end loop;

  if exists (
    select 1 from public.bloqueios bl
    where bl.court_id = _court and tstzrange(bl.starts_at, bl.ends_at) && tstzrange(_inicio, _fim)
  ) then
    return query select false, 'bloqueado'::text, null::numeric; return;
  end if;
  if exists (
    select 1 from public.bookings bk
    where bk.court_id = _court and bk.status in ('pendente', 'confirmada')
      and (bk.status = 'confirmada' or bk.expires_at > now())
      and tstzrange(bk.starts_at, bk.ends_at) && tstzrange(_inicio, _fim)
  ) then
    return query select false, 'reservado'::text, null::numeric; return;
  end if;

  return query select true, null::text, total;
end $$;

-- ---------------------------------------------------------------- fila de espera

-- Avisa quem espera por um intervalo que encosta no período liberado, se ele ficou livre.
create or replace function public.notify_waitlist(_court uuid, _inicio timestamptz, _fim timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare w record;
begin
  for w in
    select * from public.waitlist wl
    where wl.court_id = _court and wl.starts_at > now()
      and tstzrange(wl.starts_at, wl.ends_at) && tstzrange(_inicio, _fim)
  loop
    if (select d.livre from public.disponibilidade_quadra(w.court_id, w.starts_at, w.ends_at) d) then
      insert into public.notifications(user_id, message, link) values (
        w.organizer_id,
        'Vagou! ' || public.reserva_label(w.court_id, w.starts_at, w.ends_at) || ' está livre. Quem solicitar primeiro leva.',
        public.quadra_link(w.court_id, w.starts_at, w.ends_at));
      update public.waitlist set notified_at = now() where id = w.id;
    end if;
  end loop;
end $$;

create or replace function public.entrar_fila(_court uuid, _inicio timestamptz, _fim timestamptz) returns uuid
language plpgsql security definer set search_path = public as $$
declare d record; wid uuid;
begin
  if auth.uid() is null then raise exception 'Faça login para entrar na fila'; end if;
  select * into d from public.disponibilidade_quadra(_court, _inicio, _fim);
  if d.livre then raise exception 'Esse horário está livre: é só solicitar.'; end if;
  if d.motivo not in ('bloqueado', 'reservado', 'mensalista') then raise exception '%', public.motivo_texto(d.motivo); end if;
  insert into public.waitlist(court_id, starts_at, ends_at, organizer_id)
    values (_court, _inicio, _fim, auth.uid())
    on conflict (court_id, organizer_id, starts_at, ends_at) do nothing
    returning id into wid;
  return wid;
end $$;

-- ---------------------------------------------------------------- ciclo da reserva

create or replace function public.expire_bookings() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in update public.bookings set status = 'expirada', updated_at = now()
    where status = 'pendente' and expires_at < now()
    returning id, court_id, starts_at, ends_at, organizer_id
  loop
    n := n + 1;
    insert into public.notifications(user_id, message, link) values (r.organizer_id,
      'Sua solicitação para ' || public.reserva_label(r.court_id, r.starts_at, r.ends_at) || ' expirou por falta de pagamento.',
      '/reserva/' || r.id);
    perform public.notify_waitlist(r.court_id, r.starts_at, r.ends_at);
  end loop;
  return n;
end $$;

create or replace function public.request_booking(_court uuid, _inicio timestamptz, _fim timestamptz) returns uuid
language plpgsql security definer set search_path = public as $$
declare d record; v record; bid uuid; was_waiting boolean;
begin
  if auth.uid() is null then raise exception 'Faça login para reservar'; end if;
  -- Serializa pedidos da mesma quadra; a constraint de sobreposição é a última barreira.
  perform pg_advisory_xact_lock(hashtextextended(_court::text, 0));
  perform public.expire_bookings();
  select * into d from public.disponibilidade_quadra(_court, _inicio, _fim);
  if not d.livre then raise exception '%', public.motivo_texto(d.motivo); end if;
  select v2.* into v from public.venues v2 join public.courts c on c.venue_id = v2.id where c.id = _court;
  was_waiting := exists (
    select 1 from public.waitlist w
    where w.court_id = _court and w.organizer_id = auth.uid()
      and tstzrange(w.starts_at, w.ends_at) && tstzrange(_inicio, _fim));
  begin
    insert into public.bookings(court_id, starts_at, ends_at, organizer_id, expires_at, from_waitlist, preco)
      values (_court, _inicio, _fim, auth.uid(),
        least(now() + make_interval(hours => v.payment_deadline_hours), _inicio), was_waiting, d.preco_total)
      returning id into bid;
  exception when exclusion_violation then
    raise exception 'Alguém acabou de pedir esse horário. Escolha outro.';
  end;
  delete from public.waitlist w
    where w.court_id = _court and w.organizer_id = auth.uid()
      and tstzrange(w.starts_at, w.ends_at) && tstzrange(_inicio, _fim);
  insert into public.notifications(user_id, message, link)
    select m.user_id, 'Nova solicitação: ' || public.reserva_label(_court, _inicio, _fim) || ' por '
      || coalesce((select name from public.profiles where id = auth.uid()), 'organizador'), '/gestor/solicitacoes'
    from public.venue_managers m where m.venue_id = v.id;
  return bid;
end $$;

create or replace function public.confirm_booking(_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  select * into b from public.bookings where id = _booking for update;
  if b is null or not public.manages_court(b.court_id) then raise exception 'Sem permissão'; end if;
  if b.status <> 'pendente' then raise exception 'Solicitação não está mais pendente'; end if;
  update public.bookings set status = 'confirmada', updated_at = now() where id = _booking;
  insert into public.notifications(user_id, message, link) values (b.organizer_id,
    'Pagamento confirmado! Reserva garantida: ' || public.reserva_label(b.court_id, b.starts_at, b.ends_at),
    '/reserva/' || b.id);
end $$;

create or replace function public.reject_booking(_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record;
begin
  select * into b from public.bookings where id = _booking for update;
  if b is null or not public.manages_court(b.court_id) then raise exception 'Sem permissão'; end if;
  if b.status <> 'pendente' then raise exception 'Solicitação não está mais pendente'; end if;
  update public.bookings set status = 'recusada', updated_at = now() where id = _booking;
  insert into public.notifications(user_id, message, link) values (b.organizer_id,
    'Sua solicitação para ' || public.reserva_label(b.court_id, b.starts_at, b.ends_at) || ' foi recusada.',
    '/reserva/' || b.id);
  perform public.notify_waitlist(b.court_id, b.starts_at, b.ends_at);
end $$;

create or replace function public.cancel_booking(_booking uuid) returns void
language plpgsql security definer set search_path = public as $$
declare b record; lim int; is_g boolean;
begin
  select * into b from public.bookings where id = _booking for update;
  if b is null or b.status not in ('pendente', 'confirmada') then raise exception 'Reserva não pode ser cancelada'; end if;
  is_g := public.manages_court(b.court_id);
  if not is_g then
    if b.organizer_id <> auth.uid() then raise exception 'Sem permissão'; end if;
    select v.cancel_limit_hours into lim from public.venues v join public.courts c on c.venue_id = v.id where c.id = b.court_id;
    if b.status = 'confirmada' and b.starts_at - now() < make_interval(hours => lim) then
      raise exception 'Cancelamento só até % horas antes do jogo. Fale com a quadra.', lim;
    end if;
  end if;
  update public.bookings set status = 'cancelada', updated_at = now() where id = _booking;
  if is_g and b.organizer_id <> auth.uid() then
    insert into public.notifications(user_id, message, link) values (b.organizer_id,
      'Sua reserva ' || public.reserva_label(b.court_id, b.starts_at, b.ends_at) || ' foi cancelada pela quadra.',
      '/reserva/' || b.id);
  end if;
  perform public.notify_waitlist(b.court_id, b.starts_at, b.ends_at);
end $$;

-- ---------------------------------------------------------------- gestor

-- Marca (ou libera) um intervalo como ocupado por fora do app. Liberar só uma parte
-- de um bloqueio maior mantém o restante.
create or replace function public.set_bloqueio(_court uuid, _inicio timestamptz, _fim timestamptz,
  _bloquear boolean, _nota text default null) returns void
language plpgsql security definer set search_path = public as $$
declare bl record;
begin
  if not public.manages_court(_court) then raise exception 'Sem permissão'; end if;
  if _fim <= _inicio then raise exception 'Intervalo inválido'; end if;
  if _bloquear and exists (
    select 1 from public.bookings bk
    where bk.court_id = _court and bk.status in ('pendente', 'confirmada')
      and (bk.status = 'confirmada' or bk.expires_at > now())
      and tstzrange(bk.starts_at, bk.ends_at) && tstzrange(_inicio, _fim)
  ) then
    raise exception 'Horário tem reserva no app; cancele-a antes';
  end if;
  for bl in
    delete from public.bloqueios
    where court_id = _court and tstzrange(starts_at, ends_at) && tstzrange(_inicio, _fim)
    returning *
  loop
    if bl.starts_at < _inicio then
      insert into public.bloqueios(court_id, starts_at, ends_at, nota, created_by)
        values (_court, bl.starts_at, _inicio, bl.nota, bl.created_by);
    end if;
    if bl.ends_at > _fim then
      insert into public.bloqueios(court_id, starts_at, ends_at, nota, created_by)
        values (_court, _fim, bl.ends_at, bl.nota, bl.created_by);
    end if;
  end loop;
  if _bloquear then
    insert into public.bloqueios(court_id, starts_at, ends_at, nota, created_by)
      values (_court, _inicio, _fim, nullif(trim(_nota), ''), auth.uid());
  else
    perform public.notify_waitlist(_court, _inicio, _fim);
  end if;
end $$;

drop function if exists public.publish_week(date, uuid, boolean);
create or replace function public.publish_week(_monday date, _venue uuid, _publish boolean default true) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.manages_venue(_venue) then raise exception 'Sem permissão'; end if;
  if extract(isodow from _monday) <> 1 then raise exception 'A semana começa na segunda-feira'; end if;
  if _publish then
    insert into public.semanas_publicadas(venue_id, segunda) values (_venue, _monday) on conflict do nothing;
  else
    delete from public.semanas_publicadas where venue_id = _venue and segunda = _monday;
  end if;
end $$;

-- Grade da semana do gestor: uma linha por quadra, dia e hora aberta.
-- estado: livre | bloqueado | mensalista | pendente | confirmada
create or replace function public.agenda_gestor(_venue uuid, _monday date) returns table (
  court_id uuid, dia date, hora int, inicio timestamptz, estado text,
  booking_id uuid, booking_inicio timestamptz, booking_fim timestamptz, nota text, fila int
) language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.manages_venue(_venue) then raise exception 'Sem permissão'; end if;
  return query
  with celulas as (
    select c.id cid, (_monday + d) dia, h hora,
      ((_monday + d)::timestamp + make_interval(hours => h)) at time zone 'America/Sao_Paulo' ini
    from public.courts c cross join generate_series(0, 6) d cross join generate_series(0, 23) h
    where c.venue_id = _venue and c.active
      and exists (
        select 1 from public.horarios_funcionamento hf
        where hf.court_id = c.id and hf.dia_semana = extract(dow from _monday + d)::int
          and public.minutos(hf.abre) < h * 60 + 60 and public.minutos(hf.fecha) > h * 60)
  )
  select x.cid, x.dia, x.hora, x.ini,
    case when bk.status = 'confirmada' then 'confirmada'
         when bk.status = 'pendente' then 'pendente'
         when bl.id is not null then 'bloqueado'
         when ms.id is not null then 'mensalista'
         else 'livre' end,
    bk.id, bk.starts_at, bk.ends_at,
    coalesce(bl.nota, nullif(ms.nome, '')),
    (select count(*)::int from public.waitlist w
      where w.court_id = x.cid and tstzrange(w.starts_at, w.ends_at) && tstzrange(x.ini, x.ini + interval '1 hour'))
  from celulas x
  left join lateral (
    select b.id, b.status, b.starts_at, b.ends_at from public.bookings b
    where b.court_id = x.cid and b.status in ('pendente', 'confirmada')
      and (b.status = 'confirmada' or b.expires_at > now())
      and tstzrange(b.starts_at, b.ends_at) && tstzrange(x.ini, x.ini + interval '1 hour')
    order by b.starts_at limit 1) bk on true
  left join lateral (
    select b.id, b.nota from public.bloqueios b
    where b.court_id = x.cid and tstzrange(b.starts_at, b.ends_at) && tstzrange(x.ini, x.ini + interval '1 hour')
    limit 1) bl on true
  left join lateral (
    select m.id, m.nome from public.mensalistas m
    where m.court_id = x.cid and m.dia_semana = extract(dow from x.dia)::int
      and public.minutos(m.inicio) < x.hora * 60 + 60 and public.minutos(m.fim) > x.hora * 60
      and m.valido_de <= x.dia and (m.valido_ate is null or m.valido_ate >= x.dia)
    limit 1) ms on true
  order by x.cid, x.dia, x.hora;
end $$;

-- ---------------------------------------------------------------- agenda do organizador

-- Horários de 1h (na hora cheia) de um dia, em arenas verificadas e semana publicada.
-- state: livre | aguardando | ocupado | passado
create or replace function public.agenda_dia(_day date, _venue uuid default null) returns table (
  court_id uuid, court_name text, venue_id uuid, venue_name text, neighborhood text,
  modalidade public.modalidade, inicio timestamptz, state text, price numeric,
  my_booking_id uuid, my_booking_status booking_status, in_waitlist boolean
) language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform public.expire_bookings();
  return query
  with q as (
    select c.id cid, c.name cname, v.id vid, v.name vname, v.neighborhood bairro, c.modalidade modal,
      v.antecedencia_min_minutos ant
    from public.courts c join public.venues v on v.id = c.venue_id
    where c.active and v.agenda_verificada and (_venue is null or v.id = _venue)
      and exists (select 1 from public.semanas_publicadas sp
        where sp.venue_id = v.id and sp.segunda = _day - (extract(isodow from _day)::int - 1))
  ), h as (
    select q.*, g, ((_day::timestamp + make_interval(hours => g)) at time zone 'America/Sao_Paulo') ini
    from q cross join generate_series(0, 23) g
    where exists (
      select 1 from public.horarios_funcionamento hf
      where hf.court_id = q.cid and hf.dia_semana = extract(dow from _day)::int
        and public.minutos(hf.abre) <= g * 60 and g * 60 + 60 <= public.minutos(hf.fecha))
  ), p as (
    select h.*, public.preco_intervalo(h.cid, h.ini, h.ini + interval '1 hour') preco from h
  )
  select p.cid, p.cname, p.vid, p.vname, p.bairro, p.modal, p.ini,
    case
      when p.ini < now() + make_interval(mins => p.ant) then 'passado'
      when exists (select 1 from public.bookings b where b.court_id = p.cid and b.status = 'confirmada'
             and tstzrange(b.starts_at, b.ends_at) && tstzrange(p.ini, p.ini + interval '1 hour')) then 'ocupado'
      when exists (select 1 from public.bloqueios b where b.court_id = p.cid
             and tstzrange(b.starts_at, b.ends_at) && tstzrange(p.ini, p.ini + interval '1 hour')) then 'ocupado'
      when exists (select 1 from public.mensalistas m where m.court_id = p.cid
             and m.dia_semana = extract(dow from _day)::int
             and public.minutos(m.inicio) < p.g * 60 + 60 and public.minutos(m.fim) > p.g * 60
             and m.valido_de <= _day and (m.valido_ate is null or m.valido_ate >= _day)) then 'ocupado'
      when exists (select 1 from public.bookings b where b.court_id = p.cid and b.status = 'pendente'
             and b.expires_at > now()
             and tstzrange(b.starts_at, b.ends_at) && tstzrange(p.ini, p.ini + interval '1 hour')) then 'aguardando'
      else 'livre' end,
    p.preco, mb.id, mb.status,
    exists (select 1 from public.waitlist w where w.court_id = p.cid and w.organizer_id = auth.uid()
      and tstzrange(w.starts_at, w.ends_at) && tstzrange(p.ini, p.ini + interval '1 hour'))
  from p
  left join lateral (
    select b.id, b.status from public.bookings b
    where b.court_id = p.cid and b.organizer_id = auth.uid() and b.status in ('pendente', 'confirmada')
      and tstzrange(b.starts_at, b.ends_at) && tstzrange(p.ini, p.ini + interval '1 hour')
    limit 1) mb on true
  where p.preco is not null
  order by p.ini, p.vname, p.cname;
end $$;

revoke execute on function public.notify_waitlist(uuid, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.seed_agenda_quadra() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on all functions in schema public from anon;
grant execute on function public.cnpj_in_use(text) to anon, authenticated;
