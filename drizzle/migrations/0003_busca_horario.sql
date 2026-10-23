-- Busca de quadras por horário (fase 1).
-- A disponibilidade passa a ser calculada por intervalo, em blocos de 30 min:
-- funcionamento por dia da semana, preço por faixa, mensalistas e antecedência.
-- Bloqueios e reservas continuam vindo dos slots de 1h existentes; a fase 2
-- (reserva por intervalo) troca essa origem sem mudar a função de disponibilidade.
-- Idempotente: pode rodar de novo sem erro.

-- ---------------------------------------------------------------- arena e quadra

alter table public.venues add column if not exists agenda_verificada boolean not null default false;
alter table public.venues add column if not exists antecedencia_min_minutos int not null default 0;
alter table public.venues add column if not exists lat double precision;
alter table public.venues add column if not exists lng double precision;
alter table public.venues drop constraint if exists venues_antecedencia_valida;
alter table public.venues add constraint venues_antecedencia_valida check (antecedencia_min_minutos >= 0);
create index if not exists venues_verificadas_geo on public.venues(lat, lng) where agenda_verificada;

-- O selo de agenda verificada é dado pela equipe, não pelo gestor: o gestor só
-- atualiza as colunas listadas aqui.
revoke update on public.venues from authenticated;
grant update (name, address, neighborhood, city, pix_key, whatsapp, payment_deadline_hours,
  cancel_limit_hours, open_hour, close_hour, cnpj, antecedencia_min_minutos, lat, lng)
  on public.venues to authenticated;

do $$ begin
  create type public.modalidade as enum ('futsal', 'society');
exception when duplicate_object then null;
end $$;
alter table public.courts add column if not exists modalidade public.modalidade not null default 'society';

-- Preço cobrado na solicitação, para não depender de mudanças futuras na tabela de preços.
alter table public.bookings add column if not exists preco numeric(10,2);

-- ---------------------------------------------------------------- agenda da quadra

-- dia_semana segue extract(dow): 0 = domingo … 6 = sábado. fecha aceita '24:00'.
create table if not exists public.horarios_funcionamento (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts(id) on delete cascade,
  dia_semana smallint not null check (dia_semana between 0 and 6),
  abre time not null,
  fecha time not null,
  created_at timestamptz not null default now(),
  check (abre < fecha)
);
create index if not exists horarios_funcionamento_court_dia on public.horarios_funcionamento(court_id, dia_semana);

-- Preço de cada bloco de 30 min dentro da faixa. Se faixas se sobrepõem, vale a mais curta.
create table if not exists public.regras_preco (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts(id) on delete cascade,
  dia_semana smallint not null check (dia_semana between 0 and 6),
  inicio time not null,
  fim time not null,
  preco_bloco numeric(10,2) not null check (preco_bloco >= 0),
  created_at timestamptz not null default now(),
  check (inicio < fim)
);
create index if not exists regras_preco_court_dia on public.regras_preco(court_id, dia_semana);

create table if not exists public.mensalistas (
  id uuid primary key default gen_random_uuid(),
  court_id uuid not null references public.courts(id) on delete cascade,
  dia_semana smallint not null check (dia_semana between 0 and 6),
  inicio time not null,
  fim time not null,
  nome text not null default '',
  valido_de date not null default current_date,
  valido_ate date,
  created_at timestamptz not null default now(),
  check (inicio < fim)
);
create index if not exists mensalistas_court_dia on public.mensalistas(court_id, dia_semana);

-- Log de blocos sem preço encontrados pela busca, para corrigir o cadastro.
create table if not exists public.precos_faltando (
  court_id uuid not null references public.courts(id) on delete cascade,
  dia_semana smallint not null,
  bloco time not null,
  vezes int not null default 1,
  visto_em timestamptz not null default now(),
  primary key (court_id, dia_semana, bloco)
);

-- Centro aproximado de cada bairro de BH (PBH, dados abertos "Bairro Popular", CC BY).
create table if not exists public.bairros_bh (
  nome text primary key,
  lat double precision not null,
  lng double precision not null
);

grant select on public.horarios_funcionamento, public.regras_preco, public.bairros_bh to anon, authenticated;
grant insert, update, delete on public.horarios_funcionamento, public.regras_preco to authenticated;
grant select, insert, update, delete on public.mensalistas to authenticated;
grant select on public.precos_faltando to authenticated;
grant all on public.horarios_funcionamento, public.regras_preco, public.mensalistas,
  public.precos_faltando, public.bairros_bh to service_role;

alter table public.horarios_funcionamento enable row level security;
alter table public.regras_preco enable row level security;
alter table public.mensalistas enable row level security;
alter table public.precos_faltando enable row level security;
alter table public.bairros_bh enable row level security;

drop policy if exists "funcionamento read" on public.horarios_funcionamento;
drop policy if exists "funcionamento write" on public.horarios_funcionamento;
create policy "funcionamento read" on public.horarios_funcionamento for select to anon, authenticated using (true);
create policy "funcionamento write" on public.horarios_funcionamento for all to authenticated
  using (public.manages_court(court_id)) with check (public.manages_court(court_id));

drop policy if exists "precos read" on public.regras_preco;
drop policy if exists "precos write" on public.regras_preco;
create policy "precos read" on public.regras_preco for select to anon, authenticated using (true);
create policy "precos write" on public.regras_preco for all to authenticated
  using (public.manages_court(court_id)) with check (public.manages_court(court_id));

-- Nome do mensalista é dado pessoal: só o gestor da quadra vê.
drop policy if exists "mensalistas gestor" on public.mensalistas;
create policy "mensalistas gestor" on public.mensalistas for all to authenticated
  using (public.manages_court(court_id)) with check (public.manages_court(court_id));

drop policy if exists "precos faltando gestor" on public.precos_faltando;
create policy "precos faltando gestor" on public.precos_faltando for select to authenticated
  using (public.manages_court(court_id));

drop policy if exists "bairros read" on public.bairros_bh;
create policy "bairros read" on public.bairros_bh for select to anon, authenticated using (true);

-- Quadras existentes: funcionamento = horário do local todos os dias; preço = preço/hora atual.
insert into public.horarios_funcionamento(court_id, dia_semana, abre, fecha)
  select co.id, d, make_time(v.open_hour, 0, 0), (v.close_hour || ':00')::time
  from public.courts co join public.venues v on v.id = co.venue_id cross join generate_series(0, 6) d
  where not exists (select 1 from public.horarios_funcionamento h where h.court_id = co.id);

insert into public.regras_preco(court_id, dia_semana, inicio, fim, preco_bloco)
  select co.id, d, '00:00', '24:00', round(co.price_per_hour / 2, 2)
  from public.courts co cross join generate_series(0, 6) d
  where not exists (select 1 from public.regras_preco r where r.court_id = co.id);

-- Quadra nova já nasce com funcionamento e preço padrão, para aparecer na busca.
create or replace function public.seed_agenda_quadra() returns trigger
language plpgsql security definer set search_path = public as $$
declare v record;
begin
  select * into v from public.venues where id = new.venue_id;
  insert into public.horarios_funcionamento(court_id, dia_semana, abre, fecha)
    select new.id, d, make_time(v.open_hour, 0, 0), (v.close_hour || ':00')::time from generate_series(0, 6) d;
  insert into public.regras_preco(court_id, dia_semana, inicio, fim, preco_bloco)
    select new.id, d, '00:00', '24:00', round(new.price_per_hour / 2, 2) from generate_series(0, 6) d;
  return new;
end $$;
drop trigger if exists on_court_created on public.courts;
create trigger on_court_created after insert on public.courts for each row execute function public.seed_agenda_quadra();

-- ---------------------------------------------------------------- disponibilidade

-- Blocos de 30 min de um intervalo, no horário de Brasília.
create or replace function public.blocos_30(_inicio timestamptz, _fim timestamptz)
returns table (dia date, dow int, minuto int)
language sql stable set search_path = public as $$
  select (t at time zone 'America/Sao_Paulo')::date,
         extract(dow from t at time zone 'America/Sao_Paulo')::int,
         (extract(hour from t at time zone 'America/Sao_Paulo') * 60
           + extract(minute from t at time zone 'America/Sao_Paulo'))::int
  from generate_series(_inicio, _fim - interval '30 minutes', interval '30 minutes') t
$$;

create or replace function public.minutos(_t time) returns int
language sql immutable as $$ select (extract(epoch from _t) / 60)::int $$;

create or replace function public.preco_bloco(_court uuid, _dow int, _minuto int) returns numeric
language sql stable set search_path = public as $$
  select r.preco_bloco from public.regras_preco r
  where r.court_id = _court and r.dia_semana = _dow
    and public.minutos(r.inicio) <= _minuto and _minuto + 30 <= public.minutos(r.fim)
  order by r.fim - r.inicio, r.created_at desc
  limit 1
$$;

-- Soma dos blocos; null se algum bloco não tiver preço.
create or replace function public.preco_intervalo(_court uuid, _inicio timestamptz, _fim timestamptz) returns numeric
language sql stable set search_path = public as $$
  select case when count(*) > 0 and count(p) = count(*) then sum(p) end
  from (select public.preco_bloco(_court, b.dow, b.minuto) p from public.blocos_30(_inicio, _fim) b) x
$$;

-- Reutilizável pela busca e, na fase 2, pela própria reserva.
-- motivo: horario_invalido | quadra_indisponivel | passado | antecedencia | fechado |
--         mensalista | sem_preco | bloqueado | reservado
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

  select co.active, v.antecedencia_min_minutos into q
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

  -- Slots duram no máximo 1 dia; o limite inferior deixa o índice (court_id, starts_at) trabalhar.
  if exists (
    select 1 from public.slots s
    where s.court_id = _court and s.blocked
      and s.starts_at < _fim and s.starts_at > _inicio - interval '1 day'
      and s.starts_at + make_interval(mins => s.duration_min) > _inicio
  ) then
    return query select false, 'bloqueado'::text, null::numeric; return;
  end if;
  if exists (
    select 1 from public.slots s join public.bookings bk on bk.slot_id = s.id
    where s.court_id = _court
      and s.starts_at < _fim and s.starts_at > _inicio - interval '1 day'
      and s.starts_at + make_interval(mins => s.duration_min) > _inicio
      and bk.status in ('pendente', 'confirmada')
      and (bk.status = 'confirmada' or bk.expires_at > now())
  ) then
    return query select false, 'reservado'::text, null::numeric; return;
  end if;

  return query select true, null::text, total;
end $$;

-- ---------------------------------------------------------------- busca

create or replace function public.distancia_km(_lat1 double precision, _lng1 double precision,
  _lat2 double precision, _lng2 double precision) returns double precision
language sql immutable as $$
  select 6371 * 2 * asin(sqrt(
    sin(radians(_lat2 - _lat1) / 2) ^ 2
    + cos(radians(_lat1)) * cos(radians(_lat2)) * sin(radians(_lng2 - _lng1) / 2) ^ 2))
$$;

-- Quadras que podem aparecer: ativas, da modalidade, em arena verificada e dentro do raio.
create or replace function public.quadras_candidatas(_modalidade public.modalidade,
  _lat double precision, _lng double precision, _raio_km double precision)
returns table (court_id uuid, court_name text, venue_id uuid, venue_name text, neighborhood text,
  modalidade public.modalidade, photo_url text, distancia_km double precision)
language sql stable security definer set search_path = public as $$
  select co.id, co.name, v.id, v.name, v.neighborhood, co.modalidade, co.photo_url,
    case when _lat is null or _lng is null or v.lat is null or v.lng is null then null
         else public.distancia_km(_lat, _lng, v.lat, v.lng) end
  from public.courts co join public.venues v on v.id = co.venue_id
  where co.active and v.agenda_verificada and co.modalidade = _modalidade
    and (_lat is null or _lng is null or (
      v.lat between _lat - _raio_km / 111.0 and _lat + _raio_km / 111.0
      and public.distancia_km(_lat, _lng, v.lat, v.lng) <= _raio_km))
$$;

-- Devolve as quadras com o horário exato livre; se não houver nenhuma, os horários
-- próximos (até 1h antes ou depois, mesma data), ordenados pela diferença.
create or replace function public.buscar_quadras(
  _data date, _hora time, _duracao_min int default 60,
  _modalidade public.modalidade default 'society',
  _lat double precision default null, _lng double precision default null,
  _raio_km double precision default 10, _ordem text default 'distancia'
) returns table (
  court_id uuid, court_name text, venue_id uuid, venue_name text, neighborhood text,
  modalidade public.modalidade, photo_url text, distancia_km double precision,
  inicio timestamptz, fim timestamptz, preco_total numeric, exato boolean, diferenca_min int
) language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare
  _inicio timestamptz := (_data + _hora) at time zone 'America/Sao_Paulo';
  _dur interval := make_interval(mins => _duracao_min);
begin
  if _duracao_min not in (60, 90, 120) then raise exception 'Duração deve ser 1h, 1h30 ou 2h'; end if;
  if extract(minute from _hora)::int % 30 <> 0 or extract(second from _hora) <> 0 then
    raise exception 'Escolha um horário cheio ou de meia hora';
  end if;

  return query
    select c.court_id, c.court_name, c.venue_id, c.venue_name, c.neighborhood, c.modalidade,
      c.photo_url, c.distancia_km, _inicio, _inicio + _dur, d.preco_total, true, 0
    from public.quadras_candidatas(_modalidade, _lat, _lng, _raio_km) c
    cross join lateral public.disponibilidade_quadra(c.court_id, _inicio, _inicio + _dur) d
    where d.livre
    order by case when _ordem = 'preco' then d.preco_total end nulls last,
      c.distancia_km nulls last, d.preco_total, c.venue_name, c.court_name;
  if found then return; end if;

  return query
    select c.court_id, c.court_name, c.venue_id, c.venue_name, c.neighborhood, c.modalidade,
      c.photo_url, c.distancia_km, _inicio + make_interval(mins => o.off),
      _inicio + make_interval(mins => o.off) + _dur, d.preco_total, false, abs(o.off)
    from public.quadras_candidatas(_modalidade, _lat, _lng, _raio_km) c
    cross join (values (-30), (30), (-60), (60)) o(off)
    cross join lateral public.disponibilidade_quadra(c.court_id, _inicio + make_interval(mins => o.off),
      _inicio + make_interval(mins => o.off) + _dur) d
    where d.livre
      and ((_inicio + make_interval(mins => o.off)) at time zone 'America/Sao_Paulo')::date = _data
    order by abs(o.off), o.off,
      case when _ordem = 'preco' then d.preco_total end nulls last,
      c.distancia_km nulls last, d.preco_total, c.venue_name, c.court_name;
end $$;

-- ---------------------------------------------------------------- funções existentes

-- Agenda (1h) passa a usar o funcionamento por dia da semana de cada quadra.
create or replace function public.generate_week(_monday date, _venue uuid) returns int
language plpgsql security definer set search_path = public as $$
declare c record; d int; h int; n int := 0; k int; dow int;
begin
  if not public.manages_venue(_venue) then raise exception 'Sem permissão'; end if;
  for c in select * from public.courts where venue_id = _venue and active loop
    for d in 0..6 loop
      dow := extract(dow from _monday + d)::int;
      for h in 0..23 loop
        continue when not exists (
          select 1 from public.horarios_funcionamento hf
          where hf.court_id = c.id and hf.dia_semana = dow
            and public.minutos(hf.abre) <= h * 60 and h * 60 + 60 <= public.minutos(hf.fecha));
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

-- Agenda do organizador mostra o preço da tabela de preços (com o preço/hora antigo de reserva).
create or replace function public.get_agenda(_day date) returns table (
  slot_id uuid, court_id uuid, court_name text, surface text, price numeric, photo_url text,
  venue_id uuid, venue_name text, neighborhood text,
  starts_at timestamptz, state text, my_booking_id uuid, my_booking_status booking_status, in_waitlist boolean
) language plpgsql security definer set search_path = public as $$
begin
  perform public.expire_bookings();
  return query
  select s.id, c.id, c.name, c.surface,
    coalesce(public.preco_intervalo(c.id, s.starts_at, s.starts_at + make_interval(mins => s.duration_min)), c.price_per_hour),
    c.photo_url, v.id, v.name, v.neighborhood,
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

-- A solicitação guarda o preço do momento.
create or replace function public.request_booking(_slot uuid) returns uuid
language plpgsql security definer set search_path = public as $$
declare s record; v record; c record; bid uuid; was_waiting boolean;
begin
  if auth.uid() is null then raise exception 'Faça login para reservar'; end if;
  perform public.expire_bookings();
  select * into s from public.slots where id = _slot for update;
  if s is null or not s.published then raise exception 'Horário indisponível'; end if;
  if s.blocked then raise exception 'Horário ocupado'; end if;
  if s.starts_at <= now() then raise exception 'Esse horário já passou'; end if;
  if exists (select 1 from public.bookings where slot_id = _slot and status in ('pendente','confirmada')) then
    raise exception 'Alguém já solicitou esse horário'; end if;
  select * into c from public.courts where id = s.court_id;
  select * into v from public.venues where id = c.venue_id;
  was_waiting := exists (select 1 from public.waitlist where slot_id = _slot and organizer_id = auth.uid());
  insert into public.bookings(slot_id, organizer_id, expires_at, from_waitlist, preco)
    values (_slot, auth.uid(), least(now() + make_interval(hours => v.payment_deadline_hours), s.starts_at), was_waiting,
      coalesce(public.preco_intervalo(c.id, s.starts_at, s.starts_at + make_interval(mins => s.duration_min)), c.price_per_hour))
    returning id into bid;
  delete from public.waitlist where slot_id = _slot and organizer_id = auth.uid();
  insert into public.notifications(user_id, message, link)
    select m.user_id, 'Nova solicitação: ' || public.slot_label(_slot) || ' por ' || coalesce((select name from public.profiles where id = auth.uid()),'organizador'), '/gestor/solicitacoes'
    from public.venue_managers m where m.venue_id = v.id;
  return bid;
end $$;

revoke execute on function public.seed_agenda_quadra() from public, anon, authenticated;
revoke execute on all functions in schema public from anon;
grant execute on function public.cnpj_in_use(text) to anon, authenticated;

-- ---------------------------------------------------------------- bairros de BH

insert into public.bairros_bh(nome, lat, lng) values
  ('Aarão Reis', -19.84638, -43.92349),
  ('Acaba Mundo', -19.96134, -43.92898),
  ('Acaiaca', -19.84481, -43.89464),
  ('Ademar Maldonado', -19.98243, -44.02680),
  ('Aeroporto', -19.85086, -43.95216),
  ('Águas Claras', -20.01255, -44.02223),
  ('Alípio de Melo', -19.89463, -44.00387),
  ('Alpes', -19.95423, -43.96373),
  ('Alta Tensão', -19.96601, -44.00090),
  ('Alta Tensão I', -19.97176, -43.99543),
  ('Alto Barroca', -19.93360, -43.96900),
  ('Alto Caiçaras', -19.89735, -43.97481),
  ('Alto das Antenas', -19.99682, -43.98868),
  ('Alto dos Pinheiros', -19.93102, -44.00382),
  ('Alto Vera Cruz', -19.91006, -43.89107),
  ('Álvaro Camargos', -19.91507, -44.00665),
  ('Ambrosina', -19.93649, -43.98327),
  ('Anchieta', -19.94955, -43.92708),
  ('Andiroba', -19.86563, -43.92620),
  ('Antônio Ribeiro de Abreu', -19.83445, -43.90546),
  ('Aparecida', -19.89373, -43.95310),
  ('Aparecida Sétima Seção', -19.89104, -43.96204),
  ('Apolônia', -19.82724, -43.99065),
  ('Araguaia', -19.98855, -43.99982),
  ('Átila de Paiva', -19.97783, -44.02893),
  ('Bacurau', -19.82622, -43.94514),
  ('Bairro das Indústrias I', -19.96743, -44.00672),
  ('Bairro das Indústrias II', -19.95921, -43.99972),
  ('Bairro Novo das Indústrias', -19.97450, -43.99716),
  ('Baleia', -19.93382, -43.89332),
  ('Bandeirantes', -19.86021, -43.99780),
  ('Barão Homem de Melo I', -19.93850, -43.97303),
  ('Barão Homem de Melo III', -19.94252, -43.97164),
  ('Barão Homem de Melo IV', -19.94513, -43.97057),
  ('Barreiro', -19.97783, -44.01908),
  ('Barro Preto', -19.92269, -43.95269),
  ('Barroca', -19.93288, -43.96397),
  ('Beija Flor', -19.83651, -43.86779),
  ('Beira-Linha', -19.83713, -43.89392),
  ('Bela Vitória', -19.85656, -43.88982),
  ('Belém', -19.91342, -43.90082),
  ('Belmonte', -19.84655, -43.90175),
  ('Belvedere', -19.97652, -43.94469),
  ('Bernadete', -19.98511, -43.98386),
  ('Betânia', -19.95985, -43.99184),
  ('Biquinhas', -19.84041, -43.94198),
  ('Bispo de Maura', -19.82671, -44.01311),
  ('Boa Esperança', -19.85297, -43.90314),
  ('Boa União I', -19.86241, -43.92739),
  ('Boa União II', -19.85925, -43.92545),
  ('Boa Viagem', -19.92905, -43.93528),
  ('Boa Vista', -19.89325, -43.90035),
  ('Bom Jesus', -19.89654, -43.95421),
  ('Bonfim', -19.91005, -43.95126),
  ('Bonsucesso', -19.98907, -43.98323),
  ('Brasil Industrial', -19.99996, -44.01464),
  ('Braúnas', -19.84777, -44.00688),
  ('Buritis', -19.97638, -43.96943),
  ('Cabana do Pai Tomás', -19.94727, -43.99944),
  ('Cachoeirinha', -19.88750, -43.94745),
  ('Caetano Furquim', -19.90316, -43.88785),
  ('Caiçara-Adelaide', -19.90468, -43.97626),
  ('Caiçaras', -19.90038, -43.96699),
  ('Calafate', -19.92499, -43.97464),
  ('Califórnia', -19.92316, -44.01559),
  ('Camargos', -19.94079, -44.01686),
  ('Campo Alegre', -19.83071, -43.94693),
  ('Camponesa I', -19.89664, -43.90924),
  ('Camponesa III', -19.89978, -43.90610),
  ('Campus UFMG', -19.87280, -43.96671),
  ('Canaã', -19.79459, -43.94771),
  ('Canadá', -19.89674, -43.94482),
  ('Candelária', -19.81170, -43.97154),
  ('Capitão Eduardo', -19.82827, -43.87982),
  ('Cardoso', -20.00293, -44.00800),
  ('Carlos Prates', -19.91407, -43.95812),
  ('Carmo', -19.94311, -43.93194),
  ('Casa Branca', -19.89962, -43.88746),
  ('Castanheira', -19.99626, -44.03127),
  ('Castelo', -19.88225, -43.99858),
  ('CDI Jatobá', -19.99897, -44.04034),
  ('Cenáculo', -19.80715, -43.96390),
  ('Centro', -19.91937, -43.93876),
  ('Céu Azul', -19.82216, -44.00134),
  ('Chácara Leonina', -19.95532, -43.96118),
  ('Cidade Jardim', -19.93819, -43.95060),
  ('Cidade Jardim Taquaril', -19.92793, -43.87878),
  ('Cidade Nova', -19.88902, -43.92495),
  ('Cinqüentenário', -19.95793, -43.98293),
  ('Colégio Batista', -19.90853, -43.93629),
  ('Comiteco', -19.95484, -43.92356),
  ('Concórdia', -19.90002, -43.93837),
  ('Cônego Pinheiro', -19.91907, -43.90951),
  ('Cônego Pinheiro A', -19.91968, -43.90739),
  ('Confisco', -19.86648, -44.01858),
  ('Conjunto Bonsucesso', -19.97787, -43.99178),
  ('Conjunto Califórnia I', -19.92314, -44.00758),
  ('Conjunto Califórnia II', -19.91945, -44.01096),
  ('Conjunto Capitão Eduardo', -19.82990, -43.86790),
  ('Conjunto Celso Machado', -19.88587, -44.00876),
  ('Conjunto Floramar', -19.82971, -43.93143),
  ('Conjunto Jardim Filadélfia', -19.90996, -44.00829),
  ('Conjunto Jatobá', -20.00384, -44.04105),
  ('Conjunto Lagoa', -19.86762, -43.99794),
  ('Conjunto Minascaixa', -19.80333, -43.95912),
  ('Conjunto Novo Dom Bosco', -19.91728, -44.00860),
  ('Conjunto Paulo VI', -19.83178, -43.88615),
  ('Conjunto Providência', -19.85304, -43.92541),
  ('Conjunto Santa Maria', -19.95163, -43.95886),
  ('Conjunto São Francisco de Assis', -19.83135, -44.01125),
  ('Conjunto Serra Verde', -19.79337, -43.95424),
  ('Conjunto Taquaril', -19.91718, -43.87763),
  ('Copacabana', -19.83474, -43.98839),
  ('Coqueiros', -19.89977, -44.02159),
  ('Coração de Jesus', -19.94557, -43.95080),
  ('Coração Eucarístico', -19.92416, -43.99026),
  ('Corumbiara', -20.00938, -44.01362),
  ('Cruzeiro', -19.94405, -43.92564),
  ('Custodinha', -19.94820, -44.00719),
  ('Delta', -19.92426, -44.00415),
  ('Diamante', -19.99163, -44.02420),
  ('Distrito Industrial do Jatobá', -20.00619, -44.02640),
  ('Dom Bosco', -19.91549, -44.00033),
  ('Dom Cabral', -19.92192, -43.99658),
  ('Dom Joaquim', -19.87688, -43.91846),
  ('Dom Silvério', -19.85503, -43.90487),
  ('Dona Clara', -19.85951, -43.94047),
  ('Engenho Nogueira', -19.88703, -43.97865),
  ('Ermelinda', -19.88629, -43.96020),
  ('Ernesto do Nascimento', -20.00864, -44.03247),
  ('Esperança', -19.99319, -43.98950),
  ('Esplanada', -19.90599, -43.90455),
  ('Estoril', -19.96250, -43.96145),
  ('Estrela', -19.94937, -43.94088),
  ('Estrela do Oriente', -19.96606, -43.98803),
  ('Etelvina Carneiro', -19.81158, -43.93427),
  ('Europa', -19.80210, -43.96728),
  ('Eymard', -19.86226, -43.91788),
  ('Fazendinha', -19.93075, -43.90547),
  ('Fernão Dias', -19.87205, -43.91774),
  ('Flamengo', -19.80493, -43.99059),
  ('Flávio de Oliveira', -20.00092, -44.00256),
  ('Flávio Marques Lisboa', -19.99459, -43.99641),
  ('Floramar', -19.83709, -43.93437),
  ('Floresta', -19.91397, -43.92940),
  ('Frei Leopoldo', -19.80841, -43.93795),
  ('Funcionários', -19.93168, -43.92784),
  ('Gameleira', -19.93249, -43.98787),
  ('Garças', -19.83810, -43.99898),
  ('Glória', -19.90337, -44.00787),
  ('Goiânia', -19.86465, -43.89944),
  ('Graça', -19.89960, -43.93089),
  ('Grajaú', -19.93860, -43.96517),
  ('Granja de Freitas', -19.90862, -43.88411),
  ('Granja Werneck', -19.81449, -43.91428),
  ('Grota', -19.90038, -43.89984),
  ('Grotinha', -19.85062, -43.89239),
  ('Guanabara', -19.86149, -43.89828),
  ('Guarani', -19.84386, -43.92370),
  ('Guaratã', -19.93598, -43.98444),
  ('Gutierrez', -19.93733, -43.95804),
  ('Havaí', -19.95943, -43.97346),
  ('Heliópolis', -19.84277, -43.93790),
  ('Horto', -19.90967, -43.91586),
  ('Horto Florestal', -19.89588, -43.91406),
  ('Imbaúbas', -19.94486, -43.99196),
  ('Inconfidência', -19.90694, -43.99811),
  ('Indaiá', -19.86597, -43.95290),
  ('Independência', -20.01925, -44.02980),
  ('Ipê', -19.87022, -43.90577),
  ('Ipiranga', -19.88281, -43.93294),
  ('Itaipu', -19.99066, -44.04963),
  ('Itapoã', -19.83813, -43.95944),
  ('Itatiaia', -19.86816, -44.01274),
  ('Jaqueline', -19.80353, -43.93828),
  ('Jaraguá', -19.85687, -43.95069),
  ('Jardim Alvorada', -19.89797, -43.98801),
  ('Jardim América', -19.94618, -43.97268),
  ('Jardim Atlântico', -19.84490, -43.97759),
  ('Jardim do Vale', -20.00521, -44.03204),
  ('Jardim dos Comerciários', -19.79283, -43.97173),
  ('Jardim Felicidade', -19.82807, -43.92768),
  ('Jardim Guanabara', -19.82746, -43.93593),
  ('Jardim Leblon', -19.82594, -43.98976),
  ('Jardim Montanhês', -19.90654, -43.98245),
  ('Jardim São José', -19.90476, -43.99462),
  ('Jardim Vitória', -19.85197, -43.87608),
  ('Jardinópolis', -19.94270, -44.00473),
  ('Jatobá', -19.99178, -44.05425),
  ('João Alfredo', -19.90923, -43.91186),
  ('João Paulo II', -19.98171, -44.03197),
  ('João Pinheiro', -19.92830, -43.99929),
  ('Jonas Veiga', -19.91979, -43.89405),
  ('Juliana', -19.81562, -43.94350),
  ('Lagoa', -19.81026, -43.99992),
  ('Lagoa da Pampulha', -19.85127, -43.98488),
  ('Lagoinha', -19.90759, -43.94344),
  ('Lagoinha Leblon', -19.80557, -43.99523),
  ('Lajedo', -19.83329, -43.91186),
  ('Laranjeiras', -19.80169, -43.96478),
  ('Leonina', -19.95205, -43.96302),
  ('Letícia', -19.80678, -43.97767),
  ('Liberdade', -19.86127, -43.95545),
  ('Lindéia', -19.97888, -44.05143),
  ('Lorena', -19.91621, -43.98472),
  ('Lourdes', -19.93093, -43.94277),
  ('Luxemburgo', -19.94760, -43.95610),
  ('Madre Gertrudes', -19.95011, -44.00512),
  ('Madri', -19.81500, -43.93660),
  ('Mala e Cuia', -19.94871, -43.93500),
  ('Manacás', -19.89645, -43.99648),
  ('Mangabeiras', -19.95467, -43.91450),
  ('Mangueiras', -20.01371, -44.03576),
  ('Mantiqueira', -19.79398, -43.98338),
  ('Marajó', -19.95875, -43.97940),
  ('Maravilha', -19.93610, -44.01708),
  ('Marçola', -19.94196, -43.90982),
  ('Maria Goretti', -19.86284, -43.90951),
  ('Maria Helena', -19.80013, -43.99431),
  ('Maria Teresa', -19.81922, -43.88587),
  ('Maria Virgínia', -19.86894, -43.93403),
  ('Mariano de Abreu', -19.89589, -43.89090),
  ('Marieta I', -19.99176, -44.03444),
  ('Marieta II', -19.99132, -44.03729),
  ('Marilândia', -19.99741, -44.04771),
  ('Mariquinhas', -19.81383, -43.93983),
  ('Marmiteiros', -19.92021, -43.98422),
  ('Milionários', -19.98123, -44.00145),
  ('Minas Brasil', -19.91719, -43.99061),
  ('Minascaixa', -19.80905, -43.95672),
  ('Minaslândia', -19.85240, -43.93110),
  ('Mineirão', -20.02454, -44.02688),
  ('Miramar', -19.99433, -44.01134),
  ('Mirante', -19.83278, -43.91670),
  ('Mirtes', -19.84306, -43.88436),
  ('Monsenhor Messias', -19.91055, -43.97713),
  ('Monte Azul', -19.81662, -43.89197),
  ('Monte São José', -19.94259, -43.95270),
  ('Morro dos Macacos', -19.87573, -43.90293),
  ('Nazaré', -19.85210, -43.89650),
  ('Nossa Senhora da Aparecida', -19.93142, -43.91710),
  ('Nossa Senhora da Conceição', -19.93634, -43.91504),
  ('Nossa Senhora de Fátima', -19.93735, -43.90571),
  ('Nossa Senhora do Rosário', -19.93385, -43.91361),
  ('Nova América', -19.79645, -43.98893),
  ('Nova Cachoeirinha', -19.88425, -43.95475),
  ('Nova Cintra', -19.94948, -43.99117),
  ('Nova Esperança', -19.90015, -43.95952),
  ('Nova Floresta', -19.89317, -43.93377),
  ('Nova Gameleira', -19.94122, -43.99335),
  ('Nova Granada', -19.94189, -43.96873),
  ('Nova Pampulha', -19.83204, -44.01647),
  ('Nova Suissa', -19.93296, -43.97696),
  ('Nova Vista', -19.88798, -43.89936),
  ('Novo Aarão Reis', -19.84137, -43.90831),
  ('Novo Glória', -19.90474, -44.01415),
  ('Novo Ouro Preto', -19.88396, -43.98436),
  ('Novo Santa Cecília', -20.00533, -44.01640),
  ('Novo São Lucas', -19.93008, -43.91382),
  ('Novo Tupi', -19.83542, -43.90767),
  ('Oeste', -19.93628, -44.00204),
  ('Olaria', -19.99145, -44.02828),
  ('Olhos d''Água', -19.98486, -43.96021),
  ('Ouro Minas', -19.84629, -43.90698),
  ('Ouro Preto', -19.87540, -43.98502),
  ('Padre Eustáquio', -19.91558, -43.98107),
  ('Palmares', -19.87277, -43.93362),
  ('Palmeiras', -19.97366, -43.98188),
  ('Pantanal', -19.95631, -43.96130),
  ('Paquetá', -19.87967, -43.99199),
  ('Paraíso', -19.92238, -43.90519),
  ('Parque São José', -19.96442, -43.97923),
  ('Parque São Pedro', -19.81502, -43.95165),
  ('Paulo VI', -19.83988, -43.89038),
  ('Pedreira Prado Lopes', -19.90248, -43.94954),
  ('Penha', -19.87578, -43.91269),
  ('Petrópolis', -20.01347, -44.02977),
  ('Pilar', -19.99995, -43.97432),
  ('Pindorama', -19.91179, -44.02204),
  ('Pindura Saia', -19.94369, -43.92678),
  ('Pirajá', -19.86620, -43.91750),
  ('Piratininga', -19.81112, -43.98920),
  ('Pirineus', -19.92367, -43.88802),
  ('Planalto', -19.83374, -43.94932),
  ('Pompéia', -19.91238, -43.90438),
  ('Pongelupe', -20.00819, -44.00689),
  ('Pousada Santo Antônio', -19.85907, -43.88763),
  ('Prado', -19.92455, -43.96344),
  ('Primeiro de Maio', -19.86030, -43.93057),
  ('Providência', -19.85487, -43.92521),
  ('Renascença', -19.89009, -43.93978),
  ('Ribeiro de Abreu', -19.83101, -43.90034),
  ('Rio Branco', -19.81737, -43.98236),
  ('Sagrada Família', -19.90292, -43.92265),
  ('Salgado Filho', -19.94417, -43.98155),
  ('Santa Amélia', -19.84014, -43.97835),
  ('Santa Branca', -19.83556, -43.96767),
  ('Santa Cecília', -20.00185, -44.03361),
  ('Santa Cruz', -19.87815, -43.94207),
  ('Santa Efigênia', -19.92441, -43.92002),
  ('Santa Helena', -19.98640, -44.01192),
  ('Santa Inês', -19.88607, -43.91011),
  ('Santa Isabel', -19.94259, -43.92377),
  ('Santa Lúcia', -19.96501, -43.94816),
  ('Santa Margarida', -19.97277, -44.02171),
  ('Santa Maria', -19.93536, -44.01284),
  ('Santa Mônica', -19.82554, -43.97558),
  ('Santa Rita', -20.00899, -44.02975),
  ('Santa Rita de Cássia', -19.95372, -43.94143),
  ('Santa Rosa', -19.86405, -43.94697),
  ('Santa Sofia', -19.95039, -43.96668),
  ('Santa Tereza', -19.91539, -43.91719),
  ('Santa Terezinha', -19.87176, -44.00598),
  ('Santana do Cafezal', -19.93511, -43.90903),
  ('Santo Agostinho', -19.92955, -43.95071),
  ('Santo André', -19.90334, -43.95508),
  ('Santo Antônio', -19.94401, -43.94403),
  ('São Benedito', -19.87067, -43.89812),
  ('São Bento', -19.95734, -43.95392),
  ('São Bernardo', -19.84878, -43.93942),
  ('São Cristóvão', -19.90163, -43.94567),
  ('São Damião', -19.78056, -43.94749),
  ('São Francisco', -19.87640, -43.95666),
  ('São Francisco das Chagas', -19.91430, -43.96162),
  ('São Gabriel', -19.85429, -43.91601),
  ('São Geraldo', -19.89986, -43.89750),
  ('São Gonçalo', -19.84843, -43.92497),
  ('São João', -19.99629, -43.97280),
  ('São João Batista', -19.82172, -43.96323),
  ('São Jorge I', -19.94578, -43.96459),
  ('São Jorge II', -19.94281, -43.96077),
  ('São Jorge III', -19.94710, -43.96389),
  ('São José', -19.86022, -43.96558),
  ('São Lucas', -19.93100, -43.92016),
  ('São Luíz', -19.86002, -43.97074),
  ('São Marcos', -19.87035, -43.91121),
  ('Sao Paulo', -19.86896, -43.92460),
  ('São Pedro', -19.94608, -43.93705),
  ('São Salvador', -19.89308, -44.01417),
  ('São Sebastião', -19.87042, -43.94349),
  ('São Tomáz', -19.84433, -43.95111),
  ('São Vicente', -19.91710, -43.92281),
  ('Satélite', -19.81260, -43.94867),
  ('Saudade', -19.91583, -43.89841),
  ('Savassi', -19.93589, -43.93444),
  ('Senhor dos Passos', -19.90616, -43.94879),
  ('Serra', -19.94015, -43.91957),
  ('Serra do Curral', -20.02455, -44.00081),
  ('Serra Verde', -19.79052, -43.95586),
  ('Serrano', -19.88146, -44.01128),
  ('Silveira', -19.89200, -43.92995),
  ('Sion', -19.95403, -43.93450),
  ('Solar do Barreiro', -20.01060, -44.01335),
  ('Solimões', -19.82229, -43.92613),
  ('Sport Club', -19.94615, -44.01169),
  ('Sumaré', -19.88652, -43.96613),
  ('Suzana', -19.86525, -43.93447),
  ('Taquaril', -19.91778, -43.88472),
  ('Teixeira Dias', -19.98714, -44.01751),
  ('Tiradentes', -19.89822, -43.94138),
  ('Tirol', -19.98934, -44.04064),
  ('Três Marias', -19.85474, -43.90018),
  ('Trevo', -19.83488, -44.00945),
  ('Túnel de Ibirité', -19.98563, -44.04729),
  ('Tupi A', -19.83618, -43.92495),
  ('Tupi B', -19.83533, -43.91692),
  ('União', -19.88081, -43.92318),
  ('Unidas', -19.83768, -43.98112),
  ('Universitário', -19.86745, -43.94297),
  ('Universo', -19.83165, -43.98212),
  ('Urca', -19.87132, -44.01586),
  ('Vale do Jatobá', -20.00763, -44.03804),
  ('Várzea da Palma', -19.82460, -43.98597),
  ('Venda Nova', -19.81538, -43.95935),
  ('Ventosa', -19.95191, -43.97305),
  ('Vera Cruz', -19.91036, -43.89604),
  ('Vila Aeroporto', -19.84746, -43.94715),
  ('Vila Aeroporto Jaraguá', -19.85650, -43.95857),
  ('Vila Antena', -19.94857, -43.96242),
  ('Vila Antena Montanhês', -19.89624, -43.98613),
  ('Vila Átila de Paiva', -19.97920, -44.03146),
  ('Vila Bandeirantes', -19.95004, -43.96033),
  ('Vila Barragem Santa Lúcia', -19.95466, -43.94392),
  ('Vila Batik', -20.00072, -44.04181),
  ('Vila Betânia', -19.96290, -43.99769),
  ('Vila Boa Vista', -19.89508, -43.89389),
  ('Vila Calafate', -19.92481, -43.97462),
  ('Vila Califórnia', -19.91890, -44.00764),
  ('Vila Canto do Sabiá', -19.82460, -43.95759),
  ('Vila CEMIG', -19.99526, -43.99256),
  ('Vila Clóris', -19.82372, -43.94803),
  ('Vila Copacabana', -19.83690, -43.98502),
  ('Vila COPASA', -19.98134, -44.00628),
  ('Vila Coqueiral', -19.91594, -44.02489),
  ('Vila da Amizade', -19.92430, -43.98099),
  ('Vila da Área', -19.90570, -43.88571),
  ('Vila da Luz', -19.85621, -43.89544),
  ('Vila da Paz', -19.88090, -43.94584),
  ('Vila das Oliveiras', -19.92578, -43.98576),
  ('Vila de Sá', -19.87679, -43.92129),
  ('Vila Dias', -19.91874, -43.92252),
  ('Vila do Pombal', -19.89629, -43.93954),
  ('Vila dos Anjos', -19.82049, -43.99498),
  ('Vila Ecológica', -20.01207, -44.01928),
  ('Vila Engenho Nogueira', -19.88975, -43.98444),
  ('Vila Esplanada', -19.85419, -43.91989),
  ('Vila Formosa', -19.99896, -44.03021),
  ('Vila FUMEC', -19.94388, -43.92452),
  ('Vila Havaí', -19.96172, -43.97108),
  ('Vila Independência I', -20.01695, -44.02635),
  ('Vila Independência II', -20.01742, -44.02240),
  ('Vila Independência IV', -20.01870, -44.03059),
  ('Vila Inestan', -19.87451, -43.94923),
  ('Vila Ipiranga', -19.88713, -43.93357),
  ('Vila Jardim Alvorada', -19.89269, -43.98670),
  ('Vila Jardim Leblon', -19.82218, -43.99030),
  ('Vila Jardim Montanhês', -19.89869, -43.98436),
  ('Vila Jardim São José', -19.90213, -43.99212),
  ('Vila Madre Gertrudes I', -19.95090, -44.00381),
  ('Vila Madre Gertrudes II', -19.95056, -44.00570),
  ('Vila Madre Gertrudes III', -19.95011, -44.00903),
  ('Vila Madre Gertrudes V', -19.95386, -44.00605),
  ('Vila Maloca', -19.87985, -43.95262),
  ('Vila Mangueiras', -20.01643, -44.03548),
  ('Vila Mantiqueira', -19.78753, -43.97951),
  ('Vila Maria', -19.85206, -43.88581),
  ('Vila Minaslândia', -19.85924, -43.92824),
  ('Vila Nossa Senhora Aparecida', -19.82391, -43.96789),
  ('Vila Nossa Senhora do Rosário', -19.90981, -43.90593),
  ('Vila Nova', -19.80265, -43.94655),
  ('Vila Nova Cachoeirinha I', -19.88399, -43.95285),
  ('Vila Nova Cachoeirinha II', -19.88851, -43.95585),
  ('Vila Nova Cachoeirinha IV', -19.88355, -43.94750),
  ('Vila Nova dos Milionários', -19.98227, -44.00053),
  ('Vila Nova Gameleira I', -19.94068, -43.99733),
  ('Vila Nova Gameleira II', -19.93960, -43.99214),
  ('Vila Nova Gameleira III', -19.93466, -43.99393),
  ('Vila Nova Paraíso', -19.97799, -43.98619),
  ('Vila Novo São Lucas', -19.93229, -43.90931),
  ('Vila Oeste', -19.93658, -44.00331),
  ('Vila Olhos d''Água', -19.99572, -43.96566),
  ('Vila Ouro Minas', -19.84602, -43.91040),
  ('Vila Paquetá', -19.86633, -43.99343),
  ('Vila Paraíso', -19.91891, -43.90295),
  ('Vila Paris', -19.95073, -43.95040),
  ('Vila Petrópolis', -20.01364, -44.02897),
  ('Vila Pilar', -19.99799, -43.96405),
  ('Vila Pinho', -20.00187, -44.02428),
  ('Vila Piratininga', -19.99056, -44.05234),
  ('Vila Piratininga Venda Nova', -19.81065, -43.99343),
  ('Vila Primeiro de Maio', -19.86159, -43.93106),
  ('Vila PUC', -19.92027, -43.99458),
  ('Vila Real I', -19.87865, -43.95405),
  ('Vila Real II', -19.87582, -43.95078),
  ('Vila Rica', -19.85565, -43.95356),
  ('Vila Santa Mônica', -19.81784, -43.99357),
  ('Vila Santa Rosa', -19.87212, -43.95059),
  ('Vila Santo Antônio', -19.86154, -43.95824),
  ('Vila Santo Antônio Barroquinha', -19.88956, -44.01115),
  ('Vila São Dimas', -19.86058, -43.92053),
  ('Vila São Francisco', -19.88073, -43.96290),
  ('Vila São Gabriel', -19.84638, -43.91283),
  ('Vila São Gabriel Jacuí', -19.86240, -43.92436),
  ('Vila São Geraldo', -19.89582, -43.89895),
  ('Vila São João Batista', -19.82158, -43.96244),
  ('Vila São Paulo', -19.86630, -43.92309),
  ('Vila São Rafael', -19.91301, -43.90663),
  ('Vila Satélite', -19.81648, -43.94960),
  ('Vila SESC', -19.80242, -43.97537),
  ('Vila Sumaré', -19.88832, -43.96514),
  ('Vila Suzana I', -19.86241, -43.93343),
  ('Vila Suzana II', -19.86606, -43.93329),
  ('Vila Tirol', -19.98381, -44.03545),
  ('Vila Trinta e Um de Março', -19.92069, -44.00078),
  ('Vila União', -19.92038, -43.91886),
  ('Vila Vera Cruz I', -19.90691, -43.89745),
  ('Vila Vera Cruz II', -19.91116, -43.89766),
  ('Vila Vista Alegre', -19.95426, -43.99272),
  ('Virgínia', -19.94526, -44.01992),
  ('Vista Alegre', -19.95412, -43.99990),
  ('Vista do Sol', -19.84943, -43.89139),
  ('Vitória', -19.86186, -43.88826),
  ('Vitória da Conquista', -20.01458, -44.02367),
  ('Xangri-lá', -19.84189, -44.01651),
  ('Xodó-Marize', -19.82145, -43.93913),
  ('Zilah Spósito', -19.80112, -43.92501)
on conflict (nome) do update set lat = excluded.lat, lng = excluded.lng;
