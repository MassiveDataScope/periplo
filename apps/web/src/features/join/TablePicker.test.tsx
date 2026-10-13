import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createI18n } from "../../i18n";
import type { Catalog } from "../catalog-tree/catalog-model";
import type { JoinTable } from "./join-model";
import { MAX_STEPS } from "./join-spec";
import { TablePicker } from "./TablePicker";

const i18n = await createI18n();

afterEach(cleanup);

/** Only what the picker reads of a catalog: each table's database and name. */
const CATALOG = {
  tables: [
    { database: "landing_shop", name: "order" },
    { database: "landing_shop", name: "orders" },
    { database: "curated_shop", name: "orders_daily" },
  ],
} as unknown as Catalog;
const ORDER: JoinTable = { database: "landing_shop", table: "order", columns: [] };

type Joined = readonly { readonly alias: string; readonly table: JoinTable }[];

function Harness({ joined = [{ alias: "o", table: ORDER }], onPick }: { readonly joined?: Joined; onPick(database: string, table: string): Promise<boolean> }) {
  const [open, setOpen] = useState(true);
  return (
    <I18nextProvider i18n={i18n}>
      <TablePicker
        catalog={CATALOG}
        joined={joined}
        open={open}
        onOpenChange={setOpen}
        onPick={async (database, table) => {
          const added = await onPick(database, table);
          if (added) setOpen(false);
          return added;
        }}
      />
    </I18nextProvider>
  );
}

const finder = () => screen.queryByLabelText("Find a table to add");

describe("TablePicker", () => {
  it("lists the tables in the join and offers only the others matching the search", () => {
    render(<Harness onPick={() => Promise.resolve(true)} />);
    expect(screen.getByText("order", { selector: "span" })).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    fireEvent.change(finder()!, { target: { value: "shop order" } });
    const offered = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(offered).toEqual(["landing_shop.orders", "curated_shop.orders_daily"]);
  });

  it("puts the finder away on Esc and brings it back from the add button it is controlled by", () => {
    render(<Harness onPick={() => Promise.resolve(true)} />);
    fireEvent.change(finder()!, { target: { value: "orders" } });
    fireEvent.keyDown(finder()!, { key: "Escape" });
    expect(finder()).toBeNull();
    const add = screen.getByRole("button", { name: "Add table" });
    expect(add.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(add);
    expect(add.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(add.getAttribute("aria-controls")!)?.contains(finder())).toBe(true);
    expect((finder() as HTMLInputElement).value).toBe("");
  });

  it("says when the picked table could not be read, and keeps the finder open", async () => {
    const onPick = vi.fn(() => Promise.resolve(false));
    render(<Harness onPick={onPick} />);
    fireEvent.change(finder()!, { target: { value: "shop orders" } });
    fireEvent.click(screen.getByRole("button", { name: /landing_shop\.orders$/ }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(onPick).toHaveBeenCalledWith("landing_shop", "orders");
    expect(finder()).not.toBeNull();
  });

  it("clears the search once a table is added", async () => {
    render(<Harness onPick={() => Promise.resolve(true)} />);
    fireEvent.change(finder()!, { target: { value: "shop orders" } });
    fireEvent.click(screen.getByRole("button", { name: /landing_shop\.orders$/ }));
    await waitFor(() => expect(finder()).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Add table" }));
    expect((finder() as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("stops offering tables once the join holds the most a link can carry", () => {
    const joined = Array.from({ length: MAX_STEPS + 1 }, (_, index) => ({ alias: `t${index}`, table: { ...ORDER, table: `t${index}` } }));
    render(<Harness joined={joined} onPick={() => Promise.resolve(true)} />);
    const add = screen.getByRole("button", { name: "Add table" });
    expect(add).toHaveProperty("disabled", true);
    expect(add.getAttribute("aria-expanded")).toBe("false");
    expect(add.getAttribute("title")).toBe(`A join holds at most ${MAX_STEPS} tables besides this one.`);
    expect(finder()).toBeNull();
  });
});
