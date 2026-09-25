import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import "@periplo/core/ui/fonts.css";
import "@periplo/core/ui/tokens.css";
import { App } from "./app/App";
import { createDependencies } from "./app/dependencies";
import { createPreferences } from "./app/preferences";
import { createI18n } from "./i18n";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

const dependencies = createDependencies({ baseUrl: import.meta.env.VITE_API_BASE_URL ?? "/api/v1" });
const preferences = createPreferences(browserStorage());
const i18n = await createI18n({ language: import.meta.env.VITE_LANGUAGE });

createRoot(root).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <App dependencies={dependencies} preferences={preferences} />
    </I18nextProvider>
  </StrictMode>,
);
