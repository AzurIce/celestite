import { Show } from "solid-js";
import { StatusSlot } from "@/components/ui/status-slot";
import type { EditorDocument } from "@/lib/editor/contract";
import { languageName } from "./languages";
import type { VimMode } from "./vim";

interface EditorStatusProps {
  document: EditorDocument;
  mount?: Element;
  vimMode?: VimMode | null;
  cursor: { line: number; column: number };
}

function saveStatus(file: EditorDocument) {
  if (file.saving) return "正在保存…";
  if (file.locked) return "正在处理文件…";
  if (file.error) return "保存失败";
  if (file.dirty || file.pending) return "未保存";
  if (file.readOnlyReason) return file.canPreview ? "只读" : "无法编辑";
  return "已保存";
}

export function EditorStatus(props: EditorStatusProps) {
  return (
    <StatusSlot mount={props.mount} class="editor-statusbar">
      <Show when={props.vimMode}>
        <span role="status" aria-label="Vim 模式" class="font-mono text-accent">
          {props.vimMode}
        </span>
      </Show>
      <span
        role="status"
        aria-label="保存状态"
        aria-live="polite"
        class={props.document.error ? "text-danger" : undefined}
      >
        {saveStatus(props.document)}
      </span>
      <span class="hidden sm:inline">{languageName(props.document.path)}</span>
      <span class="hidden sm:inline">
        UTF-8{props.document.bom ? " BOM" : ""} ·{" "}
        {props.document.lineEnding === "\r\n"
          ? "CRLF"
          : props.document.lineEnding === "\r"
            ? "CR"
            : "LF"}
      </span>
      <Show when={!props.document.readOnlyReason}>
        <span class="whitespace-nowrap">
          Ln {props.cursor.line}, Col {props.cursor.column}
        </span>
      </Show>
    </StatusSlot>
  );
}
