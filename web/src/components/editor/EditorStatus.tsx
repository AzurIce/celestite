import { Show, createMemo } from "solid-js";
import { Check, ChevronDown, Save } from "@/components/icons";
import { StatusSlot } from "@/components/ui/status-slot";
import type { EditorDocument } from "@/lib/editor/contract";
import { languageName } from "./languages";
import type { VimMode } from "./vim";

interface EditorStatusProps {
  document: EditorDocument;
  mount?: Element;
  vimMode?: VimMode | null;
  cursor: { line: number; column: number };
  reading: boolean;
}

function saveStatus(file: EditorDocument) {
  if (file.inputFailure) return "编辑需要恢复";
  if (file.saving) return "正在保存…";
  if (file.locked) return "正在处理文件…";
  if (file.externalChange)
    return file.externalChange.phase === "pending"
      ? "正在同步外部修改…"
      : "外部修改尚未同步";
  if (file.error) return "保存失败";
  if (file.readOnlyReason) return file.canPreview ? "只读" : "无法编辑";
  if (file.dirty || file.pending) return "未保存";
  return "已保存";
}

export function EditorStatus(props: EditorStatusProps) {
  const content = createMemo(() => props.document.content);
  const wordCount = createMemo(() => {
    const text = content();
    const chinese = text.match(/[\u3400-\u9fff]/gu)?.length ?? 0;
    const words =
      text.replace(/[\u3400-\u9fff]/gu, " ").match(/[\p{L}\p{N}]+/gu)?.length ??
      0;
    return chinese + words;
  });
  const lineEnding = () =>
    props.document.lineEnding === "\r\n"
      ? "CRLF"
      : props.document.lineEnding === "\r"
        ? "CR"
        : "LF";
  return (
    <StatusSlot mount={props.mount} class="editor-statusbar">
      <div class="editor-status-primary">
        <span
          role="status"
          aria-label="保存状态"
          aria-live="polite"
          class={
            props.document.error
              ? "editor-save-status text-danger"
              : "editor-save-status"
          }
        >
          <Show
            when={
              props.document.dirty ||
              props.document.pending ||
              props.document.error ||
              props.document.saving
            }
            fallback={<Check size={11} />}
          >
            <Save size={11} />
          </Show>
          {saveStatus(props.document)}
        </span>
        <Show when={props.vimMode}>
          <span role="status" aria-label="Vim 模式" class="editor-vim-status">
            {props.vimMode}
          </span>
        </Show>
      </div>
      <div class="editor-status-details">
        <span aria-label="字数">{wordCount()} 字</span>
        <Show when={!props.reading}>
          <span class="editor-status-language">
            {languageName(props.document.path)}
          </span>
        </Show>
        <Show when={!props.reading && !props.document.readOnlyReason}>
          <span class="editor-status-cursor">
            Ln {props.cursor.line}, Col {props.cursor.column}
          </span>
        </Show>
        <Show when={!props.reading}>
          <details class="editor-document-info" aria-label="文档信息">
            <summary>
              UTF-8
              <span class="editor-status-encoding">
                {props.document.bom ? " BOM" : ""} · {lineEnding()}
              </span>
              <ChevronDown size={10} />
            </summary>
            <div class="editor-document-info-content">
              <span>{props.document.path}</span>
              <span>
                {languageName(props.document.path)} · UTF-8
                {props.document.bom ? " BOM" : ""} · {lineEnding()}
              </span>
            </div>
          </details>
        </Show>
      </div>
    </StatusSlot>
  );
}
