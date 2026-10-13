import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import catalogFixture from "../../dev/fixtures/catalog.before.json";
import sourcesFixture from "../../dev/fixtures/sources.json";
import { App } from "./App";
import { createDependencies } from "./dependencies";
import { appHistory } from "./history";
import { createPreferences } from "./preferences";
import { createI18n } from "../i18n";

// Its own file: the module registry starts empty, so "loaded" means this file's console asked for the module.
const loaded = vi.hoisted(() => ({ etlViews: false }));
vi.mock("../features/etl/EtlViews", async (original) => {
  loaded.etlViews = true;
  return original();
});

const routes: Record<string, () => Response> = {
  "GET /api/v1/catalog": () => Response.json(catalogFixture),
  "GET /api/v1/sources": () => Response.json({ ...sourcesFixture, discovery: { state: "idle", started_at: null } }),
  "GET /api/v1/etl/status": () => Response.json({ configured: true, operate_enabled: false, ui_url: null, facets: {} }),
  "GET /api/v1/etl": () =>
    Response.json({
      etls: [],
      summary: {
        running: 0,
        failed_24h: 0,
        completed_24h: 0,
        history: { interval: "1h", buckets: [], upcoming: [], median_seconds: null },
        history_7d: { interval: "1d", buckets: [], upcoming: [], median_seconds: null },
      },
      running: [],
      running_truncated: false,
    }),
};

const fetchStub: typeof fetch = async (input) => {
  const request = input as Request;
  const route = routes[`${request.method} ${new URL(request.url).pathname}`];
  if (!route) return new Response(null, { status: 404 });
  return route();
};

const i18n = await createI18n();

beforeEach(() => {
  appHistory.dispose();
  window.history.replaceState(null, "", window.location.pathname);
  appHistory.install();
});
afterEach(() => {
  cleanup();
  appHistory.dispose();
});

describe("App's ETL section", () => {
  it("loads the ETL views only once an ETL route is on screen", async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <App dependencies={createDependencies({ baseUrl: "http://periplo.test/api/v1", fetch: fetchStub })} preferences={createPreferences(undefined)} />
      </I18nextProvider>,
    );
    await screen.findByRole("tree", { name: "Tables" });
    await screen.findByRole("link", { name: "ETL" });
    expect(loaded.etlViews).toBe(false);

    act(() => {
      window.location.hash = "#/etl";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    await screen.findByRole("heading", { name: "ETL", level: 2 });
    expect(loaded.etlViews).toBe(true);
  });
});
