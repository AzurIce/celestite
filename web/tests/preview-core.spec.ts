import { expect, test } from "@playwright/test";
import type {
  PreviewCompletion,
  PreviewTask,
} from "../src/lib/preview/contract";
type CoreModule = typeof import("../src/lib/editor/generated/celestite_core");

test("WASM preview tasks execute in an independent Worker and reject stale results", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const moduleUrl = new URL(
      "/src/lib/editor/generated/celestite_core.js",
      location.href,
    ).href;
    const wasm = (await import(moduleUrl)) as CoreModule;
    await wasm.default();
    const core = await wasm.MemoryEditorBinding.open(
      JSON.stringify({
        instanceId: "preview-test",
        vault: { vaultId: "vault", historyId: "vault-history" },
      }),
    );
    const seed = new wasm.BufferBinding(
      JSON.stringify({
        document_id: "doc",
        history_id: "history",
      }),
      "18446744073709551614",
      "= 标题\n\n😀中文 #unknown[ok]",
    );
    const blob = new Blob(
      [
        `
      import init, { render_preview } from ${JSON.stringify(moduleUrl)};
      const ready = init();
      self.onmessage = async event => {
        try {
          await ready;
          self.postMessage({ result: render_preview(event.data) });
        } catch (error) { self.postMessage({ error: String(error) }); }
      };
    `,
      ],
      { type: "text/javascript" },
    );
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, { type: "module" });
    const previews = new wasm.PreviewBinding();
    const call = async (method: string, params: object) => {
      const reply = JSON.parse(await core.call(method, JSON.stringify(params)));
      if (reply.status === "error") throw new Error(reply.error.message);
      return reply;
    };
    const synchronize = async () => {
      previews.synchronize((await call("document_source", { ids: [] })).value);
    };
    const takeTask = async () => {
      await synchronize();
      return previews.take_task(
        "doc",
        (
          await call("document_source", {
            ids: previews.required_snapshots("doc"),
          })
        ).value,
      )!;
    };
    const render = (task: PreviewTask) =>
      new Promise<PreviewCompletion>((resolve, reject) => {
        worker.addEventListener(
          "message",
          (event) => {
            if (event.data.error) reject(new Error(event.data.error));
            else resolve(event.data.result);
          },
          { once: true },
        );
        worker.addEventListener(
          "error",
          (event) => reject(new Error(event.message)),
          { once: true },
        );
        worker.postMessage(task);
      });
    try {
      await call("join", {
        path: "note.not",
        packet: JSON.parse(seed.export_snapshot()),
      });
      await synchronize();
      previews.subscribe("doc", "client");
      const task = await takeTask();
      const computed = await render(task);
      await synchronize();
      const accepted = previews.complete(computed);
      const first = previews.state("doc");
      await call("apply", {
        id: "doc",
        command: {
          kind: "edit",
          base: task.ticket.version,
          input: { kind: "text", text: "= 新标题\n\n未保存正文" },
        },
      });
      await synchronize();
      previews.retry("doc");
      const latest = await takeTask();
      const staleAccepted = previews.complete(computed);
      const current = await render(latest);
      await synchronize();
      const currentAccepted = previews.complete(current);
      const last = previews.state("doc");
      const document = (await call("read", { id: "doc" })).value;
      return {
        accepted,
        staleAccepted,
        currentAccepted,
        first: first.result?.output,
        last: last.result?.output,
        previewVersion: last.result?.ticket.version,
        documentVersion: document.snapshot.version,
        savedVersion: document.savedVersion,
        initialVersion: task.ticket.version,
      };
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
      seed.free();
      previews.free();
      core.free();
    }
  });
  expect(result.accepted).toBe(true);
  expect(result.staleAccepted).toBe(false);
  expect(result.currentAccepted).toBe(true);
  expect(result.first?.html).toContain("标题");
  expect(result.first?.sourceMap?.length).toBeGreaterThan(0);
  expect(result.first?.diagnostics).toHaveLength(2);
  for (const diagnostic of result.first!.diagnostics)
    expect([diagnostic.from, diagnostic.to]).toEqual([11, 23]);
  expect(result.last?.html).toContain("新标题");
  expect(result.last?.html).toContain("未保存正文");
  expect(result.previewVersion).toEqual(result.documentVersion);
  expect(result.savedVersion).toBeNull();
  expect(Object.getPrototypeOf(result.initialVersion)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(result.initialVersion.clocks)).toBe(
    Object.prototype,
  );
  expect(Object.keys(result.initialVersion.clocks)).toContain(
    "18446744073709551614",
  );
  expect(
    Object.values(result.initialVersion.clocks).every(Number.isInteger),
  ).toBe(true);
});

test("preview bindings accept cloneable objects and defaults, and reject malformed inputs", async ({
  page,
}) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const wasm = (await import(
      new URL("/src/lib/editor/generated/celestite_core.js", location.href).href
    )) as CoreModule;
    await wasm.default();
    const task: PreviewTask = {
      ticket: {
        taskId: "object-boundary",
        sessionId: "object-session",
        documentId: "doc",
        path: "note.not",
        renderGeneration: "object-test",
        version: {
          identity: { document_id: "doc", history_id: "history" },
          clocks: { "18446744073709551614": 1 },
        },
      },
      source: "😀 $x$",
    };
    const completion = wasm.render_preview(task);
    const requests = wasm.preview_resource_requests(task);
    const explicit: PreviewTask = {
      ...task,
      overlays: {},
      resourceRoot: "/vault",
      resources: {
        "missing.not": { kind: null, data: null, error: null },
        "bytes.not": { kind: "file", data: [0, 127, 255], error: null },
      },
    };
    const cloned = structuredClone(explicit);
    const explicitCompletion = wasm.render_preview(cloned);
    const malformed = [
      {},
      { ...explicit, source: 42 },
      ...[[-1], [256], [1.5], ["1"], [null], "AQ=="].map((data) => ({
        ...explicit,
        resources: {
          "unused.not": { kind: "file", data, error: null },
        },
      })),
    ];
    const rejected = malformed.map((input) =>
      [wasm.render_preview, wasm.preview_resource_requests].map((binding) => {
        try {
          // Exercise invalid JS callers without claiming they are valid tasks.
          Reflect.apply(binding, undefined, [input]);
          return false;
        } catch {
          return true;
        }
      }),
    );
    return {
      completion,
      explicitCompletion,
      requests,
      rejected,
      plain:
        Object.getPrototypeOf(completion) === Object.prototype &&
        Object.getPrototypeOf(completion.outcome) === Object.prototype &&
        Object.getPrototypeOf(cloned.overlays) === Object.prototype &&
        Object.getPrototypeOf(cloned.resources) === Object.prototype &&
        Object.getPrototypeOf(cloned.ticket.version.clocks) ===
          Object.prototype,
      resources: cloned.resources,
    };
  });
  expect(result.plain).toBe(true);
  expect(Array.isArray(result.requests)).toBe(true);
  expect(result.requests.length).toBeGreaterThan(0);
  for (const request of result.requests) {
    expect(Object.getPrototypeOf(request)).toBe(Object.prototype);
    expect(typeof request.path).toBe("string");
    expect(typeof request.read).toBe("boolean");
  }
  expect(result.completion).toEqual(result.explicitCompletion);
  expect(result.completion.outcome.kind).toBe("success");
  if (result.completion.outcome.kind !== "success")
    throw new Error(result.completion.outcome.message);
  const output = result.completion.outcome.output;
  expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  expect(Array.isArray(output.diagnostics)).toBe(true);
  expect(Array.isArray(output.sourceMap)).toBe(true);
  expect(Array.isArray(output.usedComponents)).toBe(true);
  expect(output.sourceMap).toContainEqual(
    expect.objectContaining({ from: 3, to: 6 }),
  );
  expect(result.resources?.["missing.not"]).toEqual({
    kind: null,
    data: null,
    error: null,
  });
  expect(result.resources?.["bytes.not"].data).toEqual([0, 127, 255]);
  expect(Array.isArray(result.resources?.["bytes.not"].data)).toBe(true);
  expect(result.rejected.every((bindings) => bindings.every(Boolean))).toBe(
    true,
  );
});

test("preview Worker applies package default transforms and retains Unicode diagnostic ranges", async ({
  page,
}) => {
  await page.goto("/");
  const completion = await page.evaluate(async () => {
    const worker = new Worker(
      new URL("/src/lib/preview/worker.ts", location.href),
      { type: "module" },
    );
    const task: PreviewTask = {
      ticket: {
        taskId: "transform-task",
        sessionId: "transform-session",
        documentId: "doc",
        path: "math.not",
        renderGeneration: "transform-test",
        version: {
          identity: { document_id: "doc", history_id: "history" },
          clocks: {},
        },
      },
      resourceRoot: "/vault",
      source: "😀 $x$ #math(false)",
      overlays: {
        "Notist.toml":
          "future_option = true\n[dependencies]\nkatex = {path = 'packages/katex'}\n",
        "packages/katex/Notist.toml":
          "[package]\nname = 'katex'\n[[transforms]]\nkind = 'replace'\nfrom = 'notist::math'\nto = 'katex::math'\n",
        "packages/katex/lib.notc":
          "fn math(text: String, block?: Bool) -> Content<block>;",
        "packages/katex/components/math.js":
          "export default class extends HTMLElement {}",
      },
      resources: {
        "packages/katex/components/math/index.js": {
          kind: null,
          data: null,
          error: null,
        },
      },
    };
    try {
      return await new Promise<PreviewCompletion>((resolve, reject) => {
        worker.addEventListener("message", (event) => {
          if (event.data.kind === "resources") {
            reject(new Error("unexpected resource request"));
            return;
          }
          resolve(event.data);
        });
        worker.addEventListener("error", (event) =>
          reject(new Error(event.message)),
        );
        worker.postMessage(task);
      });
    } finally {
      worker.terminate();
    }
  });
  expect(completion.outcome.kind).toBe("success");
  if (completion.outcome.kind !== "success")
    throw new Error(completion.outcome.message);
  const output = completion.outcome.output;
  expect(output.html).toContain("<katex-math");
  expect(output.usedComponents?.[0]?.package).toBe("katex");
  expect(
    output.sourceMap?.some((mapping) => mapping.from === 3 && mapping.to === 6),
  ).toBe(true);
  expect(output.diagnostics).toContainEqual(
    expect.objectContaining({
      origin: "transform",
      path: "math.not",
      from: 7,
      to: 19,
      source: null,
    }),
  );
});
