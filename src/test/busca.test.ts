import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addDays, todayBRT } from "@/lib/time";
import { createTestDb } from "./db";

// Real SQL from the migrations, run in an in-process Postgres (PGlite).
// Dates are a week ahead so "already passed" never kicks in by accident.

const D = addDays(todayBRT(), 7);
const DOW = new Date(D + "T12:00:00Z").getUTCDay();
const SAVASSI = { lat: -19.93589, lng: -43.93444 };
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00-03:00`;

let db: PGlite;

async function venue(
  opts: { verified?: boolean; lat?: number; lng?: number; antecedencia?: number } = {},
) {
  const r = await db.query<{ id: string }>(
    `insert into venues(name, agenda_verificada, lat, lng, antecedencia_min_minutos, open_hour, close_hour)
     values ('Arena', $1, $2, $3, $4, 8, 23) returning id`,
    [
      opts.verified ?? true,
      opts.lat ?? SAVASSI.lat,
      opts.lng ?? SAVASSI.lng,
      opts.antecedencia ?? 0,
    ],
  );
  return r.rows[0]!.id;
}

// The insert trigger seeds 08:00–23:00 every day and a flat price of price_per_hour / 2 per block.
async function court(
  venueId: string,
  opts: { price?: number; modalidade?: string; name?: string } = {},
) {
  const r = await db.query<{ id: string }>(
    `insert into courts(venue_id, name, price_per_hour, modalidade) values ($1, $2, $3, $4) returning id`,
    [venueId, opts.name ?? "Quadra 1", opts.price ?? 200, opts.modalidade ?? "society"],
  );
  return r.rows[0]!.id;
}

async function slot(courtId: string, startsAt: string, blocked = false) {
  const r = await db.query<{ id: string }>(
    `insert into slots(court_id, starts_at, published, blocked) values ($1, $2, true, $3) returning id`,
    [courtId, startsAt, blocked],
  );
  return r.rows[0]!.id;
}

async function booking(slotId: string, status: string, expiresAt = "2999-01-01T00:00:00Z") {
  await db.query(
    `insert into bookings(slot_id, organizer_id, status, expires_at) values ($1, gen_random_uuid(), $2, $3)`,
    [slotId, status, expiresAt],
  );
}

async function disponibilidade(courtId: string, inicio: string, fim: string) {
  const r = await db.query<{ livre: boolean; motivo: string | null; preco_total: string | null }>(
    `select * from disponibilidade_quadra($1, $2, $3)`,
    [courtId, inicio, fim],
  );
  return r.rows[0]!;
}

type Hit = {
  court_id: string;
  inicio: string;
  preco_total: string;
  exato: boolean;
  diferenca_min: number;
  distancia_km: number | null;
};

async function buscar(
  hora: string,
  duracao = 60,
  opts: {
    day?: string;
    lat?: number | null;
    lng?: number | null;
    raio?: number;
    ordem?: string;
  } = {},
) {
  const r = await db.query<Hit>(
    `select court_id, to_char(inicio at time zone 'America/Sao_Paulo', 'HH24:MI') inicio,
            preco_total::text, exato, diferenca_min, distancia_km
     from buscar_quadras($1, $2, $3, 'society', $4, $5, $6, $7)`,
    [
      opts.day ?? D,
      hora,
      duracao,
      opts.lat === undefined ? SAVASSI.lat : opts.lat,
      opts.lng === undefined ? SAVASSI.lng : opts.lng,
      opts.raio ?? 10,
      opts.ordem ?? "distancia",
    ],
  );
  return r.rows;
}

beforeEach(async () => {
  db = await createTestDb();
  // Migration 0000 seeds a demo venue; start every test from a clean slate.
  await db.exec("delete from venues");
}, 60_000);

describe("disponibilidade e busca por horário", () => {
  it("encontra a quadra com o horário exato livre e o preço total", async () => {
    const c = await court(await venue());
    const hits = await buscar("20:00", 90);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ court_id: c, inicio: "20:00", exato: true, diferenca_min: 0 });
    expect(Number(hits[0]!.preco_total)).toBe(300); // 3 blocos × R$ 100
  });

  it("não mostra horário parcialmente ocupado e sugere horários próximos", async () => {
    const c = await court(await venue());
    await booking(await slot(c, at(D, "21:00")), "confirmada");

    expect((await disponibilidade(c, at(D, "20:00"), at(D, "21:30"))).motivo).toBe("reservado");
    const hits = await buscar("20:00", 90);
    expect(hits.every((h) => !h.exato)).toBe(true);
    // 19:30–21:00 (30 min antes) vem antes de 19:00–20:30 (1h antes); depois das 20h está ocupado.
    expect(hits.map((h) => h.inicio)).toEqual(["19:30", "19:00"]);
    expect(hits.map((h) => h.diferenca_min)).toEqual([30, 60]);
  });

  it("respeita o horário de funcionamento do dia da semana", async () => {
    const c = await court(await venue());
    expect((await disponibilidade(c, at(D, "22:30"), at(D, "23:30"))).motivo).toBe("fechado");
    expect((await disponibilidade(c, at(D, "07:30"), at(D, "08:30"))).motivo).toBe("fechado");

    await db.query(`delete from horarios_funcionamento where court_id = $1 and dia_semana = $2`, [
      c,
      DOW,
    ]);
    expect((await disponibilidade(c, at(D, "20:00"), at(D, "21:00"))).motivo).toBe("fechado");
    expect(
      (await disponibilidade(c, at(addDays(D, 1), "20:00"), at(addDays(D, 1), "21:00"))).livre,
    ).toBe(true);
  });

  it("não mostra horário bloqueado pelo dono", async () => {
    const c = await court(await venue());
    await slot(c, at(D, "20:00"), true);
    expect((await disponibilidade(c, at(D, "19:30"), at(D, "20:30"))).motivo).toBe("bloqueado");
    expect(await buscar("20:00")).not.toContainEqual(expect.objectContaining({ exato: true }));
  });

  it("não mostra horário de mensalista dentro da validade", async () => {
    const c = await court(await venue());
    await db.query(
      `insert into mensalistas(court_id, dia_semana, inicio, fim, nome, valido_de) values ($1, $2, '20:00', '21:00', 'Pelada do João', $3)`,
      [c, DOW, addDays(D, -30)],
    );
    expect((await disponibilidade(c, at(D, "20:30"), at(D, "21:30"))).motivo).toBe("mensalista");
    expect((await disponibilidade(c, at(D, "21:00"), at(D, "22:00"))).livre).toBe(true);

    await db.query(`update mensalistas set valido_ate = $1`, [addDays(D, -1)]);
    expect((await disponibilidade(c, at(D, "20:00"), at(D, "21:00"))).livre).toBe(true);
  });

  it("considera reserva pendente só enquanto o prazo de pagamento vale", async () => {
    const c = await court(await venue());
    // Prazo vencido, mas a rotina de expiração ainda não marcou como "expirada".
    await booking(await slot(c, at(D, "20:00")), "pendente", "2000-01-01T00:00:00Z");
    expect((await disponibilidade(c, at(D, "20:00"), at(D, "21:00"))).livre).toBe(true);
    await booking(await slot(c, at(D, "21:00")), "pendente");
    expect((await disponibilidade(c, at(D, "21:00"), at(D, "22:00"))).motivo).toBe("reservado");
  });

  it("não mostra horário que já passou nem dentro da antecedência mínima", async () => {
    const c = await court(await venue());
    const ontem = addDays(todayBRT(), -1);
    expect((await disponibilidade(c, at(ontem, "20:00"), at(ontem, "21:00"))).motivo).toBe(
      "passado",
    );
    expect(await buscar("20:00", 60, { day: ontem })).toEqual([]);

    const c2 = await court(await venue({ antecedencia: 60 * 24 * 10 }));
    expect((await disponibilidade(c2, at(D, "20:00"), at(D, "21:00"))).motivo).toBe("antecedencia");
  });

  it("esconde quadras de arenas sem agenda verificada", async () => {
    await court(await venue({ verified: false }));
    expect(await buscar("20:00")).toEqual([]);
  });

  it("soma preços diferentes por bloco (horário nobre)", async () => {
    const c = await court(await venue());
    await db.query(`delete from regras_preco where court_id = $1 and dia_semana = $2`, [c, DOW]);
    await db.query(
      `insert into regras_preco(court_id, dia_semana, inicio, fim, preco_bloco)
       values ($1, $2, '00:00', '18:00', 50), ($1, $2, '18:00', '24:00', 80)`,
      [c, DOW],
    );
    const hits = await buscar("17:30", 60);
    expect(Number(hits[0]!.preco_total)).toBe(130);
    expect(Number((await buscar("19:00", 120))[0]!.preco_total)).toBe(320);
  });

  it("esconde a quadra quando falta preço de um bloco e registra no log", async () => {
    const c = await court(await venue());
    await db.query(`delete from regras_preco where court_id = $1 and dia_semana = $2`, [c, DOW]);
    await db.query(
      `insert into regras_preco(court_id, dia_semana, inicio, fim, preco_bloco) values ($1, $2, '08:00', '20:30', 100)`,
      [c, DOW],
    );
    expect(await buscar("20:00", 60)).not.toContainEqual(
      expect.objectContaining({ inicio: "20:00" }),
    );
    const log = await db.query<{ bloco: string }>(
      `select bloco::text from precos_faltando where court_id = $1`,
      [c],
    );
    expect(log.rows.map((r) => r.bloco)).toContain("20:30:00");
  });

  it("filtra pelo raio e ordena por distância ou preço", async () => {
    const perto = await court(await venue(), { price: 300 });
    // ~2,2 km da Savassi
    const medio = await court(await venue({ lat: -19.9164, lng: -43.9443 }), { price: 100 });
    // Contagem, ~25 km
    await court(await venue({ lat: -19.9317, lng: -44.0536 }), { price: 50 });

    const porDistancia = await buscar("20:00", 60, { raio: 10 });
    expect(porDistancia.map((h) => h.court_id)).toEqual([perto, medio]);
    expect(porDistancia[1]!.distancia_km).toBeGreaterThan(1.5);
    expect(porDistancia[1]!.distancia_km).toBeLessThan(3);

    const porPreco = await buscar("20:00", 60, { raio: 10, ordem: "preco" });
    expect(porPreco.map((h) => h.court_id)).toEqual([medio, perto]);
  });

  it("busca sem localização ignora o raio", async () => {
    await court(await venue({ lat: -19.9317, lng: -44.0536 }));
    const hits = await buscar("20:00", 60, { lat: null, lng: null });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.distancia_km).toBeNull();
  });

  it("só sugere horários próximos na mesma data", async () => {
    const c = await court(await venue());
    await db.query(
      `update horarios_funcionamento set abre = '00:00', fecha = '24:00' where court_id = $1`,
      [c],
    );
    await booking(await slot(c, at(D, "23:00")), "confirmada");
    const hits = await buscar("23:00", 60);
    // 23:30 e 00:00 cruzariam para o dia seguinte; só ficam 22:00 e 22:30… e 22:30 bate com as 23h.
    expect(hits.map((h) => h.inicio)).toEqual(["22:00"]);
  });

  it("rejeita duração e horário fora do padrão", async () => {
    await court(await venue());
    await expect(buscar("20:00", 45)).rejects.toThrow(/Duração/);
    await expect(buscar("20:15", 60)).rejects.toThrow(/meia hora/);
  });

  it("agenda de 1h gerada respeita o funcionamento por dia", async () => {
    const v = await venue();
    const c = await court(v);
    await db.query(
      `update horarios_funcionamento set abre = '18:00', fecha = '22:00' where court_id = $1`,
      [c],
    );
    const gestor = "00000000-0000-0000-0000-000000000001";
    await db.query(`insert into auth.users(id, email) values ($1, 'g@teste.com')`, [gestor]);
    await db.query(`insert into venue_managers(venue_id, user_id) values ($1, $2)`, [v, gestor]);
    await db.exec(`set request.jwt.claim.sub = '00000000-0000-0000-0000-000000000001'`);
    const n = await db.query<{ n: number }>(`select generate_week($1::date, $2) n`, [D, v]);
    expect(n.rows[0]!.n).toBe(7 * 4);
  });
});

describe("migrações", () => {
  it("podem rodar de novo sem erro (já aplicadas à mão no Supabase)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    for (const name of ["0001_multi_local_bh", "0002_cnpj_local", "0003_busca_horario"]) {
      const sql = readFileSync(
        path.resolve(__dirname, `../../drizzle/migrations/${name}.sql`),
        "utf8",
      );
      await expect(db.exec(sql)).resolves.toBeDefined();
    }
  }, 60_000);
});
