import { describe, expect, it } from "vitest";
import { chainOf, downstreamSettlesAt, isScheduled, runDownstream } from "./chain";
import { MISSED_AFTER_MS } from "./attention";
import type { Etl } from "./useEtl";

const daily = { kind: "cron" as const, cron: "0 3 * * *", interval_seconds: null, timezone: "UTC", active: true };

function etl(name: string, overrides: Partial<Etl> = {}): Etl {
  return {
    id: name,
    name,
    flow_name: name,
    description: null,
    tags: [],
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
    ...overrides,
  };
}

const after = (upstream: string) => ({ etl: upstream, on: "completed" as const, passes: ["updated_at_from"], sets: {} });

const messages = etl("messages", { schedule: daily, triggers: ["nlp"] });
const nlp = etl("nlp", { triggered_by: after("messages"), triggers: ["model"] });
const model = etl("model", { triggered_by: after("nlp") });
const all = [model, nlp, messages];

const names = (etls: readonly Etl[]) => etls.map((one) => one.name);

describe("chainOf", () => {
  it("is null for an ETL no other starts and that starts none", () => {
    expect(chainOf(etl("alone", { schedule: daily }), all)).toBeNull();
  });

  it("gives a middle link its upstream, its downstream, the scheduled ETL that paces it and the whole chain", () => {
    const chain = chainOf(nlp, all);
    expect(chain?.upstream?.name).toBe("messages");
    expect(names(chain?.downstream ?? [])).toEqual(["model"]);
    expect(chain?.pacedBy?.name).toBe("messages");
    expect(names(chain?.links ?? [])).toEqual(["messages", "nlp", "model"]);
  });

  it("paces the last link by the first ETL up the chain with a schedule", () => {
    expect(chainOf(model, all)?.pacedBy?.name).toBe("messages");
    expect(chainOf(messages, all)?.pacedBy).toBeNull();
  });

  it("stops the line where a link starts several, and names every one as downstream", () => {
    const report = etl("report", { triggered_by: after("messages") });
    const forked = etl("messages", { schedule: daily, triggers: ["nlp", "report"] });
    const chain = chainOf(forked, [forked, nlp, model, report]);
    expect(names(chain?.downstream ?? [])).toEqual(["nlp", "report"]);
    expect(names(chain?.links ?? [])).toEqual(["messages"]);
  });

  it("leaves out an upstream or downstream the list does not hold", () => {
    const orphan = etl("orphan", { triggered_by: after("gone"), triggers: ["also-gone"] });
    const chain = chainOf(orphan, [orphan]);
    expect(chain?.upstream).toBeNull();
    expect(chain?.downstream).toEqual([]);
    expect(names(chain?.links ?? [])).toEqual(["orphan"]);
  });

  it("walks a loop once", () => {
    const a = etl("a", { triggered_by: after("b"), triggers: ["b"] });
    const b = etl("b", { triggered_by: after("a"), triggers: ["a"] });
    expect(names(chainOf(a, [a, b])?.links ?? [])).toEqual(["b", "a"]);
    expect(chainOf(a, [a, b])?.pacedBy).toBeNull();
  });
});

describe("isScheduled", () => {
  it("is an ETL that runs without anyone starting it: on its own schedule, or after another completes", () => {
    expect(isScheduled(messages)).toBe(true);
    expect(isScheduled(nlp)).toBe(true);
    expect(isScheduled(etl("by-hand"))).toBe(false);
  });
});

describe("runDownstream", () => {
  const ended = "2026-10-06T03:09:00Z";
  const completed = (triggered_runs: { etl: string; run_id: string; run_name: string }[] = []) => ({
    state: "COMPLETED" as const,
    end_at: ended,
    triggered_runs,
  });
  const nlpRun = { etl: "nlp", run_id: "r-nlp", run_name: "calm-heron" };
  const at = (msAfter: number) => Date.parse(ended) + msAfter;

  it("names the runs started, and waits for the rest until half an hour after the run completed", () => {
    expect(runDownstream(completed([nlpRun]), ["nlp", "report"], at(60_000))).toEqual({ started: [nlpRun], waiting: ["report"], missing: [] });
  });

  it("still waits at the very end of that half hour", () => {
    expect(runDownstream(completed([nlpRun]), ["nlp", "report"], at(MISSED_AFTER_MS))).toEqual({ started: [nlpRun], waiting: ["report"], missing: [] });
    expect(downstreamSettlesAt(completed([nlpRun]), ["nlp", "report"])).toBe(at(MISSED_AFTER_MS));
  });

  it("says a downstream ETL did not run once that half hour has passed", () => {
    expect(runDownstream(completed([nlpRun]), ["nlp", "report"], at(MISSED_AFTER_MS + 1))).toEqual({ started: [nlpRun], waiting: [], missing: ["report"] });
  });

  it("expects nothing of a run that did not complete", () => {
    expect(runDownstream({ state: "FAILED", end_at: ended, triggered_runs: [] }, ["report"], at(MISSED_AFTER_MS + 1))).toEqual({
      started: [],
      waiting: [],
      missing: [],
    });
  });
});
