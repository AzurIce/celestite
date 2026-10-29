import type { LanguageWorker } from "../language/host";
import type {
  LanguageWorkerReply,
  LanguageWorkerRequest,
} from "../language/protocol";
import { desktopInvoke, type DesktopInvoke } from "./platform";

/**
 * The native host runs the whole handle/provide resource loop inside one
 * invoke; from the LanguageHost's perspective it is a worker that never asks
 * for resources. Output messages are the invoke result, never pushed events.
 */
export function nativeLanguageWorker(
  handle: string,
  invoke: DesktopInvoke = desktopInvoke,
): LanguageWorker {
  const messageListeners = new Set<
    (event: MessageEvent<LanguageWorkerReply>) => void
  >();
  let started: Promise<unknown> | undefined;
  let terminated = false;
  const dispatch = (reply: LanguageWorkerReply) => {
    if (terminated) return;
    for (const listener of messageListeners)
      listener({ data: reply } as MessageEvent<LanguageWorkerReply>);
  };
  return {
    postMessage(request: LanguageWorkerRequest) {
      if (terminated || request.kind === "resources") return;
      const command =
        request.kind === "invalidate"
          ? { kind: "invalidate" }
          : { kind: "message", message: request.message };
      // A wrapper has the lifecycle of one Worker. The native session survives
      // a derived-service failure, so reset its old binding before handshaking.
      started ??= invoke("desktop_language", {
        handle,
        command: { kind: "reset" },
      });
      void started
        .then(() => {
          if (terminated) return [];
          return invoke<string[]>("desktop_language", { handle, command });
        })
        .then(
          (messages) => {
            if (messages.length)
              dispatch({ kind: "messages", id: request.id, messages });
            dispatch({ kind: "done", id: request.id });
          },
          (error) =>
            dispatch({
              kind: "error",
              id: request.id,
              message: error instanceof Error ? error.message : String(error),
            }),
        );
    },
    addEventListener(
      type: "message" | "error",
      listener:
        | ((event: MessageEvent<LanguageWorkerReply>) => void)
        | ((event: ErrorEvent) => void),
    ) {
      if (type === "message")
        messageListeners.add(
          listener as (event: MessageEvent<LanguageWorkerReply>) => void,
        );
    },
    terminate() {
      terminated = true;
      messageListeners.clear();
    },
  };
}
