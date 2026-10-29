import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView, keymap, type ViewUpdate } from "@codemirror/view";
import { forEachDiagnostic } from "@codemirror/lint";
import {
  createNotistLanguageClient,
  languagePath,
  notistLanguageId,
} from "../../src/lib/language/client";
import type {
  DocumentsSnapshot,
  EditorDocument,
  EditorDocuments,
} from "../../src/lib/editor/contract";
import { vaultPath } from "../../src/lib/vault/path";
import {
  compositionState,
  setComposing,
} from "../../src/lib/editor/composition";

function document(path: string, content: string, id = path): EditorDocument {
  return {
    id,
    path: vaultPath(path),
    content,
    dirty: false,
    saving: false,
    locked: false,
    reloadVersion: 0,
    error: null,
    conflict: false,
    readOnlyReason: null,
    canPreview: true,
    lineEnding: "\n",
    bom: false,
  };
}
function fixture(
  initial: EditorDocument[],
  failFirstInitialize = false,
  holdInitialize = false,
) {
  const initializations: (() => void)[] = [];
  let documents = initial;
  const listeners = new Set<(snapshot: DocumentsSnapshot) => void>();
  const receivers = new Set<(message: string) => void>();
  const sent: any[] = [];
  let initialized = false;
  const snapshot = (): DocumentsSnapshot => ({
    documents,
    activeId: documents[0]?.id ?? null,
    loadingPath: null,
    openError: null,
    activation: 0,
    conflictPrompt: null,
    conflictResolving: false,
    conflictError: null,
  });
  const receive = (message: unknown) => {
    for (const handler of receivers) handler(JSON.stringify(message));
  };
  const source = {
    snapshot,
    subscribe: (listener: (snapshot: DocumentsSnapshot) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    language: {
      subscribe: (handler: (message: string) => void) => {
        receivers.add(handler);
        return () => receivers.delete(handler);
      },
      send: (message: string) => {
        const parsed = JSON.parse(message);
        sent.push(parsed);
        if (parsed.method === "initialize") {
          const fail = failFirstInitialize && !initialized;
          initialized = true;
          const respond = () =>
            receive({
              jsonrpc: "2.0",
              id: parsed.id,
              ...(fail
                ? { error: { code: -32603, message: "transient init failure" } }
                : {
                    result: {
                      capabilities: {
                        textDocumentSync: 1,
                        definitionProvider: true,
                        hoverProvider: true,
                        documentSymbolProvider: true,
                      },
                    },
                  }),
            });
          if (holdInitialize) initializations.push(respond);
          else queueMicrotask(respond);
        } else if (parsed.id != null) {
          queueMicrotask(() =>
            receive({ jsonrpc: "2.0", id: parsed.id, result: null }),
          );
        }
      },
    },
  } as unknown as EditorDocuments;
  const language = createNotistLanguageClient(source, async () => null)!;
  return {
    ...language,
    sent,
    receive,
    releaseInitialize() {
      for (const respond of initializations.splice(0)) respond();
    },
    async flush() {
      await nextTurn();
      await nextTurn();
    },
    update(next: EditorDocument[]) {
      documents = next;
      for (const listener of listeners) listener(snapshot());
    },
  };
}
function view(
  source: string,
  client?: ReturnType<typeof fixture>["client"],
  uri = "file:///vault/a.not",
) {
  let state = EditorState.create({
    doc: source,
    extensions: [compositionState, client ? client.plugin(uri, "notist") : []],
  });
  const plugin = {
    client,
    uri,
    toPosition(position: number) {
      const line = state.doc.lineAt(position);
      return { line: line.number - 1, character: position - line.from };
    },
    syncedDoc: state.doc,
    unsyncedChanges: ChangeSet.empty(state.doc.length),
    fromPosition(
      position: { line: number; character: number },
      doc = state.doc,
    ) {
      const line = doc.line(Math.min(position.line + 1, doc.lines));
      return Math.min(line.to, line.from + position.character);
    },
  };
  return {
    get state() {
      return state;
    },
    plugin: () => plugin,
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      const startState = state;
      const transaction = state.update(spec);
      state = transaction.state;
      plugin.unsyncedChanges = plugin.unsyncedChanges.compose(
        transaction.changes,
      );
      for (const listener of state.facet(EditorView.updateListener))
        listener({
          view: this,
          state,
          startState,
          transactions: [transaction],
        } as unknown as ViewUpdate);
    },
  } as unknown as EditorView;
}
function diagnostics(target: EditorView) {
  const result: string[] = [];
  forEachDiagnostic(target.state, (diagnostic) =>
    result.push(diagnostic.message),
  );
  return result;
}

test("the configured client registers F12 without unsupported command keys", async () => {
  const language = fixture([]);
  try {
    await language.flush();
    const state = EditorState.create({
      extensions: language.client.plugin("file:///vault/a.not", "notist"),
    });
    const keys = state
      .facet(keymap)
      .flat()
      .map((binding) => binding.key);
    assert.ok(keys.includes("F12"));
    assert.ok(!keys.includes("F2"));
    assert.ok(!keys.includes("Shift-Alt-f"));
  } finally {
    language.dispose();
  }
});

test("all open documents retain unsaved sources while their views switch", async () => {
  const main = document("a.not", '#import "./lib.notc" as demo;\n#demo.card()');
  const library = document("lib.notc", "fn card() -> BlockContent;");
  const language = fixture([main, library, document("plain.txt", "text")]);
  try {
    await language.flush();
    assert.deepEqual(
      language.sent
        .filter((item) => item.method === "textDocument/didOpen")
        .map((item) => item.params.textDocument.uri),
      ["file:///vault/a.not", "file:///vault/lib.notc"],
    );
    const mounted = view(library.content);
    language.workspace.openFile("file:///vault/lib.notc", "notist", mounted);
    language.workspace.closeFile("file:///vault/lib.notc", mounted);
    language.update([
      main,
      { ...library, content: "fn changed() -> BlockContent;", pending: 1 },
    ]);
    await language.flush();
    assert.equal(
      language.sent.filter((item) => item.method === "textDocument/didClose")
        .length,
      0,
    );
    const changed = language.sent.find(
      (item) => item.method === "textDocument/didChange",
    );
    assert.equal(
      changed.params.contentChanges[0].text,
      "fn changed() -> BlockContent;",
    );
    assert.equal(
      language.workspace.getFile("file:///vault/lib.notc")!.doc.toString(),
      "fn changed() -> BlockContent;",
    );
    const remounted = view("fn changed() -> BlockContent;");
    language.workspace.openFile("file:///vault/lib.notc", "notist", remounted);
    await language.flush();
    assert.equal(
      language.sent.filter((item) => item.method === "textDocument/didOpen")
        .length,
      2,
    );
  } finally {
    language.dispose();
  }
});

test("rename, deletion, reconnect replacement and same-path reopening follow snapshots", async () => {
  const first = document("a.not", "old", "id");
  const language = fixture([first]);
  try {
    await language.flush();
    const oldVersion = language.workspace.getFile(
      "file:///vault/a.not",
    )!.version;
    const renamed = { ...first, path: vaultPath("renamed.not") };
    language.update([renamed]);
    await language.flush();
    assert.equal(language.workspace.getFile("file:///vault/a.not"), null);
    assert.ok(
      language.sent.some(
        (item) =>
          item.method === "textDocument/didClose" &&
          item.params.textDocument.uri === "file:///vault/a.not",
      ),
    );
    language.update([
      { ...renamed, content: "reconnected", id: "new identity" },
    ]);
    await language.flush();
    assert.equal(
      language.workspace.getFile("file:///vault/renamed.not")!.doc.toString(),
      "reconnected",
    );
    language.update([{ ...renamed, deleted: true }]);
    await language.flush();
    assert.equal(language.workspace.files.length, 0);
    language.update([document("a.not", "fresh", "fresh identity")]);
    await language.flush();
    assert.ok(
      language.workspace.getFile("file:///vault/a.not")!.version > oldVersion,
    );
  } finally {
    language.dispose();
  }
});

test("diagnostics are version checked and retained across view detachment", async () => {
  let doc = document("a.notc", "fn broken(");
  const language = fixture([doc]);
  const uri = "file:///vault/a.notc";
  const diagnostic = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
    message: "old diagnostic",
    severity: 1,
  };
  try {
    await language.flush();
    const first = view(doc.content, language.client, uri);
    language.workspace.openFile(uri, "notist", first);
    await language.flush();
    const oldVersion = language.workspace.getFile(uri)!.version;
    language.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version: oldVersion, diagnostics: [diagnostic] },
    });
    assert.deepEqual(diagnostics(first), ["old diagnostic"]);
    language.workspace.closeFile(uri, first);
    doc = { ...doc, content: "fn fixed() -> BlockContent;" };
    language.update([doc]);
    await language.flush();
    const currentVersion = language.workspace.getFile(uri)!.version;
    language.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version: oldVersion, diagnostics: [diagnostic] },
    });
    assert.equal(language.workspace.getFile(uri)!.diagnostics, undefined);
    language.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version: currentVersion,
        diagnostics: [{ ...diagnostic, message: "current diagnostic" }],
      },
    });
    const current = view(doc.content, language.client, uri);
    language.workspace.openFile(uri, "notist", current);
    await language.flush();
    assert.deepEqual(diagnostics(current), ["current diagnostic"]);
    language.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version: oldVersion, diagnostics: [] },
    });
    assert.deepEqual(diagnostics(current), ["current diagnostic"]);
  } finally {
    language.dispose();
  }
});

test("failed initialization retries on a later document change without losing snapshots", async () => {
  const doc = document("a.not", "initial");
  const language = fixture([doc], true);
  try {
    await language.flush();
    assert.equal(
      language.sent.filter((item) => item.method === "initialize").length,
      1,
    );
    language.update([{ ...doc, saving: true }]);
    await language.flush();
    assert.equal(
      language.sent.filter((item) => item.method === "initialize").length,
      1,
    );
    assert.equal(
      language.sent.filter((item) => item.method === "textDocument/didOpen")
        .length,
      0,
    );
    language.update([{ ...doc, content: "edited after failure" }]);
    await language.flush();
    assert.equal(
      language.sent.filter((item) => item.method === "initialize").length,
      2,
    );
    const opened = language.sent.find(
      (item) => item.method === "textDocument/didOpen",
    );
    assert.equal(opened.params.textDocument.text, "edited after failure");
  } finally {
    language.dispose();
  }
});

test("diagnostics stay cached during composition and the end listener displays the latest result", async () => {
  const doc = document("a.not", "*source*");
  const language = fixture([doc]);
  const uri = "file:///vault/a.not";
  try {
    await language.flush();
    const mounted = view(doc.content, language.client, uri);
    language.workspace.openFile(uri, "notist", mounted);
    await language.flush();
    mounted.dispatch({ effects: setComposing.of(true) });
    const frozen = mounted.state;
    for (const message of ["first result", "latest result"])
      language.receive({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri,
          version: language.workspace.getFile(uri)!.version,
          diagnostics: [
            {
              range: {
                start: { line: 0, character: 0 },
                end: { line: 0, character: 1 },
              },
              severity: 1,
              message,
            },
          ],
        },
      });
    assert.equal(
      mounted.state,
      frozen,
      "no diagnostic dispatch may clear DOM input",
    );
    assert.deepEqual(diagnostics(mounted), []);
    assert.equal(
      language.workspace.getFile(uri)!.diagnostics!.diagnostics[0].message,
      "latest result",
    );
    mounted.dispatch({ effects: setComposing.of(false) });
    assert.deepEqual(diagnostics(mounted), []);
    await language.flush();
    assert.deepEqual(diagnostics(mounted), ["latest result"]);
  } finally {
    language.dispose();
  }
});

test("composition end cannot revive a cached diagnostic after its source version changes", async () => {
  let doc = document("a.not", "old source");
  const language = fixture([doc]);
  const uri = "file:///vault/a.not";
  try {
    await language.flush();
    const mounted = view(doc.content, language.client, uri);
    language.workspace.openFile(uri, "notist", mounted);
    await language.flush();
    const oldVersion = language.workspace.getFile(uri)!.version;
    mounted.dispatch({ effects: setComposing.of(true) });
    language.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version: oldVersion,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            message: "stale composed source",
          },
        ],
      },
    });
    doc = { ...doc, content: "changed source" };
    mounted.dispatch({
      changes: { from: 0, to: mounted.state.doc.length, insert: doc.content },
    });
    language.update([doc]);
    await language.flush();
    assert.ok(language.workspace.getFile(uri)!.version > oldVersion);
    assert.equal(language.workspace.getFile(uri)!.diagnostics, undefined);
    mounted.dispatch({ effects: setComposing.of(false) });
    language.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version: oldVersion, diagnostics: [] },
    });
    await language.flush();
    assert.deepEqual(diagnostics(mounted), []);
  } finally {
    language.dispose();
  }
});

test("deferred diagnostic resume ignores a detached view and a disposed client", async () => {
  const doc = document("a.not", "source");
  const language = fixture([doc]);
  const uri = "file:///vault/a.not";
  try {
    await language.flush();
    const mounted = view(doc.content, language.client, uri);
    language.workspace.openFile(uri, "notist", mounted);
    await language.flush();
    mounted.dispatch({ effects: setComposing.of(true) });
    language.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version: language.workspace.getFile(uri)!.version,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 1 },
            },
            message: "attached result",
          },
        ],
      },
    });
    mounted.dispatch({ effects: setComposing.of(false) });
    const detached = mounted.state;
    language.workspace.closeFile(uri, mounted);
    const next = view(doc.content, language.client, uri);
    language.workspace.openFile(uri, "notist", next);
    await language.flush();
    assert.equal(mounted.state, detached);
    assert.deepEqual(diagnostics(next), ["attached result"]);
    next.dispatch({ effects: setComposing.of(true) });
    next.dispatch({ effects: setComposing.of(false) });
    const closed = next.state;
    language.dispose();
    await language.flush();
    assert.equal(next.state, closed);
  } finally {
    language.dispose();
  }
});

test("F12 waits for initialization before capturing its cursor and source mapping", async () => {
  const doc = document("a.not", "old");
  const language = fixture([doc], false, true);
  try {
    const mounted = view(doc.content, language.client);
    language.workspace.openFile("file:///vault/a.not", "notist", mounted);
    const state = EditorState.create({
      extensions: language.client.plugin("file:///vault/a.not", "notist"),
    });
    const binding = state
      .facet(keymap)
      .flat()
      .find((entry) => entry.key === "F12")!;
    binding.run!(mounted);
    const content = "latest source";
    mounted.dispatch({
      changes: { from: 0, to: mounted.state.doc.length, insert: content },
      selection: { anchor: 7 },
    });
    language.update([{ ...doc, content }]);
    assert.equal(
      language.sent.some((item) => item.method === "textDocument/definition"),
      false,
    );
    language.releaseInitialize();
    await language.flush();
    const request = language.sent.find(
      (item) => item.method === "textDocument/definition",
    );
    assert.deepEqual(request.params.position, { line: 0, character: 7 });
    const opened = language.sent.find(
      (item) => item.method === "textDocument/didOpen",
    );
    assert.equal(opened.params.textDocument.text, content);
  } finally {
    language.dispose();
  }
});

test("notifications from the previous view owner are ignored until initialization completes", async () => {
  const language = fixture([document("a.not", "new source")], false, true);
  const uri = "file:///vault/a.not";
  const diagnostic = {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    severity: 1,
    message: "previous owner",
  };
  try {
    language.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version: 0, diagnostics: [diagnostic] },
    });
    assert.equal(language.workspace.getFile(uri)!.diagnostics, undefined);
    language.releaseInitialize();
    await language.flush();
    language.receive({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        version: 0,
        diagnostics: [{ ...diagnostic, message: "current owner" }],
      },
    });
    assert.equal(
      language.workspace.getFile(uri)!.diagnostics!.diagnostics[0].message,
      "current owner",
    );
  } finally {
    language.dispose();
  }
});

test("only suffixes supported by Notist attach a language client", () => {
  assert.equal(notistLanguageId("a.not"), "notist");
  assert.equal(notistLanguageId("a.notc"), "notist");
  assert.equal(notistLanguageId("a.md"), "markdown");
  assert.equal(notistLanguageId("Notist.toml"), "notist");
  assert.equal(notistLanguageId("a.NOT"), null);
  assert.equal(notistLanguageId("a.NOTC"), null);
  assert.equal(notistLanguageId("a.MD"), null);
});

test("wire paths remain raw and external package URIs cannot open vault tabs", () => {
  assert.equal(languagePath("file:///vault/a #%.not"), "a #%.not");
  assert.equal(languagePath("file:///outside/lib.notc"), null);
  assert.equal(languagePath("file:///vaultish/a.not"), null);
});
