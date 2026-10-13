import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { href, type Route } from "../../app/routes";
import { SectionLinks, useInSection } from "./SectionLinks";

const inSectionOf = (route: Route) =>
  renderHook(() => useInSection(), { wrapper: ({ children }: { readonly children: ReactNode }) => <SectionLinks route={route}>{children}</SectionLinks> })
    .result.current;

describe("SectionLinks", () => {
  it("carries the section route's side-list filter into any link within the ETL section, and leaves other links alone", () => {
    const inSection = inSectionOf({ kind: "etl-deployment", name: "facts", q: "stock" });
    expect(href(inSection({ kind: "etl-run", id: "r" }))).toBe("#/etl/runs/r?q=stock");
    expect(href(inSection({ kind: "etl" }))).toBe("#/etl?q=stock");
    expect(inSection({ kind: "sql" })).toEqual({ kind: "sql" });
  });

  it("takes a link as it is outside the section's views", () => {
    const { result } = renderHook(() => useInSection());
    expect(href(result.current({ kind: "etl-run", id: "r" }))).toBe("#/etl/runs/r");
  });
});
