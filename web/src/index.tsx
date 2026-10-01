/* @refresh reload */
import { render } from "@solidjs/web";
import "./styles/theme.css";
import "virtual:uno.css";
import "./styles/ui.css";
import App from "./App";
import { initializeTheme } from "./lib/theme";

const cleanupTheme = initializeTheme();
import.meta.hot?.dispose(cleanupTheme);

render(() => <App />, document.getElementById("root") as HTMLElement);
