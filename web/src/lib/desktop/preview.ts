import type { PreviewBinding } from "../editor/generated/celestite_core";
import type {
  PreviewPort,
  PreviewExecutor,
  PreviewResourceRequest,
  PreviewCompletion,
} from "../preview/contract";
import { executePreview } from "../preview/execute";
import { desktopInvoke, type DesktopInvoke } from "./platform";

export function nativePreview(
  handle: string,
  invoke: DesktopInvoke = desktopInvoke,
): PreviewPort {
  const call = <T>(method: string, params: Record<string, unknown> = {}) =>
    invoke<T>("desktop_preview", { handle, method, params });
  return {
    clear: () => call<void>("clear"),
    complete: (completion) => call<boolean>("complete", { completion }),
    events: () => call<ReturnType<PreviewBinding["events"]>>("events"),
    invalidate_project: () => call<void>("invalidate_project"),
    link: (id, taskId, target) =>
      call<ReturnType<PreviewBinding["link"]>>("link", { id, taskId, target }),
    required_snapshots: (id) => call<string[]>("required_snapshots", { id }),
    retry: (id) => call<ReturnType<PreviewBinding["retry"]>>("retry", { id }),
    state: (id) => call<ReturnType<PreviewBinding["state"]>>("state", { id }),
    subscribe: (id, sessionId) =>
      call<ReturnType<PreviewBinding["subscribe"]>>("subscribe", {
        id,
        sessionId,
      }),
    synchronize: (source) => call<boolean>("synchronize", { source }),
    take_task: (id, source) =>
      call<ReturnType<PreviewBinding["take_task"]>>("take_task", {
        id,
        source,
      }),
    unsubscribe: (subscriptionId, sessionId) =>
      call<boolean>("unsubscribe", { subscriptionId, sessionId }),
    // The runtime owns the controller and releases it with the editor handle.
    free() {},
  };
}

export function nativePreviewExecutor(
  invoke: DesktopInvoke = desktopInvoke,
): PreviewExecutor {
  return {
    async execute(task, readResources, signal) {
      signal.throwIfAborted();
      return executePreview(
        structuredClone(task),
        {
          requests: (task) =>
            invoke<PreviewResourceRequest[]>("desktop_preview_requests", {
              task,
            }),
          render: (task) =>
            invoke<PreviewCompletion>("desktop_preview_render", { task }),
        },
        readResources,
        signal,
      );
    },
  };
}
