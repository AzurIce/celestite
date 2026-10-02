import { lazy, Loading } from "solid-js";

function App() {
  const Page =
    import.meta.env.DEV && window.location.pathname === "/ui"
      ? lazy(() => import("./UiPreview"))
      : lazy(() => import("./VaultWorkspace"));
  return (
    <Loading fallback={<main>正在加载…</main>}>
      <Page />
    </Loading>
  );
}

export default App;
