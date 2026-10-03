/** 设置键定义：默认值 + 运行时解析。未知键一律保留，坏值逐键回退。 */

export interface SettingDefinition<T> {
  /** 默认值；故意不推断成字面量类型，方便消费端读写普通值。 */
  default: T;
  /** 可选取值；用于报错信息与将来的设置面板。 */
  choices?: readonly T[];
  /** 数值范围，越界时夹取。 */
  range?: { min: number; max: number };
  /** 返回规范化后的值；无法解析时返回 fallback。 */
  parse: (value: unknown, fallback: T) => T;
  describe: string;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseChoice<T extends string>(choices: readonly T[]) {
  return (value: unknown, fallback: T): T =>
    typeof value === "string" && (choices as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
}

function parseInteger(range: { min: number; max: number }) {
  return (value: unknown, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value)
      ? clampNumber(value, range.min, range.max)
      : fallback;
}

function parseBoolean() {
  return (value: unknown, fallback: boolean): boolean =>
    typeof value === "boolean" ? value : fallback;
}

const themeModes = ["system", "light", "dark"] as const;
export type ThemeModeSetting = (typeof themeModes)[number];

const themeEntry: SettingDefinition<ThemeModeSetting> = {
  default: "system" as ThemeModeSetting,
  choices: themeModes,
  parse: parseChoice(themeModes),
  describe: "浅色 / 深色 / 跟随系统",
};

const sidebarRange = { min: 200, max: 560 };
const sidebarEntry: SettingDefinition<number> = {
  default: 300 as number,
  range: sidebarRange,
  parse: parseInteger(sidebarRange),
  describe: "侧边栏宽度（像素）",
};

const wrapEntry: SettingDefinition<boolean> = {
  default: false as boolean,
  parse: parseBoolean(),
  describe: "编辑器自动换行",
};

export const SETTINGS_SCHEMA = {
  "theme.mode": themeEntry,
  "sidebar.width": sidebarEntry,
  "editor.wordWrap": wrapEntry,
};

export type SettingKey = keyof typeof SETTINGS_SCHEMA;
export type Settings = {
  [K in SettingKey]: (typeof SETTINGS_SCHEMA)[K]["default"];
};

export const DEFAULT_SETTINGS: Settings = {
  "theme.mode": themeEntry.default,
  "sidebar.width": sidebarEntry.default,
  "editor.wordWrap": wrapEntry.default,
};

/**
 * 按单个键取出定义。schema 是不同类型定义的联合，
 * 这里一次性收窄成该键自己的定义，调用点就不必到处 as never。
 */
export function settingDefinition<K extends SettingKey>(key: K) {
  return SETTINGS_SCHEMA[key] as unknown as SettingDefinition<Settings[K]>;
}

export function isSettingKey(key: string): key is SettingKey {
  return Object.keys(SETTINGS_SCHEMA).includes(key);
}

/** 单个值是否可被 schema 接受；null 表示合法，否则返回原因。 */
export function describeInvalidSetting(key: SettingKey, value: unknown) {
  const definition = settingDefinition(key);
  if (definition.choices) {
    return definition.choices.includes(value as never)
      ? null
      : `必须是 ${definition.choices.join(" / ")} 之一`;
  }
  if (definition.range) {
    return typeof value === "number" && Number.isFinite(value)
      ? null
      : "必须是数字";
  }
  return typeof value === typeof definition.default ? null : "类型不匹配";
}
