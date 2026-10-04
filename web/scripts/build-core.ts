import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(web, "..");
const target = resolve(
  root,
  process.env.CARGO_TARGET_DIR ?? "web/.cache/core-target",
);
const env = { ...process.env, CARGO_TARGET_DIR: target };
const version = "0.2.129";
function run(command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`${command} exited with ${result.status}`);
}
function matches(command: string) {
  return (
    spawnSync(command, ["--version"], { encoding: "utf8" }).stdout?.trim() ===
    `wasm-bindgen ${version}`
  );
}
let bindgen = process.env.WASM_BINDGEN ?? "wasm-bindgen";
if (!matches(bindgen)) {
  if (process.env.WASM_BINDGEN)
    throw new Error(`WASM_BINDGEN must point to wasm-bindgen ${version}`);
  const tools = resolve(web, ".cache/wasm-tools");
  bindgen = resolve(tools, "bin/wasm-bindgen");
  if (!matches(bindgen)) {
    console.info(`Installing project-local wasm-bindgen ${version}…`);
    run("cargo", [
      "install",
      "wasm-bindgen-cli",
      "--version",
      version,
      "--locked",
      "--root",
      tools,
    ]);
  }
}
const out = resolve(web, "src/lib/editor/generated");
mkdirSync(out, { recursive: true });
run("cargo", [
  "build",
  "-p",
  "celestite-core",
  "--features",
  "wasm",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
]);
run(bindgen, [
  resolve(target, "wasm32-unknown-unknown/release/celestite_core.wasm"),
  "--target",
  "web",
  "--out-dir",
  out,
  "--out-name",
  "celestite_core",
]);
