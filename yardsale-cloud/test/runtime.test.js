import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalRuntime, PodmanRuntime, validateImageVersion } from "../src/runtime.js";

const store = { public_id: "runtime-test", hostname: "runtime-test.yardsale.test", image_version: "yardsale:test", runtime_port: 3310 };

test("runtime image references reject unit-file control characters", () => {
  assert.equal(validateImageVersion("yardsale:1.0.0"), "yardsale:1.0.0");
  assert.throws(() => validateImageVersion("yardsale:latest\nExecStart=/bin/sh"), /unsupported characters/);
});

test("local runtime is idempotent and keeps tenant data isolated", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "yardsale-runtime-test-"));
  try {
    const runtime = new LocalRuntime(dataDir);
    assert.deepEqual(await runtime.createInstance({ store }), { runtimeInstanceId: "local:runtime-test", state: "running" });
    assert.equal((await runtime.createInstance({ store })).runtimeInstanceId, "local:runtime-test");
    assert.equal((await runtime.inspectInstance({ store })).exists, true);
    await runtime.suspendInstance({ store });
    assert.equal((await runtime.inspectInstance({ store })).state, "stopped");
    assert.match(readFileSync(join(dataDir, "instances", store.public_id, "instance.env"), "utf8"), /^YARDSALE_CLOUD_INSTANCE_SECRET=/);
    await runtime.deleteInstance({ store });
    assert.equal(existsSync(join(dataDir, "instances", store.public_id)), false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("Podman adapter emits a rootless, restartable Quadlet unit without executing it", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "yardsale-quadlet-test-"));
  try {
    const runtime = new PodmanRuntime({ dataDir, execute: false });
    const result = await runtime.createInstance({ store });
    assert.equal(result.state, "provisioning");
    const unit = readFileSync(join(dataDir, "quadlet", "yardsale-runtime-test.container"), "utf8");
    assert.match(unit, /ReadOnly=true/);
    assert.match(unit, /DropCapability=ALL/);
    assert.match(unit, /PublishPort=127\.0\.0\.1:3310:3000/);
    assert.match(unit, /EnvironmentFile=/);
    assert.equal((await runtime.inspectInstance({ store })).exists, true);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
