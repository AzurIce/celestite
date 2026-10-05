import type { Extension } from "@codemirror/state";

export function languageName(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "md" || extension === "markdown") return "Markdown";
  if (extension === "nmd" || extension === "notmd") return "Notist Markdown";
  if (extension === "not") return "Notist";
  if (extension === "notc") return "Notist Code";
  if (extension === "ts" || extension === "tsx") return "TypeScript";
  if (["js", "jsx", "mjs", "cjs"].includes(extension ?? ""))
    return "JavaScript";
  if (extension === "json" || extension === "jsonc") return "JSON";
  if (extension === "css") return "CSS";
  if (extension === "html" || extension === "htm") return "HTML";
  return "纯文本";
}
export async function languageSupport(
  path: string,
  onError?: () => void,
): Promise<Extension> {
  const extension = path.split(".").pop()?.toLowerCase();
  switch (languageName(path)) {
    case "Markdown":
    case "Notist Markdown":
    case "Notist":
    case "Notist Code":
      return (await import("./tree-sitter")).treeSitterHighlight(
        extension === "not"
          ? "notist"
          : extension === "notc"
            ? "notist_code"
            : "notist_markdown",
        onError,
      );
    case "TypeScript":
      return (await import("@codemirror/lang-javascript")).javascript({
        typescript: true,
        jsx: extension === "tsx",
      });
    case "JavaScript":
      return (await import("@codemirror/lang-javascript")).javascript({
        jsx: extension === "jsx",
      });
    case "JSON":
      return (await import("@codemirror/lang-json")).json();
    case "CSS":
      return (await import("@codemirror/lang-css")).css();
    case "HTML":
      return (await import("@codemirror/lang-html")).html();
    default:
      return [];
  }
}
