import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(web, process.argv[2] ?? "../../tree-sitter-notist");
const output = resolve(web, "src/lib/syntax/grammars");
const cli = resolve(web, "node_modules/.bin/tree-sitter");
const grammars = {
  notist: ".",
  notist_code: "notist-code",
  notist_markdown: "notist-markdown",
  notist_markdown_inline: "notist-markdown-inline",
};
// Hash the complete grammar sources, including shared scanners and headers.
const hash = createHash("sha256");
function fingerprint(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if ([".git", "node_modules", "target"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) fingerprint(path);
    else if (/\.(c|h|js|json|scm)$/.test(entry.name)) {
      hash.update(relative(source, path));
      hash.update("\0");
      hash.update(readFileSync(path));
    }
  }
}
fingerprint(source);
mkdirSync(output, { recursive: true });
for (const [name, directory] of Object.entries(grammars)) {
  const grammar = resolve(source, directory);
  const result = spawnSync(
    cli,
    ["build", "--wasm", "--output", resolve(output, `${name}.wasm`), grammar],
    { cwd: source, stdio: "inherit" },
  );
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`Building ${name} failed`);
  chmodSync(resolve(output, `${name}.wasm`), 0o644);
  for (const query of ["highlights", "injections", "folds"]) {
    const path = resolve(grammar, "queries", `${query}.scm`);
    // Native Notist grammars do not use language injections.
    const exists = readdirSync(dirname(path)).includes(`${query}.scm`);
    writeFileSync(
      resolve(output, `${name}.${query}.scm`),
      exists ? readFileSync(path) : "",
    );
  }
}
writeFileSync(
  resolve(web, "public/tree-sitter-notist-LICENSE.txt"),
  ["LICENSE-MIT", "vendor/tree-sitter-markdown/LICENSE"]
    .map((path) => readFileSync(resolve(source, path), "utf8"))
    .join("\n"),
);
writeFileSync(
  resolve(output, "snapshot.json"),
  JSON.stringify(
    {
      source: "tree-sitter-notist",
      sourceSha256: hash.digest("hex"),
      compiler: "tree-sitter-cli 0.26.11",
      grammars: Object.keys(grammars),
    },
    null,
    2,
  ) + "\n",
);
