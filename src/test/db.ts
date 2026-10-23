import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

// Minimal stand-ins for what Supabase provides, so the real migrations run unchanged.
const SUPABASE_STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create publication supabase_realtime;
`;

const MIGRATIONS = [
  "0000_quadras_mvp",
  "0001_multi_local_bh",
  "0002_cnpj_local",
  "0003_busca_horario",
];

/** A fresh Postgres (WASM, in-process) with every migration applied. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  for (const name of MIGRATIONS) {
    const sql = readFileSync(
      path.resolve(__dirname, `../../drizzle/migrations/${name}.sql`),
      "utf8",
    );
    await db.exec(sql);
  }
  return db;
}
