import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseDocument,
  parseSettingsText,
  resolveSettings,
  withSetting,
} from "../../src/lib/settings/document";
import {
  describeInvalidSetting,
  DEFAULT_SETTINGS,
} from "../../src/lib/settings/schema";
import { SettingsStore } from "../../src/lib/settings/store";
import type { SettingsFile } from "../../src/lib/settings/app-file";
import { createMemoryFile } from "../../src/lib/settings/app-file";
import type { SettingsDocument } from "../../src/lib/settings/document";

class MemoryFile implements SettingsFile {
  stored: string | null = null;
  writes: SettingsDocument[] = [];
  failWrites = false;
  async read() {
    return this.stored;
  }
  async write(document: SettingsDocument) {
    if (this.failWrites) throw new Error("quota exceeded");
    this.writes.push(document);
    this.stored = JSON.stringify(document);
  }
}

function createStore(file: MemoryFile, legacy?: SettingsDocument | null) {
  let cleared = false;
  const store = new SettingsStore({
    file,
    migrateLegacy: () => legacy ?? null,
    clearLegacy: () => {
      cleared = true;
    },
  });
  return { store, file, cleared: () => cleared };
}

test("defaults come from the schema and unknown keys survive a rewrite", () => {
  const parsed = parseDocument(
    {
      "theme.mode": "dark",
      "editor.unknown": { nested: true },
      "sidebar.width": 320,
    },
    "app",
  );
  assert.equal(parsed.values["theme.mode"], "dark");
  assert.equal(parsed.values["sidebar.width"], 320);
  assert.deepEqual(parsed.document, {
    "theme.mode": "dark",
    "editor.unknown": { nested: true },
    "sidebar.width": 320,
  });
  assert.deepEqual(parsed.problems, []);
  const rewritten = withSetting(parsed.document, "editor.wordWrap", true);
  assert.deepEqual(rewritten, {
    "theme.mode": "dark",
    "editor.unknown": { nested: true },
    "sidebar.width": 320,
    "editor.wordWrap": true,
  });
});

test("app overrides defaults and project overrides app per key", () => {
  const app = parseSettingsText(
    JSON.stringify({ "theme.mode": "light", "editor.wordWrap": true }),
    "app",
  );
  const project = parseSettingsText(
    JSON.stringify({ "theme.mode": "dark" }),
    "project",
  );
  const resolved = resolveSettings(app, project);
  assert.deepEqual(resolved.values, {
    "theme.mode": "dark",
    "sidebar.width": DEFAULT_SETTINGS["sidebar.width"],
    "editor.wordWrap": true,
    "editor.vimMode": false,
  });
  assert.equal(resolved.source["theme.mode"], "project");
  assert.equal(resolved.source["editor.wordWrap"], "app");
  assert.equal(resolved.source["sidebar.width"], "default");
});

test("invalid values fall back to the layer below and record a problem", () => {
  const parsed = parseSettingsText(
    JSON.stringify({
      "theme.mode": "banana",
      "sidebar.width": "wide",
      "editor.wordWrap": "yes",
      "editor.future": 1,
    }),
    "project",
  );
  assert.deepEqual(parsed.values, {});
  assert.equal(parsed.problems.length, 3);
  const resolved = resolveSettings(
    parseSettingsText(JSON.stringify({ "theme.mode": "light" }), "app"),
    parsed,
  );
  assert.equal(resolved.values["theme.mode"], "light");
  assert.equal(resolved.values["editor.wordWrap"], false);
  assert.ok(resolved.problems.some((problem) => problem.key === "theme.mode"));
});

test("numbers outside the range are clamped, not rejected", () => {
  assert.equal(
    parseSettingsText('{"sidebar.width": 9000}', "app").values["sidebar.width"],
    560,
  );
  assert.equal(
    parseSettingsText('{"sidebar.width": -5}', "app").values["sidebar.width"],
    200,
  );
  assert.equal(
    parseSettingsText('{"sidebar.width": 300.4}', "app").values[
      "sidebar.width"
    ],
    300,
  );
});

test("broken files degrade to an empty document with one problem", () => {
  for (const text of ["", "   ", "not json", "[1,2]", '"text"', "null"]) {
    const parsed = parseSettingsText(text, "app");
    assert.deepEqual(parsed.values, {});
    assert.deepEqual(parsed.document, {});
  }
  assert.equal(parseSettingsText("not json", "app").problems.length, 1);
  assert.equal(parseSettingsText("[1]", "project").problems.length, 1);
  assert.equal(parseSettingsText("", "app").problems.length, 0);
});

test("validation rejects wrong types but accepts clamped numbers", () => {
  assert.equal(describeInvalidSetting("theme.mode", "dark"), null);
  assert.notEqual(describeInvalidSetting("theme.mode", "dark "), null);
  assert.equal(describeInvalidSetting("sidebar.width", 9000), null);
  assert.notEqual(describeInvalidSetting("sidebar.width", "300"), null);
  assert.equal(describeInvalidSetting("editor.wordWrap", false), null);
  assert.notEqual(describeInvalidSetting("editor.wordWrap", 0), null);
});

test("load reads the app document and notifies subscribers", async () => {
  const { store } = createStore(
    Object.assign(new MemoryFile(), {
      stored: '{"theme.mode":"dark"}',
    }),
  );
  const seen: string[] = [];
  store.subscribe((snapshot) => seen.push(snapshot.values["theme.mode"]));
  await store.load();
  assert.equal(store.snapshot().values["theme.mode"], "dark");
  assert.equal(store.snapshot().storage, "file");
  assert.deepEqual(seen, ["dark"]);
});

test("legacy localStorage keys migrate once and are then cleared", async () => {
  const { store, file, cleared } = createStore(new MemoryFile(), {
    "theme.mode": "dark",
    "sidebar.width": 360,
  });
  await store.load();
  assert.equal(store.snapshot().values["theme.mode"], "dark");
  assert.equal(store.snapshot().values["sidebar.width"], 360);
  assert.equal(file.writes.length, 1);
  assert.deepEqual(file.writes[0], {
    "theme.mode": "dark",
    "sidebar.width": 360,
  });
  assert.equal(cleared(), true);
});

test("an existing app file is never migrated over", async () => {
  const { store, file, cleared } = createStore(
    Object.assign(new MemoryFile(), { stored: '{"theme.mode":"light"}' }),
    { "theme.mode": "dark" },
  );
  await store.load();
  assert.equal(store.snapshot().values["theme.mode"], "light");
  assert.equal(file.writes.length, 0);
  assert.equal(cleared(), false);
});

test("project settings are read only and never written", async () => {
  const { store, file } = createStore(new MemoryFile());
  await store.load();
  store.setProjectReader(async () =>
    JSON.stringify({ "editor.wordWrap": true, "sidebar.width": 200 }),
  );
  await store.reloadProject();
  assert.equal(store.snapshot().values["editor.wordWrap"], true);
  assert.equal(store.snapshot().values["sidebar.width"], 200);
  await store.set("editor.wordWrap", false);
  assert.equal(file.writes.length, 1);
  // 项目层仍然是 true，但内存里的 app 文档已被更新。
  assert.equal(store.snapshot().source["editor.wordWrap"], "project");
  assert.deepEqual(file.writes[0], { "editor.wordWrap": false });
});

test("set refuses invalid values and keeps the stored document", async () => {
  const { store, file } = createStore(
    Object.assign(new MemoryFile(), { stored: '{"theme.mode":"light"}' }),
  );
  await store.load();
  await assert.rejects(() => store.set("theme.mode", "blue" as never));
  await assert.rejects(() => store.set("editor.wordWrap", 1 as never));
  assert.equal(file.writes.length, 0);
  assert.equal(store.snapshot().values["theme.mode"], "light");
});

test("preview updates stay in memory and the next write persists them", async () => {
  const { store, file } = createStore(new MemoryFile());
  await store.load();
  await store.set("sidebar.width", 420, { persist: false });
  assert.equal(store.snapshot().values["sidebar.width"], 420);
  assert.equal(file.writes.length, 0);
  await store.set("sidebar.width", 420);
  assert.equal(file.writes.length, 1);
  assert.deepEqual(file.writes[0], { "sidebar.width": 420 });
});

test("a failed write keeps the value in memory and reports it", async () => {
  const file = new MemoryFile();
  const { store } = createStore(file);
  await store.load();
  file.failWrites = true;
  await store.set("theme.mode", "dark");
  const failed = store.snapshot();
  assert.equal(failed.values["theme.mode"], "dark");
  assert.equal(failed.storage, "memory");
  assert.equal(failed.saveError?.key, "theme.mode");
  file.failWrites = false;
  await store.set("sidebar.width", 320);
  const recovered = store.snapshot();
  assert.equal(recovered.storage, "file");
  assert.equal(recovered.saveError, undefined);
  assert.deepEqual(file.writes.at(-1), {
    "theme.mode": "dark",
    "sidebar.width": 320,
  });
});

test("a theme change notifies the UI before a slow settings write finishes", async () => {
  const file = new MemoryFile();
  const { store } = createStore(file);
  await store.load();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const write = file.write.bind(file);
  file.write = async (document) => {
    started();
    await gate;
    await write(document);
  };
  const seen: string[] = [];
  store.subscribe((snapshot) => seen.push(snapshot.values["theme.mode"]));
  const saved = store.set("theme.mode", "dark");
  await writing;
  try {
    assert.equal(store.snapshot().values["theme.mode"], "dark");
    assert.deepEqual(seen, ["dark"]);
    assert.equal(file.stored, null);
    assert.equal(store.snapshot().storage, "memory");
  } finally {
    release();
    await saved;
  }
  assert.equal(store.snapshot().storage, "file");
  assert.deepEqual(JSON.parse(file.stored!), { "theme.mode": "dark" });
});

test("a project file that cannot be read does not break startup", async () => {
  const { store } = createStore(new MemoryFile());
  await store.load();
  store.setProjectReader(async () => {
    throw new Error("locked");
  });
  await store.reloadProject();
  const snapshot = store.snapshot();
  assert.equal(snapshot.values["theme.mode"], "system");
  assert.equal(
    snapshot.problems.some((problem) => problem.source === "project"),
    true,
  );
});

test("a session-only backend never reports settings as persisted", async () => {
  const store = new SettingsStore({ file: createMemoryFile() });
  await store.load();
  assert.equal(store.snapshot().storage, "memory");
  await store.set("theme.mode", "dark");
  assert.equal(store.snapshot().values["theme.mode"], "dark");
  assert.equal(store.snapshot().storage, "memory");
  assert.equal(store.snapshot().saveError, undefined);
});

test("correcting an invalid setting removes its problem and retains unknown keys", async () => {
  const file = Object.assign(new MemoryFile(), {
    stored: '{"theme.mode":"invalid","future.option":{"keep":true}}',
  });
  const { store } = createStore(file);
  await store.load();
  assert.equal(store.snapshot().problems.length, 1);
  await store.set("theme.mode", "light");
  assert.deepEqual(store.snapshot().problems, []);
  assert.deepEqual(JSON.parse(file.stored!), {
    "theme.mode": "light",
    "future.option": { keep: true },
  });
});

test("a late project read cannot replace the current Vault settings", async () => {
  const { store } = createStore(new MemoryFile());
  await store.load();
  let finish!: (value: string) => void;
  store.setProjectReader(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const oldRead = store.reloadProject();
  store.clearProject();
  store.setProjectReader(async () => '{"theme.mode":"dark"}');
  await store.reloadProject();
  finish('{"theme.mode":"light"}');
  await oldRead;
  assert.equal(store.snapshot().values["theme.mode"], "dark");
  store.clearProject();
  assert.equal(store.snapshot().source["theme.mode"], "default");
});
