import init, { LanguageBinding } from "../editor/generated/celestite_core";
import type { PreviewResource } from "../preview/contract";
import type { LanguageWorkerReply, LanguageWorkerRequest } from "./protocol";

const ready = init();
void ready.catch(() => {});

let binding: LanguageBinding | undefined;
// Defensive FIFO: the host already serializes, but a message arriving while a
// resource round-trip is pending must wait for the in-flight item to settle.
const queue: Exclude<LanguageWorkerRequest, { kind: "resources" }>[] = [];
let pumping = false;
let current: number | undefined;
let receive: ((resources: Record<string, PreviewResource>) => void) | undefined;

function post(reply: LanguageWorkerReply) {
  self.postMessage(reply);
}

async function process(
  request: Exclude<LanguageWorkerRequest, { kind: "resources" }>,
) {
  current = request.id;
  try {
    // Initialization failures must settle the host's exchange too.
    await ready;
    binding ??= new LanguageBinding(request.root);
    if (request.kind === "invalidate") {
      binding.invalidate_resources();
      post({ kind: "done", id: request.id });
      return;
    }
    let step = binding.handle(request.message);
    for (;;) {
      if (step.messages.length)
        post({ kind: "messages", id: request.id, messages: step.messages });
      if (!step.resourceRequests.length) break;
      if (!step.context)
        throw new Error("Language resource context is missing");
      post({
        kind: "resources",
        id: request.id,
        requests: step.resourceRequests,
        context: step.context,
      });
      const resources = await new Promise<Record<string, PreviewResource>>(
        (resolve) => {
          receive = resolve;
        },
      );
      receive = undefined;
      step = binding.provide({ resources });
    }
    post({ kind: "done", id: request.id });
  } catch (error) {
    post({
      kind: "error",
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    receive = undefined;
    current = undefined;
  }
}

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) await process(queue.shift()!);
  } finally {
    pumping = false;
  }
}

self.addEventListener(
  "message",
  (event: MessageEvent<LanguageWorkerRequest>) => {
    const request = event.data;
    if (request.kind === "resources") {
      // Resource answers resume the awaiting item; stale ids are dropped.
      if (request.id === current && receive) {
        const answer = receive;
        receive = undefined;
        answer(request.resources);
      }
      return;
    }
    queue.push(request);
    void pump();
  },
);
