import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AbaPayWayProvider, paywayCallbackSignature, paywayPurchaseHash } from "../src/billing.js";
import { createHostedStore, createUser, getHostedStore, openDatabase } from "../src/db.js";

test("PayWay adapter creates a signed checkout and idempotently records callbacks", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-cloud-payway-"));
  const db = openDatabase(dataDir);
  try {
    const user = createUser(db, { email: "payway@example.com", passwordHash: "hash", countryCode: "KH" });
    const store = createHostedStore(db, {
      userId: user.id,
      name: "PayWay test store",
      slug: "payway-test-store",
      hostname: "payway-test-store.yardsale.test",
      imageVersion: "yardsale:1.0.0",
      freeDays: 14
    });
    const provider = new AbaPayWayProvider({
      merchantId: "ec000002",
      apiKey: "payway-test-key",
      baseUrl: "https://checkout-sandbox.payway.com.kh"
    });
    const payment = provider.createCheckout(db, {
      userId: user.id,
      storeId: store.id,
      actor: user.email,
      returnUrl: "https://cloud.example/api/payments/payway/callback",
      cancelUrl: "https://cloud.example/stores/1",
      successUrl: "https://cloud.example/billing?paid=1"
    });
    assert.equal(payment.provider, "aba-payway");
    assert.equal(payment.checkout.action, "https://checkout-sandbox.payway.com.kh/api/payment-gateway/v1/payments/purchase");
    assert.equal(payment.checkout.fields.hash, paywayPurchaseHash(payment.checkout.fields, "payway-test-key"));
    assert.ok(payment.checkout.fields.tran_id.length <= 20);

    const callback = { tran_id: payment.provider_reference, apv: "832865", status: "0", return_params: JSON.stringify({ payment_id: payment.id }) };
    const signature = paywayCallbackSignature(callback, "payway-test-key");
    assert.equal(provider.verifyWebhook(JSON.stringify(callback), signature), true);
    assert.equal(provider.verifyWebhook(JSON.stringify(callback), "bad"), false);
    assert.equal(provider.recordWebhook(db, callback).status, "paid");
    assert.equal(provider.recordWebhook(db, callback).status, "paid");
    assert.equal(getHostedStore(db, store.id).mode, "paid");
  } finally {
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
