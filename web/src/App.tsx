import { lazy, Loading } from "solid-js";

const Page = lazy(() =>
  window.location.pathname.replace(/\/+$/, "") ===
  `${import.meta.env.BASE_URL}debug/sync`
    ? import("./debug/SyncDebug")
    : import("./VaultWorkspace"),
);

function App() {
  return (
    <Loading fallback={<main>正在加载…</main>}>
      <Page />
    </Loading>
  );
}

export default App;
