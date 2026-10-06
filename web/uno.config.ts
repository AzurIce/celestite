import { defineConfig, presetWind3, transformerDirectives } from "unocss";

const controlSizes = {
  "control-sm": "var(--height-control-sm)",
  "control-md": "var(--height-control-md)",
};

export default defineConfig({
  presets: [
    presetWind3({
      dark: { dark: '[data-theme="dark"]', light: '[data-theme="light"]' },
    }),
  ],
  transformers: [transformerDirectives()],
  theme: {
    colors: {
      background: "var(--color-background)",
      surface: "var(--color-surface)",
      muted: "var(--color-muted)",
      selected: "var(--color-selected)",
      foreground: "var(--color-foreground)",
      secondary: "var(--color-secondary)",
      border: "var(--color-border)",
      "control-border": "var(--color-control-border)",
      accent: "var(--color-accent)",
      "accent-hover": "var(--color-accent-hover)",
      "accent-foreground": "var(--color-accent-foreground)",
      danger: "var(--color-danger)",
      success: "var(--color-success)",
      warning: "var(--color-warning)",
      focus: "var(--color-focus)",
      overlay: "var(--color-overlay)",
    },
    fontFamily: { ui: "var(--font-ui)" },
    fontSize: {
      ui: ["var(--font-size-ui)", "var(--line-height-ui)"],
      "ui-sm": ["var(--font-size-ui-sm)", "var(--line-height-ui)"],
      "ui-heading": ["var(--font-size-ui-heading)", "var(--line-height-ui)"],
    },
    lineHeight: { ui: "var(--line-height-ui)" },
    height: controlSizes,
    width: controlSizes,
    minHeight: controlSizes,
    borderRadius: {
      ui: "var(--radius-control)",
      control: "var(--radius-control)",
      panel: "var(--radius-panel)",
    },
    boxShadow: { floating: "var(--shadow-floating)" },
    zIndex: {
      overlay: "var(--z-overlay)",
      dialog: "var(--z-dialog)",
      menu: "var(--z-menu)",
      tooltip: "var(--z-tooltip)",
    },
  },
  shortcuts: {
    "ui-surface":
      "border border-solid border-border bg-surface text-foreground",
    "ui-floating": "ui-surface shadow-floating",
    "ui-button":
      "ui-surface border-control-border inline-flex items-center justify-center gap-[6px] h-control-md px-3 py-0 rounded-control text-ui-sm font-medium whitespace-nowrap [transition-property:background-color,border-color,color] duration-120 ease-[ease] hover:bg-muted",
    "ui-icon-button": "w-control-md",
    "ui-dialog-overlay": "fixed inset-0 z-overlay bg-overlay",
    "ui-dialog":
      "ui-floating fixed top-1/2 left-1/2 z-dialog -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-6 rounded-panel",
    "ui-dialog-close": "absolute top-3 right-3",
    "ui-tooltip":
      "ui-floating rounded-control z-tooltip px-2 py-[5px] text-ui-sm",
    "ui-menu":
      "ui-floating rounded-panel z-menu min-w-[180px] overflow-y-auto p-1 text-ui-sm [outline:none]",
    "ui-menu-item":
      "flex items-center gap-2 min-h-control-md px-2 py-1 rounded-[4px] [outline:none] cursor-default select-none",
    "ui-menu-separator": "h-px m-1 border-0 border-none bg-border",
    "ui-text-field": "flex flex-col gap-[6px]",
    "ui-field-label": "text-ui-sm font-medium",
    "ui-field-description": "text-ui-sm text-secondary",
    "ui-field-error": "text-ui-sm text-danger",
    "ui-input":
      "ui-surface border-control-border w-full h-control-md px-[9px] py-0 rounded-control placeholder:text-secondary disabled:opacity-45 disabled:cursor-not-allowed",
  },
});
