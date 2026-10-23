import type { PGlite } from "@electric-sql/pglite";
import { addDays, mondayOf, todayBRT } from "@/lib/time";

// Shared builders for the database tests. Dates are a week ahead so "already passed"
// never kicks in by accident.

export const D = addDays(todayBRT(), 7);
export const DOW = new Date(D + "T12:00:00Z").getUTCDay();
export const SAVASSI = { lat: -19.93589, lng: -43.93444 };
export const at = (day: string, hhmm: string) => `${day}T${hhmm}:00-03:00`;

export async function venue(
  db: PGlite,
  opts: {
    verified?: boolean;
    published?: boolean;
    lat?: number;
    lng?: number;
    antecedencia?: number;
    cancelLimitHours?: number;
  } = {},
) {
  const r = await db.query<{ id: string }>(
    `insert into venues(name, agenda_verificada, lat, lng, antecedencia_min_minutos, cancel_limit_hours, open_hour, close_hour)
     values ('Arena', $1, $2, $3, $4, $5, 8, 23) returning id`,
    [
      opts.verified ?? true,
      opts.lat ?? SAVASSI.lat,
      opts.lng ?? SAVASSI.lng,
      opts.antecedencia ?? 0,
      opts.cancelLimitHours ?? 24,
    ],
  );
  const id = r.rows[0]!.id;
  if (opts.published ?? true) {
    await db.query(`insert into semanas_publicadas(venue_id, segunda) values ($1, $2)`, [
      id,
      mondayOf(D),
    ]);
  }
  return id;
}

// The insert trigger seeds 08:00–23:00 every day and a flat price of price_per_hour / 2 per block.
export async function court(
  db: PGlite,
  venueId: string,
  opts: { price?: number; modalidade?: string; name?: string } = {},
) {
  const r = await db.query<{ id: string }>(
    `insert into courts(venue_id, name, price_per_hour, modalidade) values ($1, $2, $3, $4) returning id`,
    [venueId, opts.name ?? "Quadra 1", opts.price ?? 200, opts.modalidade ?? "society"],
  );
  return r.rows[0]!.id;
}

export async function bloqueio(db: PGlite, courtId: string, inicio: string, fim: string) {
  await db.query(`insert into bloqueios(court_id, starts_at, ends_at) values ($1, $2, $3)`, [
    courtId,
    inicio,
    fim,
  ]);
}

export async function booking(
  db: PGlite,
  courtId: string,
  inicio: string,
  fim: string,
  status: string,
  opts: { expiresAt?: string; organizer?: string } = {},
) {
  const r = await db.query<{ id: string }>(
    `insert into bookings(court_id, starts_at, ends_at, organizer_id, status, expires_at)
     values ($1, $2, $3, coalesce($4::uuid, gen_random_uuid()), $5, $6) returning id`,
    [
      courtId,
      inicio,
      fim,
      opts.organizer ?? null,
      status,
      opts.expiresAt ?? "2999-01-01T00:00:00Z",
    ],
  );
  return r.rows[0]!.id;
}

export async function user(db: PGlite, id: string, name = "Fulano") {
  await db.query(`insert into auth.users(id, email, raw_user_meta_data) values ($1, $2, $3)`, [
    id,
    `${id.slice(-4)}@teste.com`,
    JSON.stringify({ name, role: "organizador" }),
  ]);
  return id;
}

export async function gestorDe(db: PGlite, venueId: string, id: string) {
  await db.query(`insert into auth.users(id, email) values ($1, $2)`, [
    id,
    `${id.slice(-4)}@gestor.com`,
  ]);
  await db.query(`insert into venue_managers(venue_id, user_id) values ($1, $2)`, [venueId, id]);
  return id;
}

export async function disponibilidade(db: PGlite, courtId: string, inicio: string, fim: string) {
  const r = await db.query<{ livre: boolean; motivo: string | null; preco_total: string | null }>(
    `select * from disponibilidade_quadra($1, $2, $3)`,
    [courtId, inicio, fim],
  );
  return r.rows[0]!;
}
