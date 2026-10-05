import type { Page } from "@playwright/test";

/** Inject controls into the actual Worker realm, never the production API. */
export async function installWorkerHarness(page: Page, remote = false) {
  const bootstrap = `const NativeTestSocket = self.WebSocket;
    self.testSockets = [];
    self.delayReplies = false;
    self.WebSocket = class extends NativeTestSocket {
      constructor(...args) { if (self.failConnections) args[0] = String(args[0]) + "/unavailable"; super(...args); self.testSockets.push(this); }
      send(data) {
        const request = JSON.parse(String(data));
        if (self.rejectNextSave && request.method === "save") {
          self.rejectNextSave = false;
          queueMicrotask(() => this.testHandler.call(this, { data: JSON.stringify({ kind: "reply", requestId: request.requestId, error: { code: "Conflict", message: "test disk conflict" } }) }));
          return;
        }
        if (self.dropNextUpdate && JSON.parse(String(data)).method === "updates") {
          self.dropNextUpdate = false;
          this.close();
          return;
        }
        super.send(data);
      }
      set onmessage(handler) { this.testHandler = handler; super.onmessage = event => {
        const frame = JSON.parse(String(event.data));
        if (self.dropNextReply && frame.kind === "reply" && frame.result?.operation) {
          self.dropNextReply = false;
          this.close();
          setTimeout(() => handler.call(this, event), 500);
          return;
        }
        if (self.delayReplies && frame.kind === "reply" && frame.result?.operation) setTimeout(() => handler.call(this, event), 80);
        else handler.call(this, event);
      }; }
    };
    self.addEventListener("message", async event => {
      if (event.data?.kind !== "test_control") return;
      try {
        const result = await (0, eval)("(" + event.data.code + ")")(event.data.argument);
        self.postMessage({ kind: "test_result", id: event.data.id, result });
      } catch (error) { self.postMessage({ kind: "test_result", id: event.data.id, error: String(error) }); }
    });\n`;
  await page.addInitScript(
    ({ remote, bootstrap }) => {
      const NativeWorker = Worker;
      const root = window as unknown as {
        editorWorkers: Worker[];
        editorMessages: unknown[];
      };
      root.editorWorkers = [];
      root.editorMessages = [];
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          const address = new URL(String(url), location.href).href;
          const injected =
            remote && address.includes("/remote/worker.ts")
              ? URL.createObjectURL(
                  new Blob(
                    [`import ${JSON.stringify(address)};\n` + bootstrap],
                    { type: "text/javascript" },
                  ),
                )
              : url;
          super(injected, options);
          if (
            !/\/lib\/editor\/(?:local|remote)\/worker\.ts(?:\?|$)/.test(address)
          )
            return;
          root.editorWorkers.push(this);
          this.addEventListener("message", (event) =>
            root.editorMessages.push(event.data),
          );
        }
      };
    },
    { remote, bootstrap },
  );
  if (!remote)
    await page.route("**/src/lib/editor/local/worker.ts*", async (route) => {
      const response = await route.fetch();
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
  index = 0,
): Promise<R> {
  return page.evaluate(
    ({ code, argument, index }) => {
      const worker = (
        window as unknown as { editorWorkers: Worker[] }
      ).editorWorkers.at(index);
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
    { code: fn.toString(), argument, index },
  );
}
