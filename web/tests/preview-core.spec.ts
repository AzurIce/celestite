import { expect, test } from "@playwright/test";
import type {
  PreviewCompletion,
  PreviewCoreMethods,
  PreviewTask,
} from "../src/lib/editor/preview/contract";
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
    const seed = new wasm.DocumentBinding(
      JSON.stringify({
        document_id: "doc",
        history_id: "history",
      }),
      "100",
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
          self.postMessage({ result: JSON.parse(render_preview(JSON.stringify(event.data))) });
        } catch (error) { self.postMessage({ error: String(error) }); }
      };
    `,
      ],
      { type: "text/javascript" },
    );
    const url = URL.createObjectURL(blob);
    const worker = new Worker(url, { type: "module" });
    const execute = async <K extends keyof PreviewCoreMethods>(
      method: K,
      params: PreviewCoreMethods[K]["params"],
    ): Promise<PreviewCoreMethods[K]["result"]> =>
      JSON.parse(await core.execute(method, JSON.stringify(params)));
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
      await core.execute(
        "join",
        JSON.stringify({
          path: "note.not",
          packet: JSON.parse(seed.export_snapshot()),
        }),
      );
      await execute("preview_subscribe", {
        id: "doc",
        clientSession: "client",
      });
      const task = (await execute("preview_take_task", { id: "doc" }))!;
      const computed = await render(task);
      const accepted = await execute("preview_complete", {
        completion: computed,
      });
      const first = await execute("preview_state", { id: "doc" });
      await core.execute(
        "replace_text",
        JSON.stringify({
          id: "doc",
          version: task.ticket.version,
          text: "= 新标题\n\n未保存正文",
        }),
      );
      await execute("preview_retry", { id: "doc" });
      const latest = (await execute("preview_take_task", { id: "doc" }))!;
      const staleAccepted = await execute("preview_complete", {
        completion: computed,
      });
      const current = await render(latest);
      const currentAccepted = await execute("preview_complete", {
        completion: current,
      });
      const last = await execute("preview_state", { id: "doc" });
      const document = JSON.parse(
        await core.execute("read", JSON.stringify({ id: "doc" })),
      );
      return {
        accepted,
        staleAccepted,
        currentAccepted,
        first: first.result?.output,
        last: last.result?.output,
        pairedVersion:
          JSON.stringify(last.result?.ticket.version) ===
          JSON.stringify(document.snapshot.version),
        savedVersion: document.savedVersion,
      };
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
      seed.free();
      core.free();
    }
  });
  expect(result.accepted).toBe(true);
  expect(result.staleAccepted).toBe(false);
  expect(result.currentAccepted).toBe(true);
  expect(result.first?.html).toContain("标题");
  expect(result.first?.sourceMap.length).toBeGreaterThan(0);
  expect(result.first?.diagnostics).toHaveLength(2);
  for (const diagnostic of result.first!.diagnostics)
    expect([diagnostic.from, diagnostic.to]).toEqual([11, 23]);
  expect(result.last?.html).toContain("新标题");
  expect(result.last?.html).toContain("未保存正文");
  expect(result.pairedVersion).toBe(true);
  expect(result.savedVersion).toBeNull();
});

test("preview Worker applies package default transforms and retains Unicode diagnostic ranges", async ({
  page,
}) => {
  await page.goto("/");
  const completion = await page.evaluate(async () => {
    const worker = new Worker(
      new URL("/src/lib/editor/preview/worker.ts", location.href),
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
        "packages/katex/lib.notc": "fn math(text: String) -> InlineContent;",
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
  expect(output.usedComponents[0].package).toBe("katex");
  expect(
    output.sourceMap.some((mapping) => mapping.from === 3 && mapping.to === 6),
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
