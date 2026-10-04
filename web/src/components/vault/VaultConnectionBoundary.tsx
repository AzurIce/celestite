import { Show, createSignal, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import { Button } from "@/components/ui";
import type { EditorDocuments } from "@/lib/editor/contract";

/** The whole active Vault stops accepting UI interaction while disconnected. */
export function VaultConnectionBoundary(props: {
  documents: EditorDocuments;
  children: (disabled: () => boolean) => JSX.Element;
}) {
  const [state, setState] = createSignal(props.documents.snapshot());
  const unsubscribe = props.documents.subscribe(setState);
  onCleanup(unsubscribe);
  const disconnected = () =>
    !!state().connection && state().connection?.status !== "online";
  function exportDrafts() {
    const blob = new Blob(
      [
        JSON.stringify(
          state().documents.map(({ path, content }) => ({ path, content })),
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "celestite-drafts.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function reconnect(discard = false) {
    try {
      await props.documents.reconnect?.(discard);
    } catch {
      /* The connection snapshot exposes the failure in the overlay. */
    }
  }
  return (
    <div class="workspace-content relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        class="workspace-content-body flex min-h-0 min-w-0 flex-1 flex-col"
        inert={disconnected()}
        aria-hidden={disconnected() ? "true" : undefined}
      >
        {props.children(disconnected)}
      </div>
      <Show when={disconnected()}>
        <div
          class="vault-connection-overlay"
          role="region"
          aria-label="远端连接状态"
        >
          <div class="vault-connection-card">
            <h2 class="text-ui-heading font-medium">
              {state().connection?.status === "reconnecting"
                ? "正在重新连接…"
                : "远端连接已断开"}
            </h2>
            <p class="mt-2 text-ui-sm text-secondary">
              重新连接后，将以远端历史重新打开编辑会话。
            </p>
            <Show when={state().connection?.unconfirmed}>
              <p class="mt-2 text-ui-sm text-secondary">
                尚有未确认输入。可以先导出当前正文；重连不会自动恢复这些输入。
              </p>
            </Show>
            <Show when={state().connection?.error}>
              <p role="alert" class="mt-3 text-ui-sm text-danger">
                {state().connection?.error}
              </p>
            </Show>
            <div class="mt-4 flex flex-wrap justify-center gap-2">
              <Show when={state().connection?.unconfirmed}>
                <Button onClick={exportDrafts}>导出当前正文</Button>
              </Show>
              <Button
                variant="primary"
                disabled={
                  state().connection?.status === "reconnecting" ||
                  !props.documents.reconnect
                }
                onClick={() =>
                  void reconnect(!!state().connection?.unconfirmed)
                }
              >
                {state().connection?.status === "reconnecting"
                  ? "正在重新连接…"
                  : state().connection?.unconfirmed
                    ? "丢弃未确认输入并重新连接"
                    : "尝试重新连接"}
              </Button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}
