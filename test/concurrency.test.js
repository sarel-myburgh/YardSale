import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createListing, getActiveReservationForListing, getListingById, openDatabase } from "../src/db.js";

function runReservationWorker(dataDir, listingId, workerId) {
  const dbModule = new URL("../src/db.js", import.meta.url).href;
  const code = `
    import { openDatabase, reserveListing } from ${JSON.stringify(dbModule)};
    const db = openDatabase(process.argv[1]);
    try {
      const result = reserveListing(db, Number(process.argv[2]), {
        buyerName: "Concurrent buyer ${workerId}",
        buyerContact: "test@example.com",
        holdMinutes: 60
      });
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      process.stderr.write(error.stack || String(error));
      process.exitCode = 1;
    } finally {
      db.close();
    }
  `;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-sqlite", "--input-type=module", "-e", code, dataDir, String(listingId)], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`Reservation worker failed (${code ?? signal}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Reservation worker returned invalid JSON: ${stdout}\n${stderr}\n${error.message}`));
      }
    });
  });
}

test("concurrent hold requests can only lock a single-quantity listing once", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "yardsale-race-"));
  const setupDb = openDatabase(dataDir);
  const listing = createListing(setupDb, {
    title: "Race test item",
    slug: "race-test-item",
    description: "",
    priceMinor: 1000,
    currency: "USD",
    category: "",
    condition: "",
    pickupNotes: "",
    tags: "",
    published: true,
    quantity: 1
  });
  setupDb.close();

  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => runReservationWorker(dataDir, listing.id, index))
    );
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => !result.ok).length, 7);

    const verifyDb = openDatabase(dataDir);
    try {
      assert.equal(getListingById(verifyDb, listing.id).status, "held");
      assert.equal(verifyDb.prepare("SELECT COUNT(*) AS count FROM reservations WHERE listing_id = ? AND status = 'held'").get(listing.id).count, 1);
      assert.equal(getActiveReservationForListing(verifyDb, listing.id).status, "held");
    } finally {
      verifyDb.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
