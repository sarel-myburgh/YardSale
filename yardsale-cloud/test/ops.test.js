import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedStore, createUser, getHostedStore, openDatabase, setStoreRuntime } from "../src/db.js";
import { createBackup, migrateStore, upgradeStores } from "../src/ops.js";
import { LocalRuntime, PodmanRuntime } from "../src/runtime.js";

test("Podman migration is rejected before it stops or reallocates a store", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "yardsale-cloud-migration-"));
  const db = openDatabase(dataDir);
  try {
    const user = createUser(db, { email: "migration@example.com", passwordHash: "hash" });
    const store = createHostedStore(db, {
      userId: user.id,
      name: "Migration test",
      slug: "migration-test",
      hostname: "migration-test.yardsale.local",
      imageVersion: "yardsale:1.0.0",
      freeDays: 14
    });
    setStoreRuntime(db, store.id, { runtimeInstanceId: "podman:source", state: "running" });
    const destination = db.prepare("INSERT INTO deployment_hosts (hostname, region, status, created_at) VALUES (?, ?, 'ready', ?)").run("remote", "test", new Date().toISOString());
    const runtime = new PodmanRuntime({ dataDir, execute: false });
    await assert.rejects(
      migrateStore(db, runtime, { storeId: store.id, destinationHostId: Number(destination.lastInsertRowid), actor: user.email }),
      /unavailable.*data transfer/
    );
    const unchanged = getHostedStore(db, store.id);
    assert.equal(unchanged.deployment_host_id, store.deployment_host_id);
    assert.equal(unchanged.runtime_instance_id, "podman:source");
    assert.equal(unchanged.state, "running");
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_events WHERE action = 'store.migrated'").get().count, 0);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("upgrading a suspended store preserves its stopped runtime", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "yardsale-cloud-upgrade-"));
  const db = openDatabase(dataDir);
  try {
    const user = createUser(db, { email: "upgrade@example.com", passwordHash: "hash" });
    const store = createHostedStore(db, {
      userId: user.id,
      name: "Upgrade test",
      slug: "upgrade-test",
      hostname: "upgrade-test.yardsale.local",
      imageVersion: "yardsale:1.0.0",
      freeDays: 14
    });
    const runtime = new LocalRuntime(dataDir);
    await runtime.createInstance({ store });
    setStoreRuntime(db, store.id, { runtimeInstanceId: "local:upgrade-test", state: "suspended" });
    const calls = [];
    const observedRuntime = {
      upgradeInstance(args) {
        calls.push(args);
        return runtime.upgradeInstance(args);
      }
    };
    assert.equal(await upgradeStores(db, observedRuntime, { imageVersion: "yardsale:2.0.0", actor: user.email }), 1);
    assert.equal(getHostedStore(db, store.id).state, "suspended");
    assert.equal(getHostedStore(db, store.id).image_version, "yardsale:2.0.0");
    assert.equal((await runtime.inspectInstance({ store })).state, "stopped");
    assert.equal(calls[0].preserveState, "suspended");
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("backups stop running tenants before copying and resume them afterward", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "yardsale-cloud-backup-"));
  const backupDir = join(dataDir, "backups");
  const db = openDatabase(dataDir);
  try {
    const user = createUser(db, { email: "backup@example.com", passwordHash: "hash" });
    const store = createHostedStore(db, {
      userId: user.id,
      name: "Backup test",
      slug: "backup-test",
      hostname: "backup-test.yardsale.local",
      imageVersion: "yardsale:1.0.0",
      freeDays: 14
    });
    setStoreRuntime(db, store.id, { runtimeInstanceId: "local:backup-test", state: "running" });
    const localRuntime = new LocalRuntime(dataDir);
    await localRuntime.createInstance({ store });
    const instanceDir = join(dataDir, "instances", store.public_id);
    mkdirSync(instanceDir, { recursive: true });
    writeFileSync(join(instanceDir, "tenant.db"), "committed");
    const calls = [];
    const runtime = {
      async stopInstance({ store: current }) { calls.push(`stop:${current.id}`); return localRuntime.stopInstance({ store: current }); },
      async startInstance({ store: current }) { calls.push(`start:${current.id}`); return localRuntime.startInstance({ store: current }); }
    };
    const backup = await createBackup(db, { dataDir, backupDir, runtime });
    assert.deepEqual(calls, [`stop:${store.id}`, `start:${store.id}`]);
    assert.equal(readFileSync(join(backup.directory, "instances", store.public_id, "tenant.db"), "utf8"), "committed");
    assert.equal(JSON.parse(readFileSync(join(backup.directory, "instances", store.public_id, "instance.json"))).state, "running");
    assert.equal((await localRuntime.inspectInstance({ store })).state, "running");
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
