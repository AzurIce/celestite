import runtime from "web-tree-sitter/web-tree-sitter.wasm?url";
import { grammarSources } from "./assets";
import { SyntaxEngine } from "./engine";
import type { HighlightRequest, HighlightResponse } from "./contract";

const engine = SyntaxEngine.create(grammarSources, runtime);
let latest: HighlightRequest | undefined;
let running = false;
self.onmessage = (event: MessageEvent<HighlightRequest>) => {
  latest = event.data;
  if (!running) void run();
};
async function run() {
  running = true;
  let version = latest!.version;
  try {
    const syntax = await engine;
    const request = latest!;
    version = request.version;
    latest = undefined;
    const result = syntax.highlight(request.grammar, request.text);
    self.postMessage({
      version: request.version,
      ...result,
    } satisfies HighlightResponse);
  } catch (error) {
    self.postMessage({
      version: latest?.version ?? version,
      error: String(error),
    } satisfies HighlightResponse);
    latest = undefined;
  } finally {
    running = false;
  }
}
