import { registerComponents } from "../generated/notist_html_runtime";
import type { PreviewAssets, PreviewComponent } from "./contract";
import { assetDigest } from "./asset-digest";

const scope = crypto.randomUUID();
const snapshots = new Map<string, Map<string, Uint8Array>>();
const registered = new Map<string, string>();
let ready: Promise<void> | undefined;
let bytes = 0;
const MAX_BYTES = 64 * 1024 * 1024;

function modulePath(path: string) {
  return path.startsWith("/") ? `packages${path}` : `vault/${path}`;
}

function mediaType(path: string) {
  if (/\.(m?js)$/i.test(path)) return "text/javascript; charset=utf-8";
  if (/\.wasm$/i.test(path)) return "application/wasm";
  if (/\.css$/i.test(path)) return "text/css; charset=utf-8";
  if (/\.json$/i.test(path)) return "application/json";
  if (/\.svg$/i.test(path)) return "image/svg+xml";
  if (/\.png$/i.test(path)) return "image/png";
  if (/\.jpe?g$/i.test(path)) return "image/jpeg";
  if (/\.woff2$/i.test(path)) return "font/woff2";
  return "application/octet-stream";
}

async function initialize() {
  if (!("serviceWorker" in navigator))
    throw new Error("当前环境无法加载 package 组件资源。");
  navigator.serviceWorker.addEventListener("message", (event) => {
    const message = event.data;
    if (message?.kind !== "preview-resource" || !event.ports[0]) return;
    const data =
      message.scope === scope
        ? snapshots.get(message.digest)?.get(message.path)
        : undefined;
    event.ports[0].postMessage(
      data ? { data, type: mediaType(message.path) } : null,
    );
  });
  await navigator.serviceWorker.register(
    `${import.meta.env.BASE_URL}preview-resources.js`,
    { scope: import.meta.env.BASE_URL },
  );
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          controlled,
        );
        reject(new Error("组件资源服务启动超时，请重试。"));
      }, 10000);
      function controlled() {
        if (!navigator.serviceWorker.controller) return;
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          controlled,
        );
        resolve();
      }
      navigator.serviceWorker.addEventListener("controllerchange", controlled);
      controlled();
    });
  }
}

/** ESM constructors and their relative assets live for this page's lifetime. */
export async function loadComponents(
  components: PreviewComponent[],
  assets: PreviewAssets,
) {
  if (!components.length) return;
  await (ready ??= initialize().catch((error) => {
    ready = undefined;
    throw error;
  }));
  const bundles = new Map<
    string,
    { digest: string; files: PreviewAssets["files"] }
  >();
  for (const packageRoot of new Set(
    components.map((component) => component.packageRoot),
  )) {
    const prefix = packageRoot ? `${packageRoot}/components/` : "components/";
    const files = assets.files.filter((file) => file.path.startsWith(prefix));
    bundles.set(packageRoot, { digest: await assetDigest(files), files });
  }
  for (const component of components) {
    const digest = bundles.get(component.packageRoot)!.digest;
    const previous = registered.get(component.tag);
    if (previous && previous !== digest)
      throw new Error("组件代码已变化，请刷新页面以加载新实现。");
  }
  for (const { digest, files } of bundles.values())
    if (!snapshots.has(digest)) {
      const size = files.reduce(
        (total, file) => total + file.data.byteLength,
        0,
      );
      if (bytes + size > MAX_BYTES)
        throw new Error("组件资源超过缓存容量，请刷新页面。");
      snapshots.set(
        digest,
        new Map(files.map((file) => [modulePath(file.path), file.data])),
      );
      bytes += size;
    }
  // Reserve identity before import so simultaneous views share the same module URL.
  for (const component of components)
    registered.set(component.tag, bundles.get(component.packageRoot)!.digest);
  await registerComponents(
    components.map((component) => ({
      tag: component.tag,
      module: new URL(
        modulePath(component.path).split("/").map(encodeURIComponent).join("/"),
        new URL(
          `${import.meta.env.BASE_URL}__preview_resources/${scope}/${bundles.get(component.packageRoot)!.digest}/`,
          location.href,
        ),
      ).href,
    })),
  );
}
