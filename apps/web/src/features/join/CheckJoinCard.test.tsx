import { cleanup, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import { createI18n } from "../../i18n";
import { CheckJoinCard } from "./CheckJoinCard";
import type { CheckJoinResult } from "./join-model";

const i18n = await createI18n();

afterEach(cleanup);

function renderCard(result: CheckJoinResult) {
  render(
    <I18nextProvider i18n={i18n}>
      <CheckJoinCard state="done" results={[result]} language="en" onCheck={() => undefined} />
    </I18nextProvider>,
  );
}

const LOOKUP: CheckJoinResult = { alias: "c", matched: 3, leftWithoutMatch: 0, rightWithoutMatch: 0, rowsAfterJoin: 3, factor: 1, relation: "many-to-one" };

describe("CheckJoinCard", () => {
  it("raises one alert for a many-to-many step, not a second one for the factor it explains", () => {
    renderCard({ ...LOOKUP, matched: 5, rowsAfterJoin: 5, factor: 5 / 3, relation: "many-to-many" });
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toContain("The key repeats on both sides, so c multiplies rows");
  });

  it("raises no alert for a lookup that keeps the row count", () => {
    renderCard(LOOKUP);
    expect(screen.queryAllByRole("alert")).toEqual([]);
    expect(screen.getByText(/A lookup: each row finds at most one match/)).toBeTruthy();
  });
});
