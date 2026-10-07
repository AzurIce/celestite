import { test } from "node:test";
import assert from "node:assert/strict";
import { PreviewHost } from "../../src/lib/editor/preview/host";
import type { PreviewResources } from "../../src/lib/editor/preview/resources";
import type {
  PreviewEvent,
  PreviewState,
  PreviewTask,
  PreviewTicket,
} from "../../src/lib/editor/preview/contract";

class Executor extends EventTarget {
  tasks: PreviewTask[] = [];
  terminated = false;
  postMessage(task: PreviewTask) {
    this.tasks.push(task);
  }
  terminate() {
    this.terminated = true;
  }
}

test("environment invalidation completes the old core task before terminating its executor", async () => {
  const ticket: PreviewTicket = {
    taskId: "first",
    sessionId: "session",
    documentId: "doc",
    path: "a.not",
    renderGeneration: "first",
    version: {
      identity: { document_id: "doc", history_id: "history" },
      clocks: {},
    },
  };
  let state: PreviewState = {
    target: ticket,
    status: "pending",
    result: null,
    error: null,
    diagnostics: [],
    dueAt: 0,
  };
  let running: PreviewTask | undefined;
  let sequence = 0;
  const events: PreviewEvent[] = [];
  const completions: string[] = [];
  const publish = () =>
    events.push({
      documentId: "doc",
      sequence: ++sequence,
      state: { ...state },
    });
  publish();
  const execute = (async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case "preview_events":
        return events.splice(0);
      case "preview_take_task": {
        if (running) return null;
        running = {
          ticket: state.target,
          source: "text",
          overlays: {},
          resources: {},
          resourceRoot: "/vault",
        };
        state = { ...state, status: "computing", dueAt: null };
        publish();
        return running;
      }
      case "preview_complete": {
        const completion = params.completion as { taskId: string };
        assert.equal(completion.taskId, running?.ticket.taskId);
        completions.push(completion.taskId);
        running = undefined;
        return true;
      }
      case "preview_invalidate_project": {
        state = {
          ...state,
          target: { ...ticket, taskId: "next", renderGeneration: "next" },
          status: "pending",
          dueAt: 0,
        };
        publish();
        return;
      }
      default:
        throw new Error(method);
    }
  }) as ConstructorParameters<typeof PreviewHost>[0];
  const executors: Executor[] = [];
  const host = new PreviewHost(
    execute,
    () => {},
    () => {},
    { root: "/vault" } as PreviewResources,
    () => {
      const executor = new Executor();
      executors.push(executor);
      return executor as unknown as Worker;
    },
  );
  try {
    await host.refresh();
    assert.equal(executors[0].tasks[0].ticket.taskId, "first");
    await host.invalidateProject();
    assert.deepEqual(completions, ["first"]);
    assert.equal(executors[0].terminated, true);
    await host.refresh();
    assert.equal(executors[1].tasks[0].ticket.taskId, "next");
  } finally {
    host.close();
  }
});
