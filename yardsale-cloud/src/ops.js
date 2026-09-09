import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { expirePromotions } from "./billing.js";
import { getHostedStore, listHostedStores, marketplaceEventCounts, markStoreDeleted, nowIso, releaseHostSlot, moveStoreHost } from "./db.js";
import { deindexStore, refreshPromotionScores } from "./marketplace.js";
import { applyPhraseBlocklist } from "./moderation.js";
import { reconcileLifecycle } from "./policy.js";
import { validateImageVersion } from "./runtime.js";

function groupedCounts(db, column, table = "hosted_stores") {
  return Object.fromEntries(db.prepare(`SELECT ${column} AS key, COUNT(*) AS count FROM ${table} GROUP BY ${column}`).all().map((row) => [row.key, Number(row.count)]));
}

export function collectMetrics(db) {
  const storesByState = groupedCounts(db, "state");
  const storesByMode = groupedCounts(db, "mode");
  const hosts = db.prepare("SELECT COUNT(*) AS count FROM deployment_hosts").get();
  const storage = db.prepare("SELECT COALESCE(SUM(storage_bytes), 0) AS bytes FROM hosted_stores").get();
  return {
    users: Number(db.prepare("SELECT COUNT(*) AS count FROM users WHERE status <> 'deleted'").get().count),
    stores: Number(db.prepare("SELECT COUNT(*) AS count FROM hosted_stores").get().count),
    storesByState,
    storesByMode,
    indexedListings: Number(db.prepare("SELECT COUNT(*) AS count FROM search_listings WHERE moderation_status = 'active'").get().count),
    openReports: Number(db.prepare("SELECT COUNT(*) AS count FROM moderation_reports WHERE status IN ('open', 'reviewing')").get().count),
    paidPayments: Number(db.prepare("SELECT COUNT(*) AS count FROM payments WHERE status = 'paid'").get().count),
    activePromotions: Number(db.prepare("SELECT COUNT(*) AS count FROM promotion_purchases WHERE status = 'active'").get().count),
    failedPayments: Number(db.prepare("SELECT COUNT(*) AS count FROM payments WHERE status = 'failed'").get().count),
    provisioningFailures: Number(db.prepare("SELECT COUNT(*) AS count FROM hosted_stores WHERE state = 'failed'").get().count),
    storageBytes: Number(storage.bytes),
    deploymentHosts: Number(hosts.count),
    marketplaceEvents: marketplaceEventCounts(db),
    collectedAt: nowIso()
  };
}

export function prometheusMetrics(metrics) {
  const lines = [
    "# HELP yardsale_users_total Accounts not marked deleted.",
    "# TYPE yardsale_users_total gauge",
    `yardsale_users_total ${metrics.users}`,
    "# HELP yardsale_stores_total Hosted stores.",
    "# TYPE yardsale_stores_total gauge",
    `yardsale_stores_total ${metrics.stores}`,
    "# HELP yardsale_search_listings_active_total Active indexed listings.",
    "# TYPE yardsale_search_listings_active_total gauge",
    `yardsale_search_listings_active_total ${metrics.indexedListings}`,
    "# HELP yardsale_moderation_reports_open_total Open moderation reports.",
    "# TYPE yardsale_moderation_reports_open_total gauge",
    `yardsale_moderation_reports_open_total ${metrics.openReports}`,
    "# HELP yardsale_storage_bytes_total Tracked tenant storage.",
    "# TYPE yardsale_storage_bytes_total gauge",
    `yardsale_storage_bytes_total ${metrics.storageBytes}`
  ];
  for (const [eventType, count] of Object.entries(metrics.marketplaceEvents || {})) lines.push(`yardsale_marketplace_events_total{event_type="${eventType}"} ${count}`);
  lines.push(`yardsale_payments_paid_total ${metrics.paidPayments || 0}`);
  lines.push(`yardsale_payments_failed_total ${metrics.failedPayments || 0}`);
  lines.push(`yardsale_provisioning_failures_total ${metrics.provisioningFailures || 0}`);
  for (const [state, count] of Object.entries(metrics.storesByState)) lines.push(`yardsale_stores_state{state="${state}"} ${count}`);
  for (const [mode, count] of Object.entries(metrics.storesByMode)) lines.push(`yardsale_stores_mode{mode="${mode}"} ${count}`);
  return `${lines.join("\n")}\n`;
}

export async function createBackup(db, { dataDir, backupDir, retention = 14, runtime = null }) {
  const instances = join(dataDir, "instances");
  const activeStores = runtime
    ? listHostedStores(db).filter((store) => ["provisioning", "running"].includes(store.state))
    : [];
  if (statSafe(instances) && !runtime) throw new Error("A runtime adapter is required to back up tenant instances safely.");

  const stoppedStores = [];
  let result;
  let backupError = null;
  try {
    for (const store of activeStores) {
      stoppedStores.push(store);
      await runtime.stopInstance({ store });
    }

    db.exec("PRAGMA wal_checkpoint(FULL)");
    mkdirSync(backupDir, { recursive: true });
    const stamp = `${new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 17)}-${randomUUID().slice(0, 8)}`;
    const destination = join(backupDir, stamp);
    mkdirSync(destination, { recursive: true });
    copyFileSync(join(dataDir, "yardsale-cloud.db"), join(destination, "yardsale-cloud.db"));
    if (statSafe(instances)) cpSync(instances, join(destination, "instances"), { recursive: true });
    for (const store of stoppedStores) restoreInstanceMetadata(join(destination, "instances"), store);
    const manifest = { created_at: nowIso(), metrics: collectMetrics(db) };
    writeFileSync(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
    const keep = Math.max(1, Math.min(365, Number(retention) || 14));
    const backups = readdirSync(backupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => b.name.localeCompare(a.name));
    for (const entry of backups.slice(keep)) {
      // Backups are immutable directories; retention cleanup is deliberately limited
      // to immediate children of the configured backup directory.
      try { rmSync(join(backupDir, entry.name), { recursive: true, force: true }); } catch { /* Retention cleanup is best effort. */ }
    }
    result = { directory: destination, manifest };
  } catch (error) {
    backupError = error;
  }

  const restoreErrors = [];
  for (const store of stoppedStores.reverse()) {
    try {
      await runtime.startInstance({ store });
    } catch (error) {
      restoreErrors.push(error);
    }
  }
  if (backupError) throw backupError;
  if (restoreErrors.length) throw new Error(`Backup completed, but ${restoreErrors.length} tenant runtime(s) could not be resumed.`);
  return result;
}

function restoreInstanceMetadata(instancesDir, store) {
  const metadataPath = join(instancesDir, store.public_id, "instance.json");
  if (!statSafe(metadataPath)) return;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    writeFileSync(metadataPath, JSON.stringify({ ...metadata, state: store.state }, null, 2));
  } catch {
    // The tenant backup remains usable even when a runtime-specific metadata file is opaque.
  }
}

function statSafe(path) {
  try { return statSync(path); } catch { return null; }
}

export function listBackups(backupDir) {
  if (!statSafe(backupDir)) return [];
  return readdirSync(backupDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = join(backupDir, entry.name, "manifest.json");
      let manifest = {};
      try { manifest = JSON.parse(requireFile(manifestPath)); } catch { /* incomplete backup */ }
      return { name: entry.name, path: join(backupDir, entry.name), created_at: manifest.created_at || entry.name };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function requireFile(path) {
  return statSafe(path) ? String(readFileSync(path)) : "{}";
}

export function restoreBackup({ backupDirectory, dataDir }) {
  const source = join(backupDirectory, "yardsale-cloud.db");
  if (!statSafe(source)) throw new Error("Backup database not found.");
  mkdirSync(dataDir, { recursive: true });
  if (statSafe(join(dataDir, "yardsale-cloud.db"))) throw new Error("Refusing to overwrite an existing database; stop the service and move it first.");
  copyFileSync(source, join(dataDir, "yardsale-cloud.db"));
  if (statSafe(join(backupDirectory, "instances"))) cpSync(join(backupDirectory, "instances"), join(dataDir, "instances"), { recursive: true });
  return dataDir;
}

export async function runJobs({ db, runtime, backupDir = null, dataDir = null }) {
  const lifecycleChanges = reconcileLifecycle(db);
  const offline = db.prepare("SELECT * FROM hosted_stores WHERE state IN ('expired', 'deleting')").all();
  let stopped = 0;
  for (const store of offline) {
    try {
      await runtime.stopInstance({ store });
      stopped += 1;
    } catch {
      // A missing runtime is safe to retry; deletion below remains the source of truth.
    }
    deindexStore(db, store.id, "system");
  }
  const deleting = db.prepare("SELECT * FROM hosted_stores WHERE state = 'deleting'").all();
  let deleted = 0;
  for (const store of deleting) {
    try {
      await runtime.deleteInstance({ store });
      markStoreDeleted(db, store.id);
      releaseHostSlot(db, store);
      deleted += 1;
    } catch {
      // Leave the store in deleting so the next job retries it.
    }
  }
  const expiredPromotions = expirePromotions(db);
  const scored = refreshPromotionScores(db);
  const phraseBlocked = applyPhraseBlocklist(db);
  const prunedSessions = pruneExpiredSessions(db);
  return { lifecycleChanges, stopped, deleted, expiredPromotions, scored, phraseBlocked, prunedSessions, backup: backupDir && dataDir ? await createBackup(db, { dataDir, backupDir, runtime }) : null };
}

export async function upgradeStores(db, runtime, { imageVersion, actor }) {
  imageVersion = validateImageVersion(imageVersion);
  const stores = listHostedStores(db).filter((store) => ["running", "suspended"].includes(store.state));
  let upgraded = 0;
  const completed = [];
  for (const store of stores) {
    try {
      await runtime.upgradeInstance({ store, imageVersion, preserveState: store.state });
      db.prepare("UPDATE hosted_stores SET image_version = ?, updated_at = ? WHERE id = ?").run(imageVersion, nowIso(), store.id);
      db.prepare("INSERT INTO audit_events (actor, store_id, action, metadata, created_at) VALUES (?, ?, 'store.upgraded', ?, ?)")
        .run(actor, store.id, JSON.stringify({ image_version: imageVersion }), nowIso());
      completed.push({ store, previous: store.image_version, state: store.state });
      upgraded += 1;
    } catch (error) {
      for (const item of completed.reverse()) {
        try {
          await runtime.upgradeInstance({ store: item.store, imageVersion: item.previous, preserveState: item.state });
          db.prepare("UPDATE hosted_stores SET image_version = ?, updated_at = ? WHERE id = ?").run(item.previous, nowIso(), item.store.id);
        } catch {
          // The operator can retry the release after inspecting the affected instance.
        }
      }
      throw new Error(`Upgrade stopped at ${store.slug}: ${error.message}`);
    }
  }
  return upgraded;
}

export async function migrateStore(db, runtime, { storeId, destinationHostId, actor }) {
  const store = getHostedStore(db, storeId);
  const destination = db.prepare("SELECT * FROM deployment_hosts WHERE id = ? AND status = 'ready'").get(destinationHostId);
  if (!store || !destination) throw new Error("Store or destination host not found.");
  if (store.deployment_host_id === destination.id) return store;
  if (runtime.supportsMigration === false) throw new Error("Store migration is unavailable for this runtime until data transfer is implemented.");
  const previousHostId = store.deployment_host_id;
  const previousRuntimeInstanceId = store.runtime_instance_id;
  let moved = null;
  await runtime.stopInstance({ store });
  try {
    const migration = await runtime.migrateInstance({ store, destination: destination.hostname });
    moved = moveStoreHost(db, store.id, destination.id);
    if (migration?.runtimeInstanceId) {
      db.prepare("UPDATE hosted_stores SET runtime_instance_id = ?, updated_at = ? WHERE id = ?")
        .run(migration.runtimeInstanceId, nowIso(), store.id);
      moved = getHostedStore(db, store.id);
    }
    await runtime.startInstance({ store: moved });
    db.prepare("INSERT INTO audit_events (actor, store_id, action, metadata, created_at) VALUES (?, ?, 'store.migrated', ?, ?)")
      .run(actor, store.id, JSON.stringify({ from_host_id: previousHostId, to_host_id: destination.id }), nowIso());
    return moved;
  } catch (error) {
    if (moved && previousHostId && moved.deployment_host_id !== previousHostId) {
      try {
        moveStoreHost(db, store.id, previousHostId);
        db.prepare("UPDATE hosted_stores SET runtime_instance_id = ?, updated_at = ? WHERE id = ?")
          .run(previousRuntimeInstanceId, nowIso(), store.id);
      } catch { /* Preserve the original migration error. */ }
    }
    try { await runtime.startInstance({ store }); } catch { /* Keep the original migration error. */ }
    throw error;
  }
}

export function pruneExpiredSessions(db) {
  return Number(db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(nowIso()).changes);
}
