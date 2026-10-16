import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { createI18n } from "../../../../src/i18n";
import { FacetListbox, type FacetOption } from "../../../../src/features/etl/FacetListbox";

const i18n = await createI18n();

afterEach(cleanup);

const options: FacetOption[] = ["a1", "a2", "a3", "a4", "a5", "a6", "a7", "b1", "b2", "b3"].map((text) => ({ id: text, text, count: 1 }));

describe("FacetListbox", () => {
  it("moves from the value it shows as active, after a search left fewer values than the one moved to", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <FacetListbox label="Site" options={options} selected={[]} onChange={() => {}} />
      </I18nextProvider>,
    );
    const list = screen.getByRole("listbox", { name: "Site" });
    // Each option reads its value then its count ("b3" then "1").
    const active = () => document.getElementById(list.getAttribute("aria-activedescendant") ?? "")?.textContent?.slice(0, -1);
    fireEvent.keyDown(list, { key: "End" });
    expect(active()).toBe("b3");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search Site" }), { target: { value: "a" } });
    expect(active()).toBe("a7");
    fireEvent.keyDown(list, { key: "ArrowUp" });
    expect(active()).toBe("a6");
  });
});
