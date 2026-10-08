import { describe, expect, it } from "vitest";
import { GROUP_BY_NEEDS } from "../../app/etl-routes";
import {
  deriveFacets,
  expectsSchedule,
  humanised,
  LABELS_FACET,
  lineageOf,
  resolveGroupBy,
  scheduleFacetValue,
  tagFacet,
  valueOf,
  type FacetConfigs,
} from "./facets";
import type { Etl } from "./useEtl";

function etl(name: string, tags: readonly string[]): Etl {
  return {
    id: name,
    name,
    flow_name: name,
    description: null,
    tags: [...tags],
    paused: false,
    schedule: null,
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
}

// Prefixes no installation in particular uses: the model must not know any of them.
const etls = [
  etl("alpha", ["owner:ana", "system:crm", "writes:market", "nightly", "alpha"]),
  etl("beta", ["owner:bo", "system:ledger", "writes:market", "nightly"]),
  etl("gamma", ["owner:ana", "system:crm", "tier:gold", "beta-test"]),
  etl("delta", ["owner:cy", "tier:gold"]),
];
const NONE: FacetConfigs = {};
const keys = (facets: ReturnType<typeof deriveFacets>) => facets.map((facet) => facet.key);

describe("tagFacet", () => {
  it("splits a tag at its first colon, and puts a tag without one in the Labels facet", () => {
    expect(tagFacet("system:db:main")).toEqual({ key: "system", value: "db:main" });
    expect(tagFacet("nightly")).toEqual({ key: LABELS_FACET, value: "nightly" });
    expect(tagFacet(":odd")).toEqual({ key: LABELS_FACET, value: ":odd" });
  });
});

describe("humanised", () => {
  it("names a prefix as a person would read it", () => {
    expect(humanised("source")).toBe("Source");
    expect(humanised("data_owner")).toBe("Data owner");
    expect(humanised("cost-centre")).toBe("Cost centre");
  });
});

describe("deriveFacets", () => {
  it("forms a facet per prefix with two values or more, ordered by how many ETLs carry it, then name", () => {
    // owner: 4 ETLs, 3 values; system: 3 ETLs; Labels: 3 ETLs (nightly, beta-test); writes: one value; tier: one value.
    expect(keys(deriveFacets(etls, NONE, []))).toEqual(["owner", LABELS_FACET, "system"]);
  });

  it("ignores a tag equal to the ETL's own name", () => {
    const labels = deriveFacets(etls, NONE, []).find((facet) => facet.key === LABELS_FACET);
    expect(labels?.values.map((value) => value.value)).toEqual(["beta-test", "nightly"]);
  });

  it("keeps a facet with one value while it is filtered by", () => {
    expect(keys(deriveFacets(etls, NONE, ["tier:gold"]))).toContain("tier");
  });

  it("takes the installation's labels, order and hidden facets, and humanises the rest", () => {
    const configs: FacetConfigs = {
      system: { label: "Source system", order: 1, hidden: false, role: "reads", values: null },
      owner: { label: null, order: null, hidden: true, role: null, values: null },
    };
    const facets = deriveFacets(etls, configs, []);
    expect(facets.map((facet) => [facet.key, facet.label])).toEqual([
      ["system", "Source system"],
      [LABELS_FACET, null],
    ]);
    expect(deriveFacets(etls, NONE, []).find((facet) => facet.key === "owner")?.label).toBe("Owner");
  });

  it("counts every value's ETLs", () => {
    const owner = deriveFacets(etls, NONE, []).find((facet) => facet.key === "owner");
    expect(owner?.values.map((value) => [value.tag, value.etls])).toEqual([
      ["owner:ana", 2],
      ["owner:bo", 1],
      ["owner:cy", 1],
    ]);
  });
});

describe("valueOf", () => {
  it("is an ETL's first value of a facet, or null", () => {
    expect(valueOf(etls[0]!, "owner")).toBe("ana");
    expect(valueOf(etls[3]!, "system")).toBeNull();
  });
});

describe("lineageOf", () => {
  it("says what an ETL reads and writes only where the installation declares those roles", () => {
    const configs: FacetConfigs = {
      system: { label: null, order: null, hidden: false, role: "reads", values: null },
      writes: { label: null, order: null, hidden: false, role: "writes", values: null },
    };
    expect(lineageOf(etls[0]!, configs)).toEqual({ reads: ["crm"], writes: ["market"] });
    expect(lineageOf(etls[0]!, NONE)).toBeNull();
  });

  it("is none where the installation's only role is not lineage", () => {
    expect(lineageOf(etls[0]!, { tier: { label: null, order: null, hidden: false, role: "expects_schedule", values: ["gold"] } })).toBeNull();
  });
});

describe("expectsSchedule", () => {
  const goldIsScheduled: FacetConfigs = { tier: { label: null, order: null, hidden: false, role: "expects_schedule", values: ["gold"] } };

  it("is what the installation says: an ETL carrying one of the values its expects_schedule facet lists", () => {
    expect(expectsSchedule(etls[2]!, goldIsScheduled)).toBe(true);
    expect(expectsSchedule(etl("silver", ["tier:silver"]), goldIsScheduled)).toBe(false);
    expect(expectsSchedule(etl("untiered", ["owner:ana"]), goldIsScheduled)).toBe(false);
  });

  it("is never, with no configuration, whatever the tags say", () => {
    expect(expectsSchedule(etl("daily", ["cadence:daily", "mode:backfill", "tier:gold"]), NONE)).toBe(false);
  });

  it("matches a value only under its own prefix", () => {
    expect(expectsSchedule(etl("elsewhere", ["owner:gold", "gold"]), goldIsScheduled)).toBe(false);
  });
});

describe("scheduleFacetValue", () => {
  const runs: FacetConfigs = { every: { label: "Runs", order: null, hidden: false, role: "expects_schedule", values: ["day"] } };

  it("is the ETL's value of the facet the installation gives the expects_schedule role, listed or not", () => {
    expect(scheduleFacetValue(etl("a", ["owner:ana", "every:day"]), runs)).toBe("day");
    expect(scheduleFacetValue(etl("b", ["every:week"]), runs)).toBe("week");
    expect(scheduleFacetValue(etl("c", ["owner:ana"]), runs)).toBeNull();
  });

  it("is none with no configuration, or where the installation hides that facet", () => {
    expect(scheduleFacetValue(etl("a", ["every:day"]), NONE)).toBeNull();
    expect(scheduleFacetValue(etl("a", ["every:day"]), { every: { ...runs.every!, hidden: true } })).toBeNull();
  });
});

describe("resolveGroupBy", () => {
  const facets = deriveFacets(etls, NONE, []);

  it("groups by a facet the URL names when it is one on offer, else by what needs attention", () => {
    expect(resolveGroupBy("owner", facets)).toBe("owner");
    expect(resolveGroupBy("team", facets)).toBe(GROUP_BY_NEEDS);
    expect(resolveGroupBy(undefined, facets)).toBe(GROUP_BY_NEEDS);
    expect(resolveGroupBy(LABELS_FACET, facets)).toBe(GROUP_BY_NEEDS);
  });

  it("groups by a prefix named needs where there is one, and an old ?group=needs link by what needs attention where not", () => {
    const withNeeds = deriveFacets([etl("a", ["needs:review"]), etl("b", ["needs:sign-off"])], NONE, []);
    expect(resolveGroupBy("needs", withNeeds)).toBe("needs");
    expect(resolveGroupBy("needs", facets)).toBe(GROUP_BY_NEEDS);
  });
});
