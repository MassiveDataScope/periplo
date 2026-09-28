/**
 * Who runs this installation. Periplo stays the product; the company that deploys it names its
 * workspace at build time: VITE_BRAND_NAME and, optionally, VITE_BRAND_LOGO_URL.
 */
export interface Brand {
  readonly name: string | null;
  readonly logoUrl: string | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

export const BRAND: Brand = { name: text(import.meta.env.VITE_BRAND_NAME), logoUrl: text(import.meta.env.VITE_BRAND_LOGO_URL) };
