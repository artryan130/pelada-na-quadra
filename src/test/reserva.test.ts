// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { mondayOf } from "@/lib/time";
import { asUser, createTestDb } from "./db";
import {
  D,
  at,
  bloqueio,
  booking,
  court,
  disponibilidade,
  gestorDe,
  user,
  venue,
} from "./fixtures";

// Booking lifecycle by interval (phase 2), against the real migrations.

let db: PGlite;
const ANA = "00000000-0000-0000-0000-00000000a0a0";
const BETO = "00000000-0000-0000-0000-00000000b0b0";
const GESTOR = "00000000-0000-0000-0000-00000000c0c0";

async function pedir(c: string, ini: string, fim: string) {
  const r = await db.query<{ id: string }>(`select request_booking($1, $2, $3) id`, [c, ini, fim]);
  return r.rows[0]!.id;
}
async function avisos(userId: string) {
  const r = await db.query<{ message: string; link: string }>(
    `select message, link from notifications where user_id = $1 order by created_at`,
    [userId],
  );
  return r.rows;
}
async function statusDe(id: string) {
  const r = await db.query<{ status: string }>(`select status from bookings where id = $1`, [id]);
  return r.rows[0]!.status;
}

let v: string;
let c: string;

beforeEach(async () => {
  db = await createTestDb();
  await db.exec("delete from venues");
  v = await venue(db);
  c = await court(db, v);
  await user(db, ANA, "Ana");
  await user(db, BETO, "Beto");
  await gestorDe(db, v, GESTOR);
}, 60_000);

describe("reserva por intervalo", () => {
  it("solicita 1h30 às 20h, guarda o preço e avisa o gestor", async () => {
    await asUser(db, ANA);
    const id = await pedir(c, at(D, "20:00"), at(D, "21:30"));
    const r = await db.query<{ status: string; preco: string; court_id: string }>(
      `select status, preco::text, court_id from bookings where id = $1`,
      [id],
    );
    expect(r.rows[0]).toMatchObject({ status: "pendente", preco: "300.00", court_id: c });
    const g = await avisos(GESTOR);
    expect(g).toHaveLength(1);
    expect(g[0]!.message).toMatch(/Nova solicitação: Arena · Quadra 1 · .* 20:00–21:30 por Ana/);
  });

  it("aceita meia hora quebrada e recusa sobreposição", async () => {
    await asUser(db, ANA);
    await pedir(c, at(D, "19:30"), at(D, "21:00"));
    await asUser(db, BETO);
    await expect(pedir(c, at(D, "20:30"), at(D, "21:30"))).rejects.toThrow(/já pediu/);
    // Encostado no fim da outra reserva pode.
    await expect(pedir(c, at(D, "21:00"), at(D, "22:00"))).resolves.toBeTruthy();
  });

  it("a constraint do banco impede sobreposição mesmo sem passar pela função", async () => {
    await booking(db, c, at(D, "20:00"), at(D, "21:30"), "confirmada");
    await expect(booking(db, c, at(D, "21:00"), at(D, "22:00"), "pendente")).rejects.toMatchObject({
      code: "23P01",
    });
    // Reserva recusada/cancelada não ocupa.
    await expect(booking(db, c, at(D, "21:00"), at(D, "22:00"), "cancelada")).resolves.toBeTruthy();
  });

  it("recusa horário fechado, não publicado ou fora dos blocos de 30 min", async () => {
    await asUser(db, ANA);
    await expect(pedir(c, at(D, "22:30"), at(D, "23:30"))).rejects.toThrow(/fechada/);
    await expect(pedir(c, at(D, "20:15"), at(D, "21:15"))).rejects.toThrow(/inválido/);
    await db.query(`delete from semanas_publicadas`);
    await expect(pedir(c, at(D, "20:00"), at(D, "21:00"))).rejects.toThrow(/não abriu a agenda/);
  });

  it("gestor confirma; organizador não cancela depois do limite", async () => {
    await asUser(db, ANA);
    const id = await pedir(c, at(D, "20:00"), at(D, "21:00"));
    await asUser(db, BETO);
    await expect(db.query(`select confirm_booking($1)`, [id])).rejects.toThrow(/Sem permissão/);
    await asUser(db, GESTOR);
    await db.query(`select confirm_booking($1)`, [id]);
    expect(await statusDe(id)).toBe("confirmada");
    expect((await avisos(ANA)).at(-1)!.link).toBe(`/reserva/${id}`);

    await db.query(`update venues set cancel_limit_hours = 24 * 30`);
    await asUser(db, ANA);
    await expect(db.query(`select cancel_booking($1)`, [id])).rejects.toThrow(
      /horas antes do jogo/,
    );
    await asUser(db, GESTOR);
    await db.query(`select cancel_booking($1)`, [id]);
    expect(await statusDe(id)).toBe("cancelada");
  });

  it("cancelamento avisa a fila com o link da quadra no horário", async () => {
    await asUser(db, ANA);
    const id = await pedir(c, at(D, "20:00"), at(D, "21:30"));

    await asUser(db, BETO);
    await expect(
      db.query(`select entrar_fila($1, $2, $3)`, [c, at(D, "21:00"), at(D, "22:00")]),
    ).resolves.toBeDefined();
    // Horário livre não entra na fila: é só pedir.
    await expect(
      db.query(`select entrar_fila($1, $2, $3)`, [c, at(D, "18:00"), at(D, "19:00")]),
    ).rejects.toThrow(/é só solicitar/);

    await asUser(db, ANA);
    await db.query(`select cancel_booking($1)`, [id]);
    const b = await avisos(BETO);
    expect(b).toHaveLength(1);
    expect(b[0]!.message).toMatch(/^Vagou! .* 21:00–22:00/);
    expect(b[0]!.link).toMatch(new RegExp(`^/quadra/${c}\\?inicio=.*Z&duracao=60$`));
  });

  it("fila só é avisada se o intervalo inteiro ficou livre", async () => {
    await booking(db, c, at(D, "21:00"), at(D, "22:00"), "confirmada");
    await asUser(db, ANA);
    const id = await pedir(c, at(D, "20:00"), at(D, "21:00"));
    await asUser(db, BETO);
    await db.query(`select entrar_fila($1, $2, $3)`, [c, at(D, "20:00"), at(D, "22:00")]);
    await asUser(db, ANA);
    await db.query(`select cancel_booking($1)`, [id]);
    expect(await avisos(BETO)).toEqual([]); // 21h–22h continua ocupado
  });

  it("solicitação vencida expira, libera o horário e avisa a fila", async () => {
    const id = await booking(db, c, at(D, "20:00"), at(D, "21:00"), "pendente", {
      organizer: ANA,
      expiresAt: "2000-01-01T00:00:00Z",
    });
    await db.query(
      `insert into waitlist(court_id, starts_at, ends_at, organizer_id) values ($1, $2, $3, $4)`,
      [c, at(D, "20:00"), at(D, "21:00"), BETO],
    );
    await db.query(`select expire_bookings()`);
    expect(await statusDe(id)).toBe("expirada");
    expect((await avisos(ANA))[0]!.message).toMatch(/expirou/);
    expect((await avisos(BETO))[0]!.message).toMatch(/^Vagou!/);
  });

  it("pedido sai da fila de quem estava esperando e marca de onde veio", async () => {
    await db.query(
      `insert into waitlist(court_id, starts_at, ends_at, organizer_id) values ($1, $2, $3, $4)`,
      [c, at(D, "20:00"), at(D, "21:00"), ANA],
    );
    await asUser(db, ANA);
    const id = await pedir(c, at(D, "20:00"), at(D, "21:30"));
    const r = await db.query<{ from_waitlist: boolean }>(
      `select from_waitlist from bookings where id = $1`,
      [id],
    );
    expect(r.rows[0]!.from_waitlist).toBe(true);
    const fila = await db.query(`select 1 from waitlist where organizer_id = $1`, [ANA]);
    expect(fila.rows).toHaveLength(0);
  });
});

describe("gestor", () => {
  it("bloqueia e libera só parte de um bloqueio maior", async () => {
    await asUser(db, GESTOR);
    await db.query(`select set_bloqueio($1, $2, $3, true, 'Evento')`, [
      c,
      at(D, "18:00"),
      at(D, "22:00"),
    ]);
    await db.query(`select set_bloqueio($1, $2, $3, false)`, [c, at(D, "19:00"), at(D, "20:00")]);
    const r = await db.query<{ ini: string; fim: string; nota: string }>(
      `select to_char(starts_at at time zone 'America/Sao_Paulo', 'HH24:MI') ini,
              to_char(ends_at at time zone 'America/Sao_Paulo', 'HH24:MI') fim, nota
       from bloqueios order by starts_at`,
    );
    expect(r.rows).toEqual([
      { ini: "18:00", fim: "19:00", nota: "Evento" },
      { ini: "20:00", fim: "22:00", nota: "Evento" },
    ]);
    expect((await disponibilidade(db, c, at(D, "19:00"), at(D, "20:00"))).livre).toBe(true);
  });

  it("não deixa bloquear por cima de reserva do app nem gestor de outro local", async () => {
    await booking(db, c, at(D, "20:00"), at(D, "21:00"), "confirmada");
    await asUser(db, GESTOR);
    await expect(
      db.query(`select set_bloqueio($1, $2, $3, true)`, [c, at(D, "20:30"), at(D, "21:30")]),
    ).rejects.toThrow(/reserva no app/);
    await asUser(db, BETO);
    await expect(
      db.query(`select set_bloqueio($1, $2, $3, true)`, [c, at(D, "18:00"), at(D, "19:00")]),
    ).rejects.toThrow(/Sem permissão/);
  });

  it("publica e despublica a semana", async () => {
    await db.query(`delete from semanas_publicadas`);
    await asUser(db, GESTOR);
    await db.query(`select publish_week($1, $2, true)`, [mondayOf(D), v]);
    expect((await disponibilidade(db, c, at(D, "20:00"), at(D, "21:00"))).livre).toBe(true);
    await db.query(`select publish_week($1, $2, false)`, [mondayOf(D), v]);
    expect((await disponibilidade(db, c, at(D, "20:00"), at(D, "21:00"))).motivo).toBe(
      "nao_publicado",
    );
  });

  it("grade da semana mostra reserva de 1h30 nas duas horas, bloqueio e mensalista", async () => {
    await booking(db, c, at(D, "20:00"), at(D, "21:30"), "pendente");
    await bloqueio(db, c, at(D, "18:00"), at(D, "19:00"));
    const dow = new Date(D + "T12:00:00Z").getUTCDay();
    await db.query(
      `insert into mensalistas(court_id, dia_semana, inicio, fim, nome) values ($1, $2, '09:00', '10:00', 'Fixos')`,
      [c, dow],
    );
    await asUser(db, GESTOR);
    const r = await db.query<{ hora: number; estado: string; nota: string | null }>(
      `select hora, estado, nota from agenda_gestor($1, $2) where dia = $3 order by hora`,
      [v, mondayOf(D), D],
    );
    const porHora = Object.fromEntries(r.rows.map((x) => [x.hora, x.estado]));
    expect(r.rows.map((x) => x.hora)).toEqual(Array.from({ length: 15 }, (_, i) => 8 + i));
    expect(porHora).toMatchObject({
      9: "mensalista",
      18: "bloqueado",
      19: "livre",
      20: "pendente",
      21: "pendente",
    });
    expect(r.rows.find((x) => x.hora === 9)!.nota).toBe("Fixos");
  });

  it("agenda do dia do organizador mostra ocupado, aguardando e a reserva dele", async () => {
    await booking(db, c, at(D, "18:00"), at(D, "19:00"), "confirmada");
    await booking(db, c, at(D, "19:00"), at(D, "20:00"), "pendente");
    await asUser(db, ANA);
    const minha = await pedir(c, at(D, "20:00"), at(D, "21:30"));
    const r = await db.query<{ h: string; state: string; my_booking_id: string | null }>(
      `select to_char(inicio at time zone 'America/Sao_Paulo', 'HH24') h, state, my_booking_id
       from agenda_dia($1)`,
      [D],
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.h, x]));
    expect(by["17"]!.state).toBe("livre");
    expect(by["18"]!.state).toBe("ocupado");
    expect(by["19"]!.state).toBe("aguardando");
    expect(by["21"]!.my_booking_id).toBe(minha);
  });
});
