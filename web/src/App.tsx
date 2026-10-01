import { lazy, Loading } from "solid-js";

function App() {
  const UiPreview = lazy(() => import("./UiPreview"));
  return (
    <Loading fallback={<main>加载组件预览…</main>}>
      <UiPreview />
    </Loading>
  );
}

export default App;
