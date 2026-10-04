import type { Page } from "@playwright/test";

/** Inject test-only controls into the actual Worker realm, never the app API. */
export async function installWorkerHarness(page: Page) {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    const root = window as unknown as {
      editorWorkers: Worker[];
      editorMessages: unknown[];
    };
    root.editorWorkers = [];
    root.editorMessages = [];
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        root.editorWorkers.push(this);
        this.addEventListener("message", (event) =>
          root.editorMessages.push(event.data),
        );
      }
    };
  });
  await page.route("**/src/lib/editor/worker.ts*", async (route) => {
    const response = await route.fetch();
    const bootstrap = `self.addEventListener("message", async event => {
      if (event.data?.kind !== "test_control") return;
      try {
        const result = await (0, eval)("(" + event.data.code + ")")(event.data.argument);
        self.postMessage({ kind: "test_result", id: event.data.id, result });
      } catch (error) { self.postMessage({ kind: "test_result", id: event.data.id, error: String(error) }); }
    });\n`;
    await route.fulfill({
      response,
      body: bootstrap + (await response.text()),
    });
  });
}
export async function workerEvaluate<A = undefined, R = unknown>(
  page: Page,
  fn: (argument: A) => R | Promise<R>,
  argument?: A,
): Promise<R> {
  return page.evaluate(
    ({ code, argument }) => {
      const worker = (window as unknown as { editorWorkers: Worker[] })
        .editorWorkers[0];
      if (!worker) throw new Error("No editor Worker exists");
      const id = crypto.randomUUID();
      return new Promise<R>((resolve, reject) => {
        const listener = (event: MessageEvent) => {
          if (event.data.kind !== "test_result" || event.data.id !== id) return;
          worker.removeEventListener("message", listener);
          if (event.data.error) reject(new Error(event.data.error));
          else resolve(event.data.result);
        };
        worker.addEventListener("message", listener);
        worker.postMessage({ kind: "test_control", id, code, argument });
      });
    },
    { code: fn.toString(), argument },
  );
}
