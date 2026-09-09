import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

// Runtime contract: createInstance, startInstance, stopInstance, suspendInstance,
// resumeInstance, deleteInstance, inspectInstance, and upgradeInstance.
// This local adapter makes the control-plane slice runnable before Podman is wired in.
export function validateImageVersion(value) {
  const imageVersion = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,159}$/.test(imageVersion)) throw new Error("Image version contains unsupported characters.");
  return imageVersion;
}

export class LocalRuntime {
  constructor(dataDir) {
    this.supportsMigration = true;
    this.instancesDir = join(dataDir, "instances");
    mkdirSync(this.instancesDir, { recursive: true });
  }

  instancePath(store) {
    return join(this.instancesDir, store.public_id);
  }

  async createInstance({ store }) {
    const imageVersion = validateImageVersion(store.image_version);
    const path = this.instancePath(store);
    mkdirSync(path, { recursive: true });
    ensureInstanceSecret(path);
    const metadata = {
      public_id: store.public_id,
      hostname: store.hostname,
      image_version: imageVersion,
      runtime: "local",
      state: "running"
    };
    writeFileSync(join(path, "instance.json"), JSON.stringify(metadata, null, 2));
    return { runtimeInstanceId: `local:${store.public_id}`, state: "running" };
  }

  async startInstance({ store }) {
    return this.setState(store, "running");
  }

  async stopInstance({ store }) {
    return this.setState(store, "stopped");
  }

  async suspendInstance({ store }) {
    return this.stopInstance({ store });
  }

  async resumeInstance({ store }) {
    return this.startInstance({ store });
  }

  async deleteInstance({ store }) {
    rmSync(this.instancePath(store), { recursive: true, force: true });
    return { state: "deleted" };
  }

  async inspectInstance({ store }) {
    const path = join(this.instancePath(store), "instance.json");
    if (!existsSync(path)) return { exists: false };
    try { return { exists: true, ...JSON.parse(readFileSync(path, "utf8")) }; } catch { return { exists: false }; }
  }

  async waitUntilReady({ store }) { return Boolean((await this.inspectInstance({ store })).exists); }

  async upgradeInstance({ store, imageVersion, preserveState = store.state }) {
    const nextImageVersion = validateImageVersion(imageVersion);
    const state = preserveState === "suspended" ? "stopped" : "running";
    return this.setState({ ...store, image_version: nextImageVersion }, state);
  }

  async migrateInstance({ store, destination }) {
    return { runtimeInstanceId: `local:${destination}:${store.public_id}`, state: "running" };
  }

  setState(store, state) {
    const path = join(this.instancePath(store), "instance.json");
    if (existsSync(path)) {
      const current = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...current, image_version: store.image_version ?? current.image_version, state }, null, 2));
    }
    return { state };
  }
}

function ensureInstanceSecret(path) {
  const secretPath = join(path, "instance.env");
  if (!existsSync(secretPath)) {
    writeFileSync(secretPath, `YARDSALE_CLOUD_INSTANCE_SECRET=${randomBytes(32).toString("hex")}\n`, { mode: 0o600 });
    chmodSync(secretPath, 0o600);
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `${command} exited with ${code}`)));
  });
}

export class PodmanRuntime {
  constructor({ dataDir, podmanBin = "podman", systemctlBin = "systemctl", execute = false }) {
    this.supportsMigration = false;
    this.dataDir = dataDir;
    this.podmanBin = podmanBin;
    this.systemctlBin = systemctlBin;
    this.execute = execute;
    this.instancesDir = join(dataDir, "instances");
    this.quadletDir = join(dataDir, "quadlet");
    mkdirSync(this.instancesDir, { recursive: true });
    mkdirSync(this.quadletDir, { recursive: true });
  }

  unitName(store) {
    return `yardsale-${store.public_id}`;
  }

  instancePath(store) {
    return join(this.instancesDir, store.public_id);
  }

  unitPath(store) {
    return join(this.quadletDir, `${this.unitName(store)}.container`);
  }

  writeUnit(store, imageVersion = store.image_version) {
    imageVersion = validateImageVersion(imageVersion);
    const instancePath = this.instancePath(store);
    mkdirSync(instancePath, { recursive: true });
    ensureInstanceSecret(instancePath);
    const port = Number(store.runtime_port) || 0;
    const publish = port ? `PublishPort=127.0.0.1:${port}:3000\n` : "";
    writeFileSync(this.unitPath(store), `[Unit]\nDescription=YardSale store ${store.public_id}\nAfter=network-online.target\n\n[Container]\nImage=${imageVersion}\nContainerName=${this.unitName(store)}\nVolume=${instancePath}:/data:Z\nEnvironmentFile=${join(instancePath, "instance.env")}\nReadOnly=true\nTmpfs=/tmp\nNoNewPrivileges=true\nDropCapability=ALL\n${publish}Label=app=yardsale-cloud\nLabel=yardsale-store-id=${store.public_id}\n\n[Service]\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`);
  }

  async systemctl(action, unit) {
    if (this.execute) await runCommand(this.systemctlBin, ["--user", action, ...(unit ? [unit] : [])]);
  }

  async createInstance({ store }) {
    this.writeUnit(store);
    await this.systemctl("daemon-reload", "");
    await this.systemctl("start", `${this.unitName(store)}.service`);
    return { runtimeInstanceId: `podman:${this.unitName(store)}`, state: this.execute ? "running" : "provisioning" };
  }

  async startInstance({ store }) {
    await this.systemctl("start", `${this.unitName(store)}.service`);
    return { state: "running" };
  }

  async stopInstance({ store }) {
    await this.systemctl("stop", `${this.unitName(store)}.service`);
    return { state: "stopped" };
  }

  async suspendInstance({ store }) { return this.stopInstance({ store }); }
  async resumeInstance({ store }) { return this.startInstance({ store }); }

  async deleteInstance({ store }) {
    await this.systemctl("stop", `${this.unitName(store)}.service`);
    rmSync(this.unitPath(store), { force: true });
    rmSync(this.instancePath(store), { recursive: true, force: true });
    return { state: "deleted" };
  }

  async inspectInstance({ store }) {
    if (!this.execute) return { exists: existsSync(this.unitPath(store)), runtime: "podman", unit: this.unitName(store) };
    const output = await runCommand(this.podmanBin, ["inspect", this.unitName(store)]);
    return JSON.parse(output)[0] || { exists: false };
  }

  async waitUntilReady({ store, fetchImpl = fetch, attempts = 15, delayMs = 500 }) {
    if (!this.execute) return false;
    const endpoint = `http://127.0.0.1:${Number(store.runtime_port)}/readyz`;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetchImpl(endpoint, { signal: AbortSignal.timeout(2000) });
        if (response.ok) return true;
      } catch { /* Retry while the container starts. */ }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return false;
  }

  async upgradeInstance({ store, imageVersion, preserveState = store.state }) {
    this.writeUnit(store, imageVersion);
    await this.systemctl("daemon-reload", "");
    if (preserveState === "suspended") {
      await this.systemctl("stop", `${this.unitName(store)}.service`);
      return { state: "stopped" };
    }
    await this.systemctl("restart", `${this.unitName(store)}.service`);
    return { state: "running" };
  }

  async migrateInstance({ store, destination }) {
    throw new Error("Podman store migration is unavailable until runtime data transfer is implemented.");
  }
}

export function createRuntime({ kind = "local", dataDir, execute = false }) {
  if (kind === "podman") return new PodmanRuntime({ dataDir, execute });
  if (kind === "local") return new LocalRuntime(dataDir);
  throw new Error(`Runtime '${kind}' is not available.`);
}
