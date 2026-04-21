import { neon } from "@neondatabase/serverless";
import { env, hasEnvValue } from "@/lib/env";

type NeonSqlClient = ReturnType<typeof neon>;

let neonSqlClient: NeonSqlClient | null = null;
let ensureOperatorStoreSchemaPromise: Promise<void> | null = null;

function getDatabaseUrl() {
  return env.databaseUrl;
}

export function isNeonConfigured() {
  return hasEnvValue(getDatabaseUrl());
}

export function getNeonSql() {
  const databaseUrl = getDatabaseUrl();

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is not configured. Attach a Neon database before enabling the Neon-backed operator store.",
    );
  }

  if (!neonSqlClient) {
    neonSqlClient = neon(databaseUrl);
  }

  return neonSqlClient;
}

export async function ensureOperatorStoreSchema() {
  if (!ensureOperatorStoreSchemaPromise) {
    ensureOperatorStoreSchemaPromise = (async () => {
      const sql = getNeonSql();

      await sql`
        CREATE TABLE IF NOT EXISTS dpp_operator_objects (
          object_key TEXT PRIMARY KEY,
          object_kind TEXT NOT NULL,
          payload JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;

      await sql`
        CREATE INDEX IF NOT EXISTS dpp_operator_objects_kind_updated_idx
        ON dpp_operator_objects (object_kind, updated_at DESC)
      `;
    })().catch((error) => {
      ensureOperatorStoreSchemaPromise = null;
      throw error;
    });
  }

  await ensureOperatorStoreSchemaPromise;
}

export async function readNeonObject<T>(key: string) {
  await ensureOperatorStoreSchema();
  const sql = getNeonSql();
  const rows = (await sql`
    SELECT payload
    FROM dpp_operator_objects
    WHERE object_key = ${key}
    LIMIT 1
  `) as Array<{ payload: T }>;

  return rows[0]?.payload ?? null;
}

export async function writeNeonObject(
  key: string,
  kind: string,
  payload: unknown,
) {
  await ensureOperatorStoreSchema();
  const sql = getNeonSql();
  const serialized = JSON.stringify(payload);

  await sql`
    INSERT INTO dpp_operator_objects (object_key, object_kind, payload, updated_at)
    VALUES (${key}, ${kind}, ${serialized}::jsonb, NOW())
    ON CONFLICT (object_key) DO UPDATE
    SET object_kind = EXCLUDED.object_kind,
        payload = EXCLUDED.payload,
        updated_at = NOW()
  `;
}

export async function deleteNeonObject(key: string) {
  await ensureOperatorStoreSchema();
  const sql = getNeonSql();

  await sql`
    DELETE FROM dpp_operator_objects
    WHERE object_key = ${key}
  `;
}
