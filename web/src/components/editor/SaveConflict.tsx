import { Show } from "solid-js";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui";
import type { DocumentsSnapshot } from "@/lib/editor/documents";
import type { EditorDocuments } from "@/lib/editor/contract";

export function SaveConflict(props: {
  documents: EditorDocuments;
  state: DocumentsSnapshot;
}) {
  let cancel!: HTMLButtonElement;
  const file = () =>
    props.state.documents.find(
      (file) => file.id === props.state.conflictPrompt?.id,
    );
  const shared = () => file()?.conflictResolution === "shared";
  return (
    <Dialog
      open={!!props.state.conflictPrompt}
      onOpenChange={(open) => {
        if (!open) void props.documents.resolveConflict("cancel");
      }}
    >
      <DialogContent
        class="editor-conflict-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (props.state.conflictResolving) event.preventDefault();
        }}
      >
        <DialogTitle>
          {shared() ? "共享文档暂时无法保存" : "文件已在磁盘上修改"}
        </DialogTitle>
        <DialogDescription>
          <Show
            when={shared()}
            fallback={
              <>
                “{file()?.path}”在你编辑期间已被其他客户端或程序修改。
                要用编辑器中的内容覆盖磁盘版本，还是丢弃本地编辑？
              </>
            }
          >
            “{file()?.path}”的共享编辑已保留。请核对磁盘变化后重试保存；
            保存冲突不会丢弃或覆盖协作者的共享历史。
          </Show>
        </DialogDescription>
        <div class="mt-5 flex flex-col gap-2">
          <Show when={shared()}>
            <Button
              variant="primary"
              disabled={props.state.conflictResolving}
              onClick={() => void props.documents.resolveConflict("retry")}
            >
              重试保存
            </Button>
          </Show>
          <Show when={!shared()}>
            <Button
              variant="primary"
              disabled={props.state.conflictResolving}
              onClick={() => void props.documents.resolveConflict("overwrite")}
            >
              覆盖保存
            </Button>
            <Button
              disabled={props.state.conflictResolving}
              onClick={() => void props.documents.resolveConflict("discard")}
            >
              丢弃编辑
            </Button>
          </Show>
          <Button
            ref={cancel}
            disabled={props.state.conflictResolving}
            onClick={() => void props.documents.resolveConflict("cancel")}
          >
            取消
          </Button>
        </div>
        <Show when={props.state.conflictResolving}>
          <p role="status" class="mt-3 text-ui-sm text-secondary">
            正在处理…
          </p>
        </Show>
        <Show when={props.state.conflictError}>
          <p role="alert" class="mt-3 text-ui-sm text-danger">
            {props.state.conflictError}
          </p>
        </Show>
      </DialogContent>
    </Dialog>
  );
}
