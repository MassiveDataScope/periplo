import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import { parseRoute } from "../../app/routes";
import { createI18n } from "../../i18n";
import { EtlCrumbs } from "./EtlCrumbs";
import { SectionLinks } from "./SectionLinks";

const i18n = await createI18n();

afterEach(cleanup);

function renderCrumbs(props: Parameters<typeof EtlCrumbs>[0]) {
  render(
    <I18nextProvider i18n={i18n}>
      <SectionLinks route={parseRoute(window.location.hash)}>
        <EtlCrumbs {...props} />
      </SectionLinks>
    </I18nextProvider>,
  );
  return within(screen.getByRole("navigation", { name: "Breadcrumb" }));
}

describe("EtlCrumbs", () => {
  it("leads from the ETLs to the ETL on screen, which is the current page", () => {
    const crumbs = renderCrumbs({ etl: "customer_facts" });
    expect(crumbs.getByRole("link", { name: "ETLs" }).getAttribute("href")).toBe("#/etl");
    expect(crumbs.queryByRole("link", { name: "customer_facts" })).toBeNull();
    expect(crumbs.getByText("customer_facts").getAttribute("aria-current")).toBe("page");
  });

  it("leads on to a run, its ETL a link that comes back with that run marked", () => {
    const crumbs = renderCrumbs({ etl: "customer_facts", run: { id: "run-7", name: "dapper-heron" } });
    expect(crumbs.getByRole("link", { name: "customer_facts" }).getAttribute("href")).toBe("#/etl/customer_facts?run=run-7");
    expect(crumbs.getByText("dapper-heron").getAttribute("aria-current")).toBe("page");
  });

  it("keeps every crumb, whatever the names: an ETL or a run may be called like the section", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const crumbs = renderCrumbs({ etl: "ETLs", run: { id: "r", name: "ETLs" } });
    expect(crumbs.getAllByText("ETLs")).toHaveLength(3);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("keeps the side list's filter on every crumb, as every link within the section does", () => {
    window.location.hash = "#/etl/runs/run-7?q=facts";
    const crumbs = renderCrumbs({ etl: "customer_facts", run: { id: "run-7", name: "dapper-heron" } });
    expect(crumbs.getByRole("link", { name: "ETLs" }).getAttribute("href")).toBe("#/etl?q=facts");
    expect(crumbs.getByRole("link", { name: "customer_facts" }).getAttribute("href")).toBe("#/etl/customer_facts?run=run-7&q=facts");
    window.location.hash = "";
  });
});
