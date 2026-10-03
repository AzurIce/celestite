import { lazy, Loading } from "solid-js";

const Page = lazy(() => import("./VaultWorkspace"));

function App() {
  return (
    <Loading fallback={<main>正在加载…</main>}>
      <Page />
    </Loading>
  );
}

export default App;
