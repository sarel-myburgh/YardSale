import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.js";
import { paywayCallbackSignature } from "../src/billing.js";

function cookiesFrom(response) {
  return response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function csrfFrom(cookies) {
  const value = cookies.match(/yardsale_cloud_csrf=([^;]+)/)?.[1];
  return value ? decodeURIComponent(value) : "";
}

test("HTTP account, CSRF, store, marketplace, and health paths compose", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "yardsale-cloud-http-test-"));
  const app = createApp({ config: {
    dataDir,
    port: 0,
    baseDomain: "yardsale.test",
    runtimeKind: "local",
    runtimeExecute: false,
    backupDir: join(dataDir, "backups"),
    webhookSecret: "test-secret",
    requireEmailVerification: false,
    cookieSecure: false,
    trustProxy: true,
    trustedProxyAddresses: ["127.0.0.1"],
    billingProvider: "mock",
    abaMerchantId: "",
    abaApiKey: ""
  } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = app.server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "http@example.com", password: "correct horse battery", confirmPassword: "correct horse battery", countryCode: "KH" }),
      redirect: "manual"
    });
    assert.equal(signup.status, 303);
    const cookies = cookiesFrom(signup);
    const csrf = csrfFrom(cookies);
    assert.ok(csrf);

    const dashboard = await fetch(`${base}/dashboard`, { headers: { cookie: cookies } });
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /Seller dashboard/);

    const create = await fetch(`${base}/stores`, {
      method: "POST",
      headers: { cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, name: "HTTP Store", slug: "http-store" }),
      redirect: "manual"
    });
    assert.equal(create.status, 303);
    assert.match(create.headers.get("location"), /\/stores\/\d+/);
    const tenantHost = await new Promise((resolve, reject) => {
      const target = new URL(`${base}/`);
      const request = httpRequest(target, { headers: { host: "http-store.yardsale.test" } }, (result) => {
        let body = "";
        result.setEncoding("utf8");
        result.on("data", (chunk) => { body += chunk; });
        result.on("end", () => resolve({ status: result.statusCode, body }));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(tenantHost.status, 503);
    assert.match(tenantHost.body, /Tenant host routing is not configured/);
    const unknownHost = await new Promise((resolve, reject) => {
      const target = new URL(`${base}/`);
      const request = httpRequest(target, { headers: { host: "missing-store.yardsale.test" } }, (result) => {
        result.resume();
        result.on("end", () => resolve(result.statusCode));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(unknownHost, 404);

    const badLogin = () => fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.10" },
      body: new URLSearchParams({ email: "http@example.com", password: "wrong", next: "/dashboard" })
    });
    for (let attempt = 0; attempt < 8; attempt += 1) assert.equal((await badLogin()).status, 401);
    assert.equal((await badLogin()).status, 429);
    const otherClient = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "198.51.100.11" },
      body: new URLSearchParams({ email: "http@example.com", password: "wrong", next: "/dashboard" })
    });
    assert.equal(otherClient.status, 401);

    const marketplace = await fetch(`${base}/marketplace?q=lamp&condition=good`);
    assert.equal(marketplace.status, 200);
    assert.match(await marketplace.text(), /Local marketplace/);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("HTTP PayWay checkout and signed callback compose", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "yardsale-cloud-payway-http-test-"));
  const app = createApp({ config: {
    dataDir,
    port: 0,
    baseDomain: "yardsale.test",
    publicOrigin: "https://cloud.example",
    runtimeKind: "local",
    runtimeExecute: false,
    backupDir: join(dataDir, "backups"),
    backupIntervalMs: 24 * 60 * 60 * 1000,
    webhookSecret: "test-secret",
    requireEmailVerification: false,
    cookieSecure: false,
    billingProvider: "aba-payway",
    abaMerchantId: "ec000002",
    abaApiKey: "payway-test-key",
    abaBaseUrl: "https://checkout-sandbox.payway.com.kh"
  } });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const address = app.server.address();
    const base = `http://127.0.0.1:${address.port}`;
    const signup = await fetch(`${base}/signup`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "payway-http@example.com", password: "correct horse battery", confirmPassword: "correct horse battery", countryCode: "KH" }),
      redirect: "manual"
    });
    const cookies = cookiesFrom(signup);
    const csrf = csrfFrom(cookies);
    const create = await fetch(`${base}/stores`, {
      method: "POST",
      headers: { cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, name: "PayWay HTTP Store", slug: "payway-http-store" }),
      redirect: "manual"
    });
    const storeId = Number(create.headers.get("location").match(/\/stores\/(\d+)/)[1]);
    const checkout = await fetch(`${base}/stores/${storeId}/checkout`, {
      method: "POST",
      headers: { cookie: cookies, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf })
    });
    assert.equal(checkout.status, 200);
    assert.match(await checkout.text(), /Continue to ABA PayWay/);
    const payment = app.db.prepare("SELECT * FROM payments WHERE store_id = ?").get(storeId);
    const callback = { tran_id: payment.provider_reference, apv: "832865", status: "0", return_params: JSON.stringify({ payment_id: payment.id }) };
    const callbackBody = JSON.stringify(callback);
    const callbackResponse = await fetch(`${base}/api/payments/payway/callback`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payway-hmac-sha512": paywayCallbackSignature(callback, "payway-test-key") },
      body: callbackBody
    });
    assert.equal(callbackResponse.status, 200);
    assert.equal(app.db.prepare("SELECT status FROM payments WHERE id = ?").get(payment.id).status, "paid");
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
