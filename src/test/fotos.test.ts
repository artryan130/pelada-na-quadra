// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createTestDb } from "./db";
import { court, gestorDe, venue } from "./fixtures";

// Storage policies for court photos, checked as the "authenticated" role so RLS applies.

let db: PGlite;
const GESTOR = "00000000-0000-0000-0000-00000000c0c0";
const OUTRO = "00000000-0000-0000-0000-00000000d0d0";
let meu: string;
let alheio: string;

async function enviar(caminho: string) {
  await db.exec("set role authenticated");
  try {
    await db.query(`insert into storage.objects(bucket_id, name) values ('quadras', $1)`, [
      caminho,
    ]);
  } finally {
    await db.exec("reset role");
  }
}

beforeEach(async () => {
  db = await createTestDb();
  await db.exec("delete from venues");
  meu = await venue(db);
  alheio = await venue(db);
  await gestorDe(db, meu, GESTOR);
  await gestorDe(db, alheio, OUTRO);
}, 60_000);

describe("fotos das quadras", () => {
  it("cria o bucket público", async () => {
    const r = await db.query<{ public: boolean }>(
      `select public from storage.buckets where id = 'quadras'`,
    );
    expect(r.rows[0]?.public).toBe(true);
  });

  it("gestor envia foto só na pasta do próprio local", async () => {
    const c = await court(db, meu);
    await asUser(db, GESTOR);
    await expect(enviar(`${meu}/${c}/foto.jpg`)).resolves.toBeUndefined();
    await expect(enviar(`${alheio}/x/foto.jpg`)).rejects.toThrow(/row-level security/);
    await expect(enviar(`nao-e-uuid/foto.jpg`)).rejects.toThrow(/row-level security/);
  });

  it("organizador não envia foto", async () => {
    await asUser(db, "00000000-0000-0000-0000-00000000a0a0");
    await expect(enviar(`${meu}/x/foto.jpg`)).rejects.toThrow(/row-level security/);
  });
});
