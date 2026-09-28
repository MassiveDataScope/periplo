import { createInstance, type i18n, type ParseKeys, type ResourceLanguage } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./en.json";

export const FALLBACK_LANGUAGE = "en";

/** A key of the catalog, for maps from a domain value to its label: `t(LABELS[value])` stays typed where `t(\`prefix.${value}\`)` would not. */
export type TranslationKey = ParseKeys;

type Catalog = Record<string, unknown>;

export interface I18nOptions {
  /** Deployment language. Anything without a catalog, or missing from it, falls back to English. */
  readonly language?: string;
  /** Catalogs beyond the English one that ships. Adding a language is adding one of these. */
  readonly extraCatalogs?: Readonly<Record<string, Catalog>>;
}

/** Every visible string comes from a catalog; English is the source of the key types. */
export async function createI18n(options: I18nOptions = {}): Promise<i18n> {
  const instance = createInstance();
  const resources: Record<string, ResourceLanguage> = { [FALLBACK_LANGUAGE]: { translation: en } };
  for (const [language, catalog] of Object.entries(options.extraCatalogs ?? {})) {
    resources[language] = { translation: catalog as ResourceLanguage[string] };
  }
  await instance.use(initReactI18next).init({
    lng: options.language ?? FALLBACK_LANGUAGE,
    fallbackLng: FALLBACK_LANGUAGE,
    resources,
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  return instance;
}

function leafKeys(catalog: Catalog, prefix = ""): string[] {
  return Object.entries(catalog).flatMap(([key, value]) =>
    typeof value === "object" && value !== null ? leafKeys(value as Catalog, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

/** Keys of the reference catalog that another one lacks; those strings would show in English. */
export function missingKeys(reference: Catalog, other: Catalog): string[] {
  const present = new Set(leafKeys(other));
  return leafKeys(reference).filter((key) => !present.has(key));
}
