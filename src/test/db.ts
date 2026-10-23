import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

// Minimal stand-ins for what Supabase provides, so the real migrations run unchanged.
const SUPABASE_STUBS = `
  create role anon; create role authenticated; create role service_role;
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create publication supabase_realtime;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean,
    file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
  alter table storage.objects enable row level security;
  grant usage on schema storage, auth to authenticated;
  grant select, insert, update, delete on storage.objects to authenticated;
`;

export const MIGRATIONS = [
  "0000_quadras_mvp",
  "0001_multi_local_bh",
  "0002_cnpj_local",
  "0003_busca_horario",
  "0004_reserva_intervalo",
  "0005_fotos_quadras",
];

export function migrationSql(name: string): string {
  return readFileSync(path.resolve(__dirname, `../../drizzle/migrations/${name}.sql`), "utf8");
}

/** A fresh Postgres (WASM, in-process) with every migration applied. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(SUPABASE_STUBS);
  for (const name of MIGRATIONS) await db.exec(migrationSql(name));
  return db;
}

/** Acts as this user for auth.uid() in the following statements. */
export async function asUser(db: PGlite, userId: string | null) {
  await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId ?? ""]);
}
