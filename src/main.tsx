// first: the keys the modules below read move to t-rex's names before any of them reads one
import "./lib/storageRename.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// the faces the tokens name, then styles.css before any component: it holds the primitives
// (.btn, .input, .menu…) that component stylesheets override, and Vite emits CSS in import order
import "./fonts/fonts.css";
import "./styles.css";
import { App } from "./App.tsx";
import { AppCrash, CrashProbe } from "./components/AppCrash.tsx";
import { RenderBoundary } from "./components/RenderBoundary.tsx";
import { SettingsProvider } from "./lib/settings.ts";
import { isReportableWindowError } from "./lib/uncaughtErrors.ts";
import "./lib/viewport.ts";
import { watchSheetExits } from "./lib/sheets.ts";
import { warmTerminal } from "./lib/restty/session.ts";

// a phone's sheets drop back down however they close (lib/sheets.ts)
watchSheetExits();
// the terminal's WASM core, fonts and GPU device load while the app finds its first pane
warmTerminal();

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

// an error nothing else caught still reaches the console under one name, where a bug report can find it
// (but not the browser's benign ResizeObserver loop notice: lib/uncaughtErrors.ts)
window.addEventListener("error", (event) => {
  if (isReportableWindowError(event.error, event.message)) console.error("T-Rex: uncaught error", event.error ?? event.message);
});
window.addEventListener("unhandledrejection", (event) => console.error("T-Rex: unhandled rejection", event.reason));

// A render error the parts below do not catch would unmount the whole tree and leave the page
// blank, and an installed web app has no reload button: AppCrash offers one. It sits outside
// SettingsProvider, which may be what threw.
createRoot(container).render(
  <StrictMode>
    <RenderBoundary resetKey={null} fallback={(_retry, error) => <AppCrash error={error} />}>
      <CrashProbe region="root" />
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </RenderBoundary>
  </StrictMode>,
);
