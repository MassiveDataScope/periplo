import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { chainOf } from "./chain";
import { ScheduleCard } from "./ScheduleCard";
import type { Etl, RecentRun } from "./useEtl";

const i18n = await createI18n();

afterEach(cleanup);

const etl: Etl = {
  id: "dep-1",
  name: "facts",
  flow_name: "facts",
  description: null,
  tags: [],
  paused: false,
  schedule: { kind: "cron", cron: "0 23 * * *", interval_seconds: null, timezone: "America/New_York", active: true },
  parameters: {},
  last_run: null,
  recent: [],
  next_run_at: null,
  schedule_inactive: false,
  accepts_processes: false,
  external_url: null,
  triggered_by: null,
  triggers: [],
  archived: null,
};

function renderCard(one: Etl, etls: readonly Etl[] = [one]) {
  render(
    <I18nextProvider i18n={i18n}>
      <ScheduleCard etl={one} chain={chainOf(one, etls)} runs={[]} knownSince={null} now={Date.parse("2026-10-06T12:00:00Z")} />
    </I18nextProvider>,
  );
}

describe("ScheduleCard", () => {
  it("shows a time zone no clock knows as written, and draws nothing it cannot work out from it", () => {
    renderCard({ ...etl, schedule: { kind: "cron", cron: "0 4 * * *", interval_seconds: null, timezone: "Mars/Base", active: true } });
    expect(screen.getByText("Daily at 04:00 (Mars/Base)")).toBeTruthy();
    expect(screen.getByText("time zone not recognised")).toBeTruthy();
    expect(screen.queryByText(/in Madrid/)).toBeNull();
    expect(screen.getAllByRole("listitem").every((day) => day.getAttribute("title")?.endsWith("Not known"))).toBe(true);
  });

  it("does not repeat in small a cron it already shows as written", () => {
    renderCard({ ...etl, schedule: { kind: "cron", cron: "0 4 1,15 * 1", interval_seconds: null, timezone: "UTC", active: true } });
    expect(screen.getAllByText(/0 4 1,15 \* 1/)).toHaveLength(1);
  });

  it("says the time on the team's clock, on the next day when it already is there", () => {
    renderCard(etl);
    expect(screen.getByText("Daily at 23:00 (America/New_York)")).toBeTruthy();
    expect(screen.getByText("05:00 the next day in Madrid")).toBeTruthy();
  });

  it("adds no note for a time zone every clock knows", () => {
    renderCard(etl);
    expect(screen.queryByText("time zone not recognised")).toBeNull();
  });

  it("words an interval, an rrule and an ETL nobody schedules", () => {
    renderCard({ ...etl, schedule: { kind: "interval", cron: null, interval_seconds: 3600, timezone: null, active: true } });
    expect(screen.getByText("every 1h")).toBeTruthy();
    cleanup();
    renderCard({ ...etl, schedule: { kind: "rrule", cron: null, interval_seconds: null, timezone: null, active: true } });
    expect(screen.getByText("On a custom recurrence (rrule)")).toBeTruthy();
    cleanup();
    renderCard({ ...etl, schedule: null });
    expect(screen.getByText("Manual: it runs only when someone starts it")).toBeTruthy();
  });
});

describe("ScheduleCard of a chained ETL", () => {
  const ran = (state: RecentRun["state"]): RecentRun[] => [
    {
      id: `r-${state}`,
      state,
      run_count: 1,
      expected_start_at: null,
      start_at: "2026-10-06T03:00:00Z",
      attempt_started_at: "2026-10-06T03:00:00Z",
      end_at: "2026-10-06T03:09:00Z",
      attempts: null,
    },
  ];
  const daily = { kind: "cron" as const, cron: "0 3 * * *", interval_seconds: null, timezone: "UTC", active: true };
  const messages: Etl = { ...etl, id: "m", name: "messages", schedule: daily, recent: ran("COMPLETED"), triggers: ["nlp"] };
  const nlp: Etl = {
    ...etl,
    id: "n",
    name: "nlp",
    schedule: null,
    recent: ran("FAILED"),
    triggered_by: { etl: "messages", on: "completed", passes: ["updated_at_from"], sets: {} },
    triggers: ["model"],
  };
  const model: Etl = { ...etl, id: "c", name: "model", schedule: null, triggered_by: { etl: "nlp", on: "completed", passes: [], sets: {} } };
  const all = [messages, nlp, model];

  it("says it runs after its upstream completes, with a link to it, never that it runs only by hand", () => {
    renderCard(nlp, all);
    const after = screen.getByText(/^Runs after/);
    expect(after.textContent).toBe("Runs after messages completes");
    expect(within(after).getByRole("link", { name: "messages" }).getAttribute("href")).toBe("#/etl/messages");
    expect(screen.queryByText(/Manual/)).toBeNull();
  });

  it("draws the days ahead by the schedule that paces the chain", () => {
    renderCard(model, all);
    const ahead = screen.getAllByRole("listitem").filter((day) => day.getAttribute("title")?.endsWith("Scheduled"));
    expect(ahead.length).toBeGreaterThan(0);
  });

  it("lays out the whole chain, each link to its page with its last run's state, this one marked", () => {
    renderCard(nlp, all);
    const chain = screen.getByRole("list", { name: "Chain" });
    const links = within(chain).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual(["messages", "nlp", "model"]);
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["#/etl/messages", "#/etl/nlp", "#/etl/model"]);
    expect(links.map((link) => link.getAttribute("aria-current"))).toEqual([null, "page", null]);
    expect(links.map((link) => link.getAttribute("title"))).toEqual(["messages", "nlp", "model"]);
    expect(chain.querySelectorAll("[data-status]")).toHaveLength(2);
    // One item per link, its arrow inside it: a narrow card never starts a line with an arrow.
    const items = within(chain).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(["messages→", "nlp→", "model"]);
  });

  it("says what it starts next only when the chain cannot show it: when it starts several", () => {
    renderCard(nlp, all);
    expect(screen.queryByText(/^Then triggers/)).toBeNull();
    cleanup();
    const report: Etl = { ...etl, id: "r", name: "report", schedule: null, triggered_by: { etl: "nlp", on: "completed", passes: [], sets: {} } };
    const forked: Etl = { ...nlp, triggers: ["model", "report"] };
    renderCard(forked, [messages, forked, model, report]);
    const then = screen.getByText(/^Then triggers/);
    expect(
      within(then)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["#/etl/model", "#/etl/report"]);
  });

  it("draws no chain for an ETL in none", () => {
    renderCard(etl);
    expect(screen.queryByRole("list", { name: "Chain" })).toBeNull();
    expect(screen.queryByText(/^Then triggers/)).toBeNull();
  });
});
