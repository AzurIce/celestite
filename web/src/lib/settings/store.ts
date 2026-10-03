import {
  parseSettingsText,
  resolveSettings,
  withSetting,
  type ParsedDocument,
  type ResolvedSettings,
  type SettingsDocument,
} from "./document";
import { describeInvalidSetting, settingDefinition } from "./schema";
import type { SettingsFile } from "./app-file";
import type { SettingKey, Settings } from "./schema";

export type SettingsStorage = "file" | "memory";

export interface SettingsSnapshot extends ResolvedSettings {
  /** app 文档当前是否已落在磁盘；false 表示写失败，只有内存态。 */
  storage: SettingsStorage;
  /** 最近一次保存失败，供界面提示；成功后被清空。 */
  saveError?: { key: SettingKey; reason: string };
}

export interface SettingsStoreOptions {
  file: SettingsFile;
  /** 首次运行时的旧 localStorage 迁移来源。 */
  migrateLegacy?: () => SettingsDocument | null;
  clearLegacy?: () => void;
}

const emptyDocument = (): ParsedDocument => ({
  values: {},
  document: {},
  problems: [],
});

/** 默认值 < app < project 逐键生效；写只作用到 app 文档。 */
export class SettingsStore {
  private readonly options: SettingsStoreOptions;
  private projectReader?: () => Promise<string | null>;
  private app: ParsedDocument = emptyDocument();
  private project: ParsedDocument = emptyDocument();
  private storage: SettingsStorage = "file";
  private saveError?: { key: SettingKey; reason: string };
  private readonly listeners = new Set<(snapshot: SettingsSnapshot) => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(options: SettingsStoreOptions) {
    this.options = options;
  }

  snapshot(): SettingsSnapshot {
    return {
      ...resolveSettings(this.app, this.project),
      storage: this.storage,
      saveError: this.saveError,
    };
  }

  subscribe(listener: (snapshot: SettingsSnapshot) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 读取 app 文档；文件不存在时尝试一次性迁移旧 localStorage 键。 */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    let text: string | null = null;
    try {
      text = await this.options.file.read();
    } catch (error) {
      this.storage = "memory";
      this.app = {
        values: {},
        document: {},
        problems: [
          {
            key: "",
            source: "app",
            value: undefined,
            reason: `读取设置文件失败：${message(error)}`,
          },
        ],
      };
      this.notify();
      return;
    }
    this.app = parseSettingsText(text, "app");
    if (text === null) await this.migrate();
    this.notify();
  }

  /** vault 打开或切换后调用；读不到项目文件视为没有项目级覆盖。 */
  async reloadProject() {
    if (!this.projectReader) {
      this.project = emptyDocument();
      this.notify();
      return;
    }
    try {
      this.project = parseSettingsText(await this.projectReader(), "project");
    } catch (error) {
      this.project = {
        values: {},
        document: {},
        problems: [
          {
            key: "",
            source: "project",
            value: undefined,
            reason: `读取项目级设置失败，已忽略项目级覆盖：${message(error)}`,
          },
        ],
      };
    }
    this.notify();
  }

  clearProject() {
    this.project = emptyDocument();
    this.notify();
  }

  /** vault 打开后注入项目级文档读取器（`.celestite/settings.json`，只读）。 */
  setProjectReader(read: () => Promise<string | null>) {
    this.projectReader = read;
  }

  /**
   * options.persist=false 只更新内存态（拖动宽度这类高频场景），
   * 磁盘仍是旧文档；之后任意一次持久化写入都会带上这些修改。
   * 持久化失败时内存态保留用户选择，错误记在 saveError。
   */
  async set<K extends SettingKey>(
    key: K,
    value: Settings[K],
    options?: { persist?: boolean },
  ) {
    const invalid = describeInvalidSetting(key, value);
    if (invalid) throw new Error(`设置 ${key} 的值无效：${invalid}`);
    await this.enqueue(async () => {
      const definition = settingDefinition(key);
      const normalized = definition.parse(value, definition.default);
      const document = withSetting(this.app.document, key, normalized);
      this.app = {
        ...this.app,
        values: { ...this.app.values, [key]: normalized } as never,
        document,
      };
      this.storage = "memory";
      this.saveError = undefined;
      this.notify();
      if (options?.persist === false) return;
      try {
        await this.options.file.write(document);
        this.storage = "file";
        this.saveError = undefined;
      } catch (error) {
        // 保留用户选择的内存态；磁盘仍是旧文档，后续成功写入会带上这次修改。
        this.storage = "memory";
        this.saveError = { key, reason: message(error) };
      }
      this.notify();
    });
  }

  private async migrate() {
    if (!this.options.migrateLegacy || !this.options.clearLegacy) return;
    const legacy = this.options.migrateLegacy();
    if (!legacy || !Object.keys(legacy).length) return;
    this.app = {
      ...this.app,
      document: legacy,
      values: parseSettingsText(JSON.stringify(legacy), "app").values,
    };
    this.notify();
    try {
      await this.options.file.write(legacy);
      this.storage = "file";
      this.options.clearLegacy();
    } catch {
      this.storage = "memory";
    }
    this.notify();
  }

  private enqueue(task: () => Promise<void>) {
    this.tail = this.tail.then(task, task);
    return this.tail as Promise<void>;
  }

  private notify() {
    if (!this.listeners.size) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
