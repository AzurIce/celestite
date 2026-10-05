import { CodeMirror, Vim, getCM, vim } from "@replit/codemirror-vim";
import { ViewPlugin, type EditorView } from "@codemirror/view";
import type { CM5EditorInterface, ExParams } from "@replit/codemirror-vim";

export type VimMode =
  "NORMAL" | "INSERT" | "REPLACE" | "VISUAL" | "VISUAL LINE" | "VISUAL BLOCK";

interface VimCommands {
  save: () => void;
  close: () => void;
  unsaved: () => boolean;
  undo?: (redo: boolean) => void;
  onMode: (mode: VimMode) => void;
}

const editors = new WeakMap<EditorView, VimCommands & { group: string }>();
const nativeUndo = CodeMirror.commands.undo;
const nativeRedo = CodeMirror.commands.redo;

// The Vim engine calls CM5 commands directly, bypassing CM6 keymaps. Route
// those commands to the same history and IO services as the rest of the UI.
CodeMirror.commands.undo = (cm) => {
  const commands = editors.get(cm.cm6);
  if (commands?.undo) commands.undo(false);
  else nativeUndo(cm);
};
CodeMirror.commands.redo = (cm) => {
  const commands = editors.get(cm.cm6);
  if (commands?.undo) commands.undo(true);
  else nativeRedo(cm);
};
CodeMirror.commands.save = (cm: CodeMirror) => editors.get(cm.cm6)?.save();
Vim.defineEx("undo", "u", (cm) => CodeMirror.commands.undo(cm as CodeMirror));
Vim.defineEx("redo", "red", (cm) => CodeMirror.commands.redo(cm as CodeMirror));

function notify(cm: CM5EditorInterface, message: string) {
  const text = document.createElement("span");
  text.setAttribute("role", "alert");
  text.textContent = message;
  cm.openNotification(text, { bottom: true, duration: 4000 });
}

function fileCommand(
  cm: CM5EditorInterface,
  params: ExParams,
  action: "save" | "close" | "save-close",
) {
  const commands = editors.get(cm.cm6);
  if (!commands) return;
  if (params.argString?.trim()) {
    notify(cm, "此命令不支持额外参数；保存冲突请在弹窗中处理。");
    return;
  }
  if (action === "save") commands.save();
  else if (action === "close" && commands.unsaved())
    notify(cm, "文件尚未保存，请使用 :w 保存，或 :wq 保存并关闭。");
  else commands.close();
}

Vim.defineEx("write", "w", (cm, params) => fileCommand(cm, params, "save"));
Vim.defineEx("quit", "q", (cm, params) => fileCommand(cm, params, "close"));
Vim.defineEx("wq", "wq", (cm, params) => fileCommand(cm, params, "save-close"));
Vim.defineEx("xit", "x", (cm, params) => fileCommand(cm, params, "save-close"));

/** Explicit Vim commands and insert sessions have distinct core undo groups. */
export function vimUserEvent(view: EditorView) {
  const editor = editors.get(view);
  return editor ? `input.vim.${editor.group}` : undefined;
}

export function vimNormalMode(view: EditorView) {
  const state = getCM(view)?.state.vim;
  return !!state && !state.insertMode && !state.visualMode;
}

export function vimExtension(commands: VimCommands) {
  return [
    vim(),
    ViewPlugin.define((view) => {
      const cm = getCM(view)!;
      const editor = { ...commands, group: crypto.randomUUID() };
      editors.set(view, editor);
      const onMode = (event: { mode: string; subMode?: string }) => {
        const mode = event.mode.toUpperCase();
        commands.onMode(
          (event.subMode
            ? `${mode} ${event.subMode === "linewise" ? "LINE" : "BLOCK"}`
            : mode) as VimMode,
        );
      };
      const onCommand = () => {
        if (!cm.state.vim?.insertMode) editor.group = crypto.randomUUID();
      };
      cm.on("vim-mode-change", onMode);
      cm.on("vim-command-done", onCommand);
      commands.onMode("NORMAL");
      return {
        destroy() {
          cm.off("vim-mode-change", onMode);
          cm.off("vim-command-done", onCommand);
          editors.delete(view);
        },
      };
    }),
  ];
}
