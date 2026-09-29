export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "periplo.theme";

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

/** The stored choice, or "system" when there is none or storage is unavailable. */
export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

/** Applies a theme to the document and remembers it; "system" defers to the OS preference. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Private mode or blocked storage: the choice simply lasts for this page.
  }
}

/**
 * Inline this in a `<script>` in `<head>`, before any stylesheet paints, so an
 * explicit choice never flashes the other theme.
 */
export const themeBootstrapSnippet = `try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}`;
