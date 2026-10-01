import { lazy } from "solid-js";

function App() {
  if (import.meta.env.DEV && window.location.pathname === "/ui") {
    const UiPreview = lazy(() => import("./UiPreview"));
    return <UiPreview />;
  }
  return <main />;
}

export default App;
