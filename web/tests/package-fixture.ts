export function packageFixture(prefix = "") {
  const encode = (source: string) => new TextEncoder().encode(source);
  const files: [string, Uint8Array][] = [
    [
      "package.not",
      encode(
        '= Package\n\n#import "./packages/demo/lib.notc" as demo;\n\n#demo.card()[\n组件中的正文 😀\n]\n',
      ),
    ],
    [
      "packages/demo/lib.notc",
      encode(
        'fn card(title: String = "默认标题")[children: BlockContent] -> BlockContent;',
      ),
    ],
    ["packages/demo/card/style.js", encode('export const suffix = "相对 JS";')],
    [
      "packages/demo/card/wasm/engine.js",
      encode(`let ready;
export function engine() {
  return ready ??= WebAssembly.instantiateStreaming(fetch(new URL("add.wasm", import.meta.url))).then(result => result.instance.exports.add(20, 22));
}`),
    ],
    [
      "packages/demo/card/wasm/add.wasm",
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1,
        0, 7, 7, 1, 3, 97, 100, 100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106,
        11,
      ]),
    ],
    [
      "packages/demo/card/index.js",
      encode(`import { suffix } from "./style.js";
import { engine } from "./wasm/engine.js";
export default class Card extends HTMLElement {
  static observedAttributes = ["notist-title"];
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.innerHTML = "<style>:host { display:block; padding:12px; border:1px solid currentColor; } strong { display:block; }</style><strong></strong><slot></slot><p></p>";
  }
  connectedCallback() { this.update(); }
  attributeChangedCallback() { if (this.isConnected) this.update(); }
  async update() {
    this.shadowRoot.querySelector("strong").textContent = this.getAttribute("notist-title");
    try {
      const value = await engine();
      if (this.isConnected) this.shadowRoot.querySelector("p").textContent = suffix + " / WASM " + value;
    } catch (error) { this.shadowRoot.querySelector("p").textContent = error.message; }
  }
}`),
    ],
  ];
  return files.map(
    ([path, data]) => [prefix + path, data] as [string, Uint8Array],
  );
}
