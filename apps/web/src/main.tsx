import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import "@periplo/core/ui/fonts.css";
import "@periplo/core/ui/tokens.css";
import { App } from "./app/App";
import { createDependencies } from "./app/dependencies";
import { appHistory } from "./app/history";
import { createPreferences } from "./app/preferences";
import { reloadOnStaleChunk } from "./app/stale-chunks";
import { createI18n } from "./i18n";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

/** The browser's storage of that kind, or undefined where the browser denies it (reading it throws). */
function browserStorage(kind: "localStorage" | "sessionStorage"): Storage | undefined {
  try {
    return window[kind];
  } catch {
    return undefined;
  }
}

// After a deploy the open page may name chunks that are gone: one reload fetches the new ones.
reloadOnStaleChunk({ target: window, storage: browserStorage("sessionStorage"), reload: () => window.location.reload(), now: Date.now });

// The trail follows the browser from the first entry, before any view reads it or listens to a hashchange.
appHistory.install();

const dependencies = createDependencies({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? "/api/v1" });
const preferences = createPreferences(browserStorage("localStorage"));
const i18n = await createI18n({ language: import.meta.env.VITE_LANGUAGE });

createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <App dependencies={dependencies} preferences={preferences} />
    </I18nextProvider>
  </StrictMode>,
);
