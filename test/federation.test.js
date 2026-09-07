import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createSetup, getStore, openDatabase, updateStore } from "../src/db.js";
import { federationControlSignature } from "../src/federation.js";
import { handleRequest } from "../src/server.js";

test("federation control route requires a signature and updates public settings", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-federation-route-"));
  const db = openDatabase(dataDir);
  const secret = "managed-control-secret";
  const server = createServer((request, response) => {
    handleRequest(request, response, db, { dataDir, cookieSecure: false, port: 0 }).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });

  try {
    createSetup(db, { login: "owner", passwordHash: "hash", storeName: "Store", currency: "USD", timezone: "UTC" });
    updateStore(db, {
      ...getStore(db),
      location: "Phnom Penh",
      structuredLocation: { city: "Phnom Penh", countryCode: "KH", countryName: "Cambodia" },
      federationEnabled: false,
      federationControlSecret: secret
    });

    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const manifestResponse = await fetch(`${origin}/.well-known/yardsale-store.json`);
    const manifest = await manifestResponse.json();
    assert.deepEqual(manifest.location, {
      country_code: "KH",
      country_name: "Cambodia",
      region: null,
      city: "Phnom Penh",
      area: null,
      display_location: "Phnom Penh",
      latitude: null,
      longitude: null
    });

    const body = JSON.stringify({ federation_enabled: true });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = federationControlSignature(secret, timestamp, body);
    const rejected = await fetch(`${origin}/api/federation/v1/control`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-yardsale-timestamp": timestamp, "x-yardsale-signature": "sha256=wrong" },
      body
    });
    assert.equal(rejected.status, 401);

    const accepted = await fetch(`${origin}/api/federation/v1/control`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-yardsale-timestamp": timestamp, "x-yardsale-signature": signature },
      body
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, federation_enabled: true });
    assert.equal(getStore(db).federationEnabled, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
