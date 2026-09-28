import { describe, expect, it } from "vitest";
import { metric, resolveLinks } from "./details-model";

const TEMPLATES = [
  {
    label: "Pipeline run",
    key: "example.run_id",
    url_template: "https://orchestrator.example/runs/{value}",
  },
];

describe("resolveLinks", () => {
  it("turns a commit value into a link and encodes it", () => {
    expect(resolveLinks(TEMPLATES, { "example.run_id": "run 7/a" })).toEqual([
      {
        label: "Pipeline run",
        url: "https://orchestrator.example/runs/run%207%2Fa",
      },
    ]);
  });

  it("offers nothing when the commit lacks the key or carries a non-scalar", () => {
    expect(resolveLinks(TEMPLATES, {})).toEqual([]);
    expect(resolveLinks(TEMPLATES, { "example.run_id": { nested: true } })).toEqual([]);
  });

  it("refuses templates that are not plain web links, whatever the configuration says", () => {
    expect(resolveLinks([{ label: "x", key: "k", url_template: "javascript:alert({value})" }], { k: "1" })).toEqual([]);
  });
});

describe("metric", () => {
  it("reads the first metric present, as a number, whichever writer spelled it", () => {
    expect(metric({ num_added_rows: 10 }, ["num_output_rows", "num_added_rows"])).toBe(10);
    expect(metric({ numOutputRows: "42" }, ["numOutputRows"])).toBe(42);
    expect(metric({ other: 1 }, ["num_added_rows"])).toBeUndefined();
    expect(metric({ num_added_rows: "many" }, ["num_added_rows"])).toBeUndefined();
  });
});
