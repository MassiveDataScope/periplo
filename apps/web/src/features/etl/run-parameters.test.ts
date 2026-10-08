import { describe, expect, it } from "vitest";
import {
  buildParameters,
  differingKeys,
  displayValue,
  draftOf,
  failedStart,
  formFields,
  isChanged,
  parameterKind,
  parseDraft,
  processesToRerun,
} from "./run-parameters";

describe("parameterKind", () => {
  it("edits strings, numbers and booleans as themselves, and only objects, lists and null as JSON", () => {
    expect(parameterKind("orders")).toBe("text");
    expect(parameterKind(5000)).toBe("number");
    expect(parameterKind(false)).toBe("boolean");
    expect(parameterKind({ a: 1 })).toBe("json");
    expect(parameterKind(["a"])).toBe("json");
    expect(parameterKind(null)).toBe("json");
  });
});

describe("drafts", () => {
  it("writes a value as the text its field starts from", () => {
    expect(draftOf("orders")).toBe("orders");
    expect(draftOf(5000)).toBe("5000");
    expect(draftOf(true)).toBe("true");
    expect(draftOf({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("reads a field's text back as a value of its kind", () => {
    expect(parseDraft("text", " 2026-10-05 ")).toEqual({ ok: true, value: " 2026-10-05 " });
    expect(parseDraft("number", " 12.5 ")).toEqual({ ok: true, value: 12.5 });
    expect(parseDraft("number", "-3")).toEqual({ ok: true, value: -3 });
    expect(parseDraft("number", "1e3")).toEqual({ ok: true, value: 1000 });
    expect(parseDraft("boolean", "false")).toEqual({ ok: true, value: false });
    expect(parseDraft("json", '["a"]')).toEqual({ ok: true, value: ["a"] });
  });

  it("says what is wrong with text that is not a value of its kind", () => {
    expect(parseDraft("number", "12a")).toEqual({ ok: false, problem: "notANumber" });
    expect(parseDraft("number", "0x10")).toEqual({ ok: false, problem: "notANumber" });
    expect(parseDraft("number", "Infinity")).toEqual({ ok: false, problem: "notANumber" });
    expect(parseDraft("number", "1,5")).toEqual({ ok: false, problem: "notANumber" });
    expect(parseDraft("number", "  ")).toEqual({ ok: false, problem: "notANumber" });
    expect(parseDraft("json", "{")).toEqual({ ok: false, problem: "invalidJson" });
  });
});

describe("differingKeys", () => {
  it("lists the names whose value differs from the schedule's, added and dropped ones included", () => {
    expect(differingKeys({ feed: "backfill", kind: "table", extra: 1 }, { feed: "facts", kind: "table", gone: true })).toEqual(["extra", "feed", "gone"]);
  });
});

describe("displayValue", () => {
  it("shows strings, numbers and booleans as plain text, and objects as compact JSON", () => {
    expect(displayValue("orders")).toBe("orders");
    expect(displayValue(5000)).toBe("5000");
    expect(displayValue(true)).toBe("true");
    expect(displayValue({ a: [1] })).toBe('{"a":[1]}');
    expect(displayValue("")).toBe('""');
  });
});

describe("processesToRerun", () => {
  it("is the failed process and every one after it", () => {
    expect(processesToRerun(["Extract", "Staging", "Publish"], "Staging")).toEqual(["Staging", "Publish"]);
  });

  it("is the failed process alone when the order does not know it", () => {
    expect(processesToRerun(["Extract", "Publish"], "Staging")).toEqual(["Staging"]);
  });
});

describe("formFields", () => {
  it("is one field per parameter, starting from the run's values and knowing the schedule's", () => {
    const fields = formFields({ feed: "facts", size: 10 }, { feed: "backfill", size: 10, extra: true }, []);
    expect(fields).toEqual([
      { name: "feed", kind: "text", usual: { value: "facts" }, start: "backfill" },
      { name: "size", kind: "number", usual: { value: 10 }, start: 10 },
      { name: "extra", kind: "boolean", usual: null, start: true },
    ]);
  });

  it("leaves out the names another control owns", () => {
    expect(formFields({ feed: "facts", processes: ["A"] }, { feed: "facts", processes: ["A"] }, ["processes"]).map((field) => field.name)).toEqual(["feed"]);
  });
});

describe("buildParameters", () => {
  const fields = formFields({ feed: "facts", size: 10, processes: ["A", "B"] }, { feed: "facts", size: 10, processes: ["A", "B"] }, ["processes"]);

  it("reads every field back as its kind, keeps what no field shows, and lets the overrides win", () => {
    expect(buildParameters(fields, { feed: "backfill", size: "12" }, { feed: "facts", size: 10, processes: ["A", "B"] }, {})).toEqual({
      ok: true,
      value: { feed: "backfill", size: 12, processes: ["A", "B"] },
    });
    expect(buildParameters(fields, { feed: "facts", size: "10" }, { processes: ["A", "B"] }, { processes: ["B"] })).toEqual({
      ok: true,
      value: { feed: "facts", size: 10, processes: ["B"] },
    });
  });

  it("names the fields whose text is not a value of their kind", () => {
    expect(buildParameters(fields, { feed: "x", size: "ten" }, {}, {})).toEqual({ ok: false, problems: { size: "notANumber" } });
  });
});

describe("failedStart", () => {
  const cell = (process: string, state: "COMPLETED" | "FAILED" | "CRASHED") => ({ process, state, duration_seconds: 1 });
  const gridRun = (state: "COMPLETED" | "FAILED", cells: ReturnType<typeof cell>[]) => ({
    id: state,
    name: state,
    state,
    start_at: null,
    duration_seconds: 1,
    cells,
  });

  it("is the process where the newest run failed, and the processes a run from it covers", () => {
    const grid = {
      processes: ["Extract", "Facts", "Publish"],
      truncated: false,
      runs: [gridRun("FAILED", [cell("Extract", "COMPLETED"), cell("Facts", "FAILED")])],
    };
    expect(failedStart(grid)).toEqual({ process: "Facts", processes: ["Facts", "Publish"] });
  });

  it("picks the first failed process in process order, whatever order the cells come in", () => {
    const grid = { processes: ["A", "B", "C"], truncated: false, runs: [gridRun("FAILED", [cell("C", "FAILED"), cell("B", "CRASHED")])] };
    expect(failedStart(grid)).toEqual({ process: "B", processes: ["B", "C"] });
  });

  it("looks past a run that is still going or about to, to the newest one that finished", () => {
    const going = { ...gridRun("COMPLETED", []), id: "now", state: "RUNNING" as const };
    const grid = { processes: ["A", "B"], truncated: false, runs: [gridRun("FAILED", [cell("A", "FAILED")]), going] };
    expect(failedStart(grid)).toEqual({ process: "A", processes: ["A", "B"] });
  });

  it("is null when the newest run did not fail", () => {
    const grid = {
      processes: ["Extract"],
      truncated: false,
      runs: [gridRun("FAILED", [cell("Extract", "FAILED")]), gridRun("COMPLETED", [cell("Extract", "COMPLETED")])],
    };
    expect(failedStart(grid)).toBeNull();
  });
});

describe("isChanged", () => {
  const [feed, extra] = formFields({ feed: "facts" }, { feed: "facts", extra: 1 }, []);

  it("is true once a field's value differs from the schedule's, or the schedule does not have it", () => {
    if (feed === undefined || extra === undefined) throw new Error("two fields expected");
    expect(isChanged(feed, "facts")).toBe(false);
    expect(isChanged(feed, "backfill")).toBe(true);
    expect(isChanged(extra, "1")).toBe(true);
  });
});

describe("differingKeys and inherited names", () => {
  it("compares a parameter only with one the other side holds itself, not with what every object inherits", () => {
    expect(differingKeys({}, { constructor: Object })).toEqual(["constructor"]);
    expect(differingKeys({ toString: "x" }, {})).toEqual(["toString"]);
  });

  it("gives a field a schedule value only when the schedule holds that name itself", () => {
    expect(formFields({}, { toString: "x" }, [])).toEqual([{ name: "toString", kind: "text", usual: null, start: "x" }]);
  });
});
