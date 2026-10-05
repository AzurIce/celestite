import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  "--locked",
  "-p",
  "celestite-core",
  "--features",
  "wasm,preview",
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
// Fetch the browser runtime from the same Cargo-locked Notist checkout.
const metadata = spawnSync(
  "cargo",
  [
    "metadata",
    "--locked",
    "--manifest-path",
    "crates/celestite-core/Cargo.toml",
    "--features",
    "wasm,preview",
    "--format-version",
    "1",
    "--filter-platform",
    "wasm32-unknown-unknown",
  ],
  { cwd: root, env, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
);
if (metadata.error || metadata.status !== 0)
  throw metadata.error ?? new Error(metadata.stderr);
const packages = JSON.parse(metadata.stdout).packages as {
  name: string;
  manifest_path: string;
}[];
const html = packages.find((pkg) => pkg.name === "notist-html");
if (!html) throw new Error("Cargo metadata did not include notist-html");
const runtime = readFileSync(
  resolve(dirname(html.manifest_path), "runtime/component-protocol.js"),
  "utf8",
);
// Component URLs are published at runtime; Vite must leave these imports intact.
writeFileSync(
  resolve(out, "notist_html_runtime.js"),
  runtime.replaceAll(
    "import(component.module)",
    "import(/* @vite-ignore */ component.module)",
  ),
);
writeFileSync(
  resolve(out, "notist_html_runtime.d.ts"),
  "export function registerComponents(components: { tag: string; module: string }[]): Promise<void>;\n",
);
