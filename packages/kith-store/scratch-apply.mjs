import pg from "pg";
import { applyKithSchema, kithSchemaVersion } from "./dist/schema.js";
const base = process.env.KITH_STORE_DATABASE_URL;
const admin = new pg.Client({ connectionString: base });
await admin.connect();
const name = "m_" + Math.random().toString(36).slice(2, 10);
await admin.query(`CREATE DATABASE ${name}`);
await admin.end();
const url = new URL(base);
url.pathname = "/" + name;
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
try {
  console.log(
    "applied",
    await applyKithSchema(c),
    "version",
    await kithSchemaVersion(c),
  );
} finally {
  await c.end();
  const a2 = new pg.Client({ connectionString: base });
  await a2.connect();
  await a2.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await a2.end();
}
