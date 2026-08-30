import test from "node:test";
import assert from "node:assert/strict";
import {
  isRailwayPgHost,
  resolvePgSsl,
  stripPgUrlSslParams,
} from "../pgSsl.js";

test("Railway hosts are classified narrowly", () => {
  assert.equal(isRailwayPgHost("altaria.proxy.rlwy.net"), true);
  assert.equal(isRailwayPgHost("postgres.railway.internal"), true);
  assert.equal(isRailwayPgHost("db.example.com"), false);
  assert.equal(isRailwayPgHost("localhost"), false);
});

test("non-Railway remote hosts keep full certificate verification", () => {
  const r = resolvePgSsl({ host: "db.example.com" });
  assert.equal(r.tlsMode, "verify-full");
  assert.equal(r.ssl.rejectUnauthorized, true);
  assert.equal(r.certificateVerification, "enabled");
});

test("loopback does not enable SSL unless POSTGRES_SSL=true", () => {
  const off = resolvePgSsl({ host: "127.0.0.1", env: {} });
  assert.equal(off.ssl, false);
  const on = resolvePgSsl({ host: "localhost", env: { POSTGRES_SSL: "true" } });
  assert.equal(on.ssl.rejectUnauthorized, true);
});

test("Railway without a pinned CA uses sslmode=require equivalent, not a process-wide TLS bypass", () => {
  const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  const r = resolvePgSsl({ host: "altaria.proxy.rlwy.net", env: {} });
  assert.equal(r.tlsMode, "require-railway");
  assert.equal(r.ssl.rejectUnauthorized, false);
  assert.ok(r.ssl);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, before);
});

test("Railway with a pinned CA verifies the chain", () => {
  const ca = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
  const r = resolvePgSsl({
    host: "altaria.proxy.rlwy.net",
    env: { POSTGRES_SSL_CA: ca },
  });
  assert.equal(r.tlsMode, "verify-ca-railway");
  assert.equal(r.ssl.rejectUnauthorized, true);
  assert.equal(r.ssl.ca, ca);
  assert.equal(typeof r.ssl.checkServerIdentity, "function");
});

test("stripPgUrlSslParams removes sslmode so the ssl object is not overwritten", () => {
  const out = stripPgUrlSslParams("postgres://u:p@h:5432/db?sslmode=require&sslnegotiation=direct");
  const u = new URL(out);
  assert.equal(u.searchParams.get("sslmode"), null);
  assert.equal(u.searchParams.get("sslnegotiation"), null);
  assert.equal(u.username, "u");
});
