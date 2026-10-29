import type { PreviewResources } from "../preview/resources";
import type {
  PreviewResource,
  PreviewResourceRequest,
  ResourceContext,
} from "../preview/contract";
import type { LanguageWorkerReply, LanguageWorkerRequest } from "./protocol";

/** Only this boundary knows about Worker events and wire messages. */
export interface LanguageWorker {
  postMessage(message: LanguageWorkerRequest): void;
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<LanguageWorkerReply>) => void,
  ): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

type LanguageQueueItem =
  | { kind: "message"; id: number; message: string; answered?: boolean }
  | { kind: "invalidate"; id: number };

interface RpcMessage {
  id?: unknown;
  method?: string;
  params?: {
    textDocument?: { uri?: string; text?: string; [key: string]: unknown };
    contentChanges?: { text?: string }[];
  };
  error?: unknown;
}

function parse(message: string): RpcMessage | undefined {
  try {
    const value: unknown = JSON.parse(message);
    return value !== null && typeof value === "object"
      ? (value as RpcMessage)
      : undefined;
  } catch {
    return undefined;
  }
}

const MAX_QUEUE = 256;

/**
 * Serializes the derived service without blocking editor commands. A failed
 * exchange rejects its client requests; the next input starts a fresh service
 * with the last initialization and open document texts.
 */
export class LanguageHost {
  private worker?: LanguageWorker;
  private root?: string;
  private queue: LanguageQueueItem[] = [];
  private nextId = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private disposed = false;
  private current?: LanguageQueueItem;
  private active?: {
    id: number;
    finish: (ok: boolean) => void;
    initializeId?: string;
    initialized: boolean;
  };
  private initialize?: RpcMessage;
  private documents = new Map<
    string,
    NonNullable<RpcMessage["params"]>["textDocument"]
  >();
  private restore = false;
  constructor(
    private resources: PreviewResources,
    private emit: (message: string) => void,
    private createWorker: () => LanguageWorker = () =>
      new Worker(new URL("./worker.ts", import.meta.url), {
        type: "module",
        name: "celestite-language",
      }),
  ) {}
  handle(message: string) {
    if (this.disposed) return;
    const parsed = parse(message);
    const item = { kind: "message" as const, id: ++this.nextId, message };
    // Full-text notifications for one document can replace each other until
    // a request or another notification makes their ordering relevant.
    const previous = this.queue[this.queue.length - 1];
    if (
      parsed?.method === "textDocument/didChange" &&
      previous?.kind === "message" &&
      parse(previous.message)?.method === parsed.method &&
      parse(previous.message)?.params?.textDocument?.uri ===
        parsed.params?.textDocument?.uri
    ) {
      this.queue[this.queue.length - 1] = item;
    } else {
      if (this.queue.length >= MAX_QUEUE)
        this.fail("Language service input queue is full");
      this.queue.push(item);
    }
    if (!parsed || "id" in parsed) this.flush();
    else this.schedule();
  }
  invalidate() {
    if (this.disposed) return;
    if (this.worker && this.root !== this.resources.root)
      this.fail("Language resource root changed");
    if (this.queue[this.queue.length - 1]?.kind !== "invalidate") {
      if (this.queue.length >= MAX_QUEUE)
        this.fail("Language service input queue is full");
      this.queue.push({ kind: "invalidate", id: ++this.nextId });
    }
    this.flush();
  }
  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue.length = 0;
    this.worker?.terminate();
    this.worker = undefined;
    this.documents.clear();
    this.active?.finish(false);
    this.active = undefined;
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 150);
  }
  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    void this.pump();
  }
  private remember(item: LanguageQueueItem) {
    if (item.kind !== "message") return;
    const parsed = parse(item.message);
    if (parsed?.method === "initialize") {
      this.initialize = parsed;
      return;
    }
    const document = parsed?.params?.textDocument;
    if (typeof document?.uri !== "string") return;
    if (parsed?.method === "textDocument/didClose") {
      this.documents.delete(document.uri);
    } else if (
      parsed?.method === "textDocument/didOpen" &&
      typeof document.text === "string"
    ) {
      this.documents.set(document.uri, { ...document });
    } else if (parsed?.method === "textDocument/didChange") {
      const changes = parsed.params?.contentChanges;
      const text = changes?.[changes.length - 1]?.text;
      if (typeof text === "string")
        this.documents.set(document.uri, {
          ...this.documents.get(document.uri),
          ...document,
          text,
        });
    }
  }
  private async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.disposed && this.queue.length) {
        const item = (this.current = this.queue.shift()!);
        this.remember(item);
        try {
          if (this.worker && this.root !== this.resources.root) {
            this.worker.terminate();
            this.worker = undefined;
            this.restore = true;
          }
          const worker = (this.worker ??= this.spawn());
          if (
            this.restore &&
            this.initialize &&
            !(
              item.kind === "message" &&
              parse(item.message)?.method === "initialize"
            )
          ) {
            if (!(await this.reopen(worker))) continue;
          }
          this.restore = false;
          if (!(await this.exchange(worker, item))) continue;
          if (item.kind === "invalidate")
            await this.exchange(worker, {
              kind: "message",
              id: ++this.nextId,
              message: JSON.stringify({
                jsonrpc: "2.0",
                method: "workspace/didChangeWatchedFiles",
                params: { changes: [] },
              }),
            });
        } catch (error) {
          this.fail(error);
        } finally {
          this.current = undefined;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
  private async reopen(worker: LanguageWorker) {
    const id = `celestite-restore-${++this.nextId}`;
    if (
      !(await this.exchange(
        worker,
        {
          kind: "message",
          id: ++this.nextId,
          message: JSON.stringify({ ...this.initialize, id }),
        },
        id,
      ))
    )
      return false;
    if (
      !(await this.exchange(worker, {
        kind: "message",
        id: ++this.nextId,
        message: JSON.stringify({
          jsonrpc: "2.0",
          method: "initialized",
          params: {},
        }),
      }))
    )
      return false;
    for (const document of this.documents.values())
      if (
        !(await this.exchange(worker, {
          kind: "message",
          id: ++this.nextId,
          message: JSON.stringify({
            jsonrpc: "2.0",
            method: "textDocument/didOpen",
            params: { textDocument: document },
          }),
        }))
      )
        return false;
    return true;
  }
  private exchange(
    worker: LanguageWorker,
    item: LanguageQueueItem,
    initializeId?: string,
  ) {
    return new Promise<boolean>((finish) => {
      this.active = { id: item.id, finish, initializeId, initialized: false };
      try {
        worker.postMessage(
          item.kind === "message"
            ? {
                kind: "message",
                id: item.id,
                root: this.root!,
                message: item.message,
              }
            : { kind: "invalidate", id: item.id, root: this.root! },
        );
      } catch (error) {
        this.fail(error);
      }
    });
  }
  private spawn() {
    const worker = this.createWorker();
    this.root = this.resources.root;
    worker.addEventListener("message", (event) => {
      if (this.worker === worker) this.reply(worker, event.data);
    });
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      if (this.worker === worker) this.fail("Language worker crashed");
    });
    return worker;
  }
  private reject(item: LanguageQueueItem, reason: string) {
    if (item.kind !== "message" || item.answered) return;
    const parsed = parse(item.message);
    if (!parsed || !("id" in parsed)) return;
    item.answered = true;
    this.emit(
      JSON.stringify({
        jsonrpc: "2.0",
        id: parsed.id,
        error: { code: -32603, message: reason },
      }),
    );
  }
  /** One failure settles all affected requests. Only new input retries. */
  private fail(error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    if (this.current) this.reject(this.current, reason);
    for (const item of this.queue) {
      this.remember(item);
      this.reject(item, reason);
    }
    this.queue.length = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.worker?.terminate();
    this.worker = undefined;
    this.restore = true;
    const active = this.active;
    this.active = undefined;
    active?.finish(false);
  }
  private reply(worker: LanguageWorker, reply: LanguageWorkerReply) {
    const active = this.active;
    if (this.disposed || !active || reply.id !== active.id) return;
    if (this.root !== this.resources.root) {
      this.fail("Language resource root changed");
      return;
    }
    if (reply.kind === "messages") {
      for (const message of reply.messages) {
        const parsed = parse(message);
        if (active.initializeId && parsed?.id === active.initializeId) {
          if (parsed.error) {
            this.fail("Language service initialization failed");
            return;
          }
          active.initialized = true;
          continue;
        }
        if (this.current?.kind === "message") {
          const request = parse(this.current.message);
          if (parsed && "id" in parsed && parsed.id === request?.id)
            this.current.answered = true;
        }
        this.emit(message);
      }
      return;
    }
    if (reply.kind === "resources") {
      const root = this.root;
      const current = () =>
        !this.disposed &&
        this.active === active &&
        this.worker === worker &&
        this.resources.root === root;
      void this.readResources(reply.requests, reply.context, current).then(
        (resources) => {
          if (!current()) return;
          try {
            worker.postMessage({ kind: "resources", id: reply.id, resources });
          } catch (error) {
            this.fail(error);
          }
        },
        (error) => {
          if (this.active === active && this.worker === worker)
            this.fail(error);
        },
      );
      return;
    }
    if (reply.kind === "error") {
      this.fail(reply.message);
      return;
    }
    if (active.initializeId && !active.initialized) {
      this.fail("Language service did not answer initialization");
      return;
    }
    this.active = undefined;
    active.finish(true);
  }
  private async readResources(
    requests: PreviewResourceRequest[],
    context: ResourceContext,
    current: () => boolean,
  ) {
    const resources: Record<string, PreviewResource> = {};
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(8, requests.length) }, async () => {
        while (next < requests.length) {
          if (!current()) throw new Error("Language resource exchange changed");
          const request = requests[next++];
          const answer = await this.resources.read(request, context);
          if (!current()) throw new Error("Language resource exchange changed");
          resources[request.path] = answer;
        }
      }),
    );
    return resources;
  }
}
