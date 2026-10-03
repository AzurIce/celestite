import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { RefreshCw, Settings2 } from "@/components/icons";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
  IconButton,
} from "@/components/ui";
import { settings, setSetting } from "@/lib/settings";
import { parseDocument } from "@/lib/settings/document";
import {
  DEFAULT_SETTINGS,
  SETTINGS_SCHEMA,
  type SettingKey,
  type Settings,
  type ThemeModeSetting,
} from "@/lib/settings/schema";
import "./settings.css";

const themeLabels: Record<ThemeModeSetting, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

function valueLabel(key: SettingKey, value: Settings[SettingKey]) {
  if (key === "theme.mode") return themeLabels[value as ThemeModeSetting];
  if (key === "sidebar.width") return `${value} px`;
  return value ? "开启" : "关闭";
}

function OverrideNotice(props: { setting: SettingKey }) {
  return (
    <Show when={settings().source[props.setting] === "project"}>
      <p class="settings-override">
        当前 Vault 覆盖为：
        {valueLabel(props.setting, settings().values[props.setting])}。
        此处修改全局默认值。
      </p>
    </Show>
  );
}

function SettingsFields() {
  // Global controls deliberately ignore project overrides when displaying their values.
  const global = createMemo(() => ({
    ...DEFAULT_SETTINGS,
    ...parseDocument(settings().documents.app, "app").values,
  }));
  const [pending, setPending] = createSignal(0);
  const [localError, setLocalError] = createSignal<string | null>(null);
  const [widthDraft, setWidthDraft] = createSignal(
    String(global()["sidebar.width"]),
  );
  const [widthError, setWidthError] = createSignal<string | null>(null);
  const id = `settings-${crypto.randomUUID()}`;
  const range = SETTINGS_SCHEMA["sidebar.width"].range!;
  let writes = 0;
  let disposed = false;
  let editingWidth = false;
  let observedWidth = global()["sidebar.width"];
  let lastAttempt: { key: SettingKey; value: Settings[SettingKey] } | undefined;
  onCleanup(() => {
    disposed = true;
  });
  createEffect(
    () => global()["sidebar.width"],
    (width) => {
      if (width === observedWidth) return;
      observedWidth = width;
      if (editingWidth) return;
      setWidthDraft(String(width));
      setWidthError(null);
    },
  );
  const error = () => localError() || settings().saveError?.reason;
  const widthChanged = () => widthDraft() !== String(global()["sidebar.width"]);

  async function save<K extends SettingKey>(key: K, value: Settings[K]) {
    lastAttempt = { key, value };
    writes++;
    setPending(writes);
    setLocalError(null);
    try {
      await setSetting(key, value);
    } catch (error) {
      if (!disposed)
        setLocalError(error instanceof Error ? error.message : String(error));
    } finally {
      writes--;
      if (!disposed) setPending(writes);
    }
  }
  function commitWidth(value: string) {
    const parsed = Number(value);
    if (
      !value.trim() ||
      !Number.isInteger(parsed) ||
      parsed < range.min ||
      parsed > range.max
    ) {
      setWidthError(`请输入 ${range.min} 至 ${range.max} 之间的整数。`);
      return;
    }
    setWidthError(null);
    editingWidth = false;
    setWidthDraft(String(parsed));
    if (parsed !== global()["sidebar.width"])
      void save("sidebar.width", parsed);
  }
  function retry() {
    const key = settings().saveError?.key;
    if (key) void save(key, global()[key]);
    else if (lastAttempt) void save(lastAttempt.key, lastAttempt.value);
  }
  function Reset(props: {
    setting: SettingKey;
    label: string;
    dirty?: boolean;
    onReset?: () => void;
  }) {
    return (
      <IconButton
        size="sm"
        aria-label={`恢复默认${props.label}`}
        title={`恢复默认${props.label}`}
        data-reset={props.setting}
        disabled={
          !props.dirty &&
          global()[props.setting] === DEFAULT_SETTINGS[props.setting]
        }
        onClick={() => {
          props.onReset?.();
          void save(props.setting, DEFAULT_SETTINGS[props.setting]);
        }}
      >
        <RefreshCw size={14} />
      </IconButton>
    );
  }

  return (
    <>
      <DialogTitle>全局设置</DialogTitle>
      <DialogDescription>
        更改自动保存，作为所有 Vault 的默认设置。
      </DialogDescription>
      <section class="settings-group" aria-labelledby={`${id}-appearance`}>
        <h3 id={`${id}-appearance`}>外观</h3>
        <div class="settings-row">
          <div class="settings-copy">
            <label for={`${id}-theme`}>主题</label>
            <p id={`${id}-theme-help`}>选择配色，或跟随系统。</p>
          </div>
          <div class="settings-control">
            <select
              id={`${id}-theme`}
              class="ui-input settings-select"
              aria-describedby={`${id}-theme-help`}
              value={global()["theme.mode"]}
              onChange={(event) =>
                void save(
                  "theme.mode",
                  event.currentTarget.value as ThemeModeSetting,
                )
              }
            >
              <option value="system">跟随系统</option>
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
            <Reset setting="theme.mode" label="主题" />
          </div>
          <OverrideNotice setting="theme.mode" />
        </div>
        <div class="settings-row">
          <div class="settings-copy">
            <label for={`${id}-width`}>侧栏宽度</label>
            <p id={`${id}-width-help`}>
              {range.min}–{range.max} px，实际宽度受窗口大小限制。
            </p>
          </div>
          <div class="settings-control">
            <input
              id={`${id}-width`}
              type="number"
              class="ui-input settings-number"
              min={range.min}
              max={range.max}
              step={1}
              value={widthDraft()}
              aria-invalid={widthError() ? "true" : "false"}
              aria-describedby={`${id}-width-help${widthError() ? ` ${id}-width-error` : ""}`}
              onInput={(event) => {
                editingWidth = true;
                setWidthDraft(event.currentTarget.value);
                setWidthError(null);
              }}
              onBlur={(event) => {
                if (
                  (event.relatedTarget as HTMLElement | null)?.dataset.reset !==
                  "sidebar.width"
                )
                  commitWidth(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitWidth(event.currentTarget.value);
                }
              }}
            />
            <Reset
              setting="sidebar.width"
              label="侧栏宽度"
              dirty={widthChanged()}
              onReset={() => {
                editingWidth = false;
                setWidthDraft(String(DEFAULT_SETTINGS["sidebar.width"]));
                setWidthError(null);
              }}
            />
          </div>
          <Show when={widthError()}>
            <p
              id={`${id}-width-error`}
              class="settings-validation"
              role="alert"
            >
              {widthError()}
            </p>
          </Show>
          <OverrideNotice setting="sidebar.width" />
        </div>
      </section>
      <section class="settings-group" aria-labelledby={`${id}-editor`}>
        <h3 id={`${id}-editor`}>编辑器</h3>
        <div class="settings-row">
          <div class="settings-copy">
            <label for={`${id}-wrap`}>自动换行</label>
            <p id={`${id}-wrap-help`}>长行随编辑区宽度折行。</p>
          </div>
          <div class="settings-control">
            <input
              id={`${id}-wrap`}
              class="settings-checkbox"
              type="checkbox"
              checked={global()["editor.wordWrap"]}
              aria-describedby={`${id}-wrap-help`}
              onChange={(event) =>
                void save("editor.wordWrap", event.currentTarget.checked)
              }
            />
            <Reset setting="editor.wordWrap" label="自动换行" />
          </div>
          <OverrideNotice setting="editor.wordWrap" />
        </div>
      </section>
      <Show
        when={settings().problems.some((problem) => problem.source === "app")}
      >
        <p class="settings-notice">
          部分全局设置无效，已使用默认值。修改对应选项可修正。
        </p>
      </Show>
      <Show when={error()}>
        <div class="settings-error" role="alert">
          <p>保存失败，修改仍保留在本次会话。{error()}</p>
          <Button size="sm" disabled={pending() > 0} onClick={retry}>
            重试保存
          </Button>
        </div>
      </Show>
      <div class="settings-footer">
        <span role="status" aria-label="设置保存状态" aria-live="polite">
          {pending() > 0
            ? "正在保存…"
            : error()
              ? "保存失败"
              : widthError()
                ? "输入无效，未保存"
                : widthChanged()
                  ? "未保存"
                  : settings().storage === "memory"
                    ? "仅保留在本次会话"
                    : "已保存"}
        </span>
        <span class="text-secondary">↻ 恢复单项默认值</span>
      </div>
    </>
  );
}

export function GlobalSettings() {
  return (
    <Dialog>
      <DialogTrigger
        as={IconButton}
        size="sm"
        aria-label="全局设置"
        title="全局设置"
      >
        <Settings2 size={15} />
      </DialogTrigger>
      <DialogContent class="settings-dialog">
        <SettingsFields />
      </DialogContent>
    </Dialog>
  );
}
