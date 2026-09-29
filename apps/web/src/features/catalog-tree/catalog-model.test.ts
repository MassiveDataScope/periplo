import { describe, expect, it } from "vitest";
import catalogFixture from "../../../dev/fixtures/catalog.before.json";
import { buildExplorerTree, type Catalog } from "./catalog-model";

const catalog = catalogFixture as Catalog;
const shape = (tree: ReturnType<typeof buildExplorerTree>) =>
  tree.groups.map((group) => [group.title, group.tables, group.databases.map((database) => `${database.name}(${database.tables.length})`)]);
const outline = (groups: ReturnType<typeof buildExplorerTree>["groups"]): unknown[] =>
  groups.map((group) => [
    `${group.label}=${group.title || "∅"}`,
    group.tables,
    group.groups.length > 0 ? outline(group.groups) : group.databases.map((database) => database.name),
  ]);

describe("buildExplorerTree", () => {
  it("groups by the configured label, then by database, with counts", () => {
    const tree = buildExplorerTree(catalog, { groupBy: ["layer"], search: "" });

    expect(tree.totalTables).toBe(11);
    expect(shape(tree)).toEqual([
      ["Landing", 6, ["landing_inventory(1)", "landing_shop(3)", "partner_feed(2)"]],
      ["Curated", 3, ["curated_inventory_eu(1)", "curated_shop(2)"]],
      ["experiments", 1, ["experiments_pricing(1)"]],
      ["", 1, ["adhoc(1)"]],
    ]);
  });

  it("orders declared values as configured, undeclared ones after them, and tables without a value last", () => {
    const groups = buildExplorerTree(catalog, {
      groupBy: ["layer"],
      search: "",
    }).groups;

    expect(groups.map((group) => [group.value, group.declared])).toEqual([
      ["landing", true],
      ["curated", true],
      ["experiments", false],
      [null, false],
    ]);
    expect(groups[0]?.description).toBe("Data as received from each system.");
  });

  it("does not flag values as undeclared when the configuration declares none for that label", () => {
    const groups = buildExplorerTree({ ...catalog, label_values: {} }, { groupBy: ["layer"], search: "" }).groups;

    expect(groups.filter((group) => group.value !== null).every((group) => group.declared)).toBe(true);
    expect(groups.map((group) => group.title)).toEqual(["curated", "experiments", "landing", ""]);
  });

  it("treats a fixed source label exactly like a template level", () => {
    const landing = buildExplorerTree(catalog, {
      groupBy: ["layer"],
      search: "",
    }).groups[0];
    expect(landing?.databases.find((database) => database.name === "partner_feed")?.tables.map((table) => table.source)).toEqual([
      "partner_feed",
      "partner_feed",
    ]);
  });

  it("groups by database alone when there is no label to group by", () => {
    const tree = buildExplorerTree(catalog, { groupBy: [], search: "" });

    expect(tree.groups).toHaveLength(1);
    expect(tree.groups[0]).toMatchObject({
      value: null,
      title: "",
      tables: 11,
    });
    expect(tree.groups[0]?.databases.map((database) => database.name)).toEqual([
      "adhoc",
      "curated_inventory_eu",
      "curated_shop",
      "experiments_pricing",
      "landing_inventory",
      "landing_shop",
      "partner_feed",
    ]);
  });

  it("can group by any other label without the model knowing what it means", () => {
    const tree = buildExplorerTree(catalog, {
      groupBy: ["domain"],
      search: "",
    });
    expect(tree.groups.map((group) => [group.title, group.tables])).toEqual([
      ["inventory", 2],
      ["pricing", 1],
      ["shop", 5],
      ["", 3],
    ]);
  });

  it("searches table and database names case-insensitively and drops what does not match", () => {
    expect(shape(buildExplorerTree(catalog, { groupBy: ["layer"], search: "ORDER" }))).toEqual([
      ["Landing", 2, ["landing_shop(2)"]],
      ["Curated", 1, ["curated_shop(1)"]],
    ]);
    expect(shape(buildExplorerTree(catalog, { groupBy: ["layer"], search: "inventory" }))).toEqual([
      ["Landing", 1, ["landing_inventory(1)"]],
      ["Curated", 1, ["curated_inventory_eu(1)"]],
    ]);
    expect(
      shape(
        buildExplorerTree(catalog, {
          groupBy: ["layer"],
          search: "curated_shop.daily",
        }),
      ),
    ).toEqual([["Curated", 1, ["curated_shop(1)"]]]);
    expect(buildExplorerTree(catalog, { groupBy: ["layer"], search: "zzz" })).toMatchObject({ groups: [], totalTables: 0 });
    expect(
      shape(
        buildExplorerTree(catalog, {
          groupBy: ["layer"],
          search: "cur sho sal",
        }),
      ),
    ).toEqual([["Curated", 1, ["curated_shop(1)"]]]);
  });

  it("nests by several labels, outermost first, and keeps databases at the innermost level", () => {
    const tree = buildExplorerTree(catalog, {
      groupBy: ["layer", "zone"],
      search: "",
    });

    expect(outline(tree.groups)).toEqual([
      [
        "layer=Landing",
        6,
        [
          ["zone=Open", 3, ["landing_shop"]],
          ["zone=Restricted", 3, ["landing_inventory", "partner_feed"]],
        ],
      ],
      [
        "layer=Curated",
        3,
        [
          ["zone=Open", 2, ["curated_shop"]],
          ["zone=Restricted", 1, ["curated_inventory_eu"]],
        ],
      ],
      ["layer=experiments", 1, [["zone=∅", 1, ["experiments_pricing"]]]],
      ["layer=∅", 1, [["zone=∅", 1, ["adhoc"]]]],
    ]);
    expect(tree.groups[0]?.groups[1]?.description).toBe("Personal data: access is audited.");
    expect(tree.groups[0]?.databases).toEqual([]);
  });

  it("searches through every nesting level", () => {
    const tree = buildExplorerTree(catalog, {
      groupBy: ["layer", "zone"],
      search: "inventory",
    });
    expect(outline(tree.groups)).toEqual([
      ["layer=Landing", 1, [["zone=Restricted", 1, ["landing_inventory"]]]],
      ["layer=Curated", 1, [["zone=Restricted", 1, ["curated_inventory_eu"]]]],
    ]);
  });

  it("sorts tables inside a database by name", () => {
    const shop = buildExplorerTree(catalog, {
      groupBy: ["layer"],
      search: "",
    }).groups[0]?.databases.find((database) => database.name === "landing_shop");
    expect(shop?.tables.map((table) => table.name)).toEqual(["customers", "order", "orders"]);
  });
});
