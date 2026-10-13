import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../i18n";
import { ScheduleDays } from "./ScheduleDays";

const i18n = await createI18n();

afterEach(cleanup);

describe("ScheduleDays", () => {
  it("says each day's date and outcome in words, ahead of today about the schedule rather than a run", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <ScheduleDays
          days={[
            { key: "2026-10-05", when: "past", outcome: "failed", ahead: false },
            { key: "2026-10-04", when: "past", outcome: "none", ahead: false },
            { key: "2026-10-06", when: "today", outcome: "stopped", ahead: true },
            { key: "2026-10-07", when: "future", outcome: "none", ahead: true },
            { key: "2026-10-08", when: "today", outcome: "none", ahead: false },
          ]}
        />
      </I18nextProvider>,
    );
    const days = within(screen.getByRole("list", { name: "Last 7 days and next 7" })).getAllByRole("listitem");
    expect(days.map((day) => day.getAttribute("title"))).toEqual([
      "Mon, Oct 5: Failed",
      "Sun, Oct 4: No run",
      "Tue, Oct 6 (today): Would run, but the schedule is paused",
      "Wed, Oct 7: Nothing scheduled",
      "Thu, Oct 8 (today): No run",
    ]);
    expect(days[2]?.getAttribute("aria-current")).toBe("date");
  });
});
