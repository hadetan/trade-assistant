import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rustCoreDir = path.resolve(scriptDir, "..", "..", "rust-core");
const sidecarBinDir = path.resolve(scriptDir, "..", "resources", "sidecar-bin");

// Wipe first so a stale binary from a different platform or an earlier
// build can never silently survive into the packaged app.
fs.rmSync(sidecarBinDir, { recursive: true, force: true });
fs.mkdirSync(sidecarBinDir, { recursive: true });

const build = spawnSync("cargo", ["build", "--release", "-p", "sidecar"], {
  cwd: rustCoreDir,
  stdio: "inherit",
});
if (build.error) {
  console.error(`failed to run cargo (is it on PATH?): ${build.error.message}`);
  process.exit(1);
}
if (build.status !== 0) {
  console.error(`cargo build --release -p sidecar failed (exit ${build.status ?? "null"})`);
  process.exit(build.status ?? 1);
}

const binaryName = process.platform === "win32" ? "sidecar.exe" : "sidecar";
const compiled = path.join(rustCoreDir, "target", "release", binaryName);
const staged = path.join(sidecarBinDir, binaryName);
fs.copyFileSync(compiled, staged);
console.log(`staged ${compiled} -> ${staged}`);
