import {
  DEFAULT_SETTINGS,
  describeInvalidSetting,
  isSettingKey,
  settingDefinition,
  type SettingKey,
  type Settings,
} from "./schema";

/** 原始 JSON 文档：扁平点号键 → 未知值。未知键原样保留，回写时不丢。 */
export type SettingsDocument = Record<string, unknown>;
export type SettingSource = "default" | "app" | "project";

export interface SettingsProblem {
  key: string;
  /** 触发问题的层。 */
  source: Exclude<SettingSource, "default">;
  /** 被丢弃的原始值。 */
  value: unknown;
  reason: string;
}

export interface ParsedDocument {
  /** 规范化后的已知键取值。 */
  values: Partial<Settings>;
  /** 完整原始文档（含未知键）。 */
  document: SettingsDocument;
  problems: SettingsProblem[];
}

export interface ResolvedSettings {
  values: Settings;
  source: Record<SettingKey, SettingSource>;
  /** 各层原始文档，仅供写回与调试。 */
  documents: { app: SettingsDocument; project: SettingsDocument };
  problems: SettingsProblem[];
}

/** 逐 key 解析一层文档；坏值回退到下层（或默认值）并记录问题。 */
export function parseDocument(
  raw: unknown,
  source: "app" | "project",
): ParsedDocument {
  const problems: SettingsProblem[] = [];
  if (raw === null || raw === undefined) {
    return { values: {}, document: {}, problems };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      values: {},
      document: {},
      problems: [
        { key: "", source, value: raw, reason: "顶层必须是 JSON 对象" },
      ],
    };
  }

  const values: Record<string, unknown> = {};
  const document: SettingsDocument = {};
  for (const [key, value] of Object.entries(raw as SettingsDocument)) {
    document[key] = value;
    if (!isSettingKey(key)) continue;
    const definition = settingDefinition(key);
    if (source === "project" && definition.projectOverride === false) {
      problems.push({ key, source, value, reason: "此设置仅支持全局配置" });
      continue;
    }
    if (value === undefined) {
      problems.push({ key, source, value, reason: "值缺失" });
      continue;
    }
    const invalid = describeInvalidSetting(key, value);
    if (invalid) {
      problems.push({ key, source, value, reason: invalid });
      continue;
    }
    values[key] = definition.parse(value, definition.default);
  }
  return { values: values as Partial<Settings>, document, problems };
}

/** 反序列化文本；解析失败视为空文档并记录问题，不让坏文件阻止启动。 */
export function parseSettingsText(
  text: string | null,
  source: "app" | "project",
): ParsedDocument {
  if (text === null || text.trim() === "") {
    return { values: {}, document: {}, problems: [] };
  }
  try {
    return parseDocument(JSON.parse(text), source);
  } catch (error) {
    return {
      values: {},
      document: {},
      problems: [
        {
          key: "",
          source,
          value: undefined,
          reason: `不是合法 JSON：${message(error)}`,
        },
      ],
    };
  }
}

/** 按 默认值 < app < project 逐键合并，并记录每个键的来源。 */
export function resolveSettings(
  app: ParsedDocument,
  project: ParsedDocument,
): ResolvedSettings {
  const values: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  const source = Object.fromEntries(
    Object.keys(DEFAULT_SETTINGS).map((key) => [key, "default"]),
  ) as Record<SettingKey, SettingSource>;
  const layers = [
    { parsed: app, source: "app" as const },
    { parsed: project, source: "project" as const },
  ];
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer.parsed.values)) {
      values[key] = value;
      source[key as SettingKey] = layer.source;
    }
  }
  return {
    values: values as Settings,
    source,
    documents: { app: app.document, project: project.document },
    problems: [...app.problems, ...project.problems],
  };
}

/** 把一个键写进已有文档，原样保留未知键与未修改的已知键。 */
export function withSetting<K extends SettingKey>(
  document: SettingsDocument,
  key: K,
  value: Settings[K],
): SettingsDocument {
  return { ...document, [key]: value };
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
