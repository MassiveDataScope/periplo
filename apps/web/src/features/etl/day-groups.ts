import type { ExecutionStatus } from "@periplo/core/ui";
import { GROUP_BY_NEEDS, type EtlGroupBy } from "../../app/etl-routes";
import type { DayWindow, TimedStatus } from "./day-axis";
import { etlLine, groupOf, runsNowOf, type EtlGroupKind, type RunsNowByEtl } from "./etl-groups";
import { valueOf } from "./facets";
import { statusOf } from "./run-state";
import type { Etl } from "./useEtl";

/** An ETL's group on an axis grouped by a facet: the facet's key (a tag prefix) and the ETL's value of it (null when it
 * has none). */
export interface GroupLabel {
  readonly prefix: string;
  readonly value: string | null;
}

/** The kinds of the axis' own groups: what needs attention is listed apart, off the axis. */
type AxisGroupKind = Exclude<EtlGroupKind, "attention">;

export type SectionHeading = { readonly kind: AxisGroupKind } | ({ readonly kind: "label" } & GroupLabel);

/** One group on the panel's axis: the running ETLs drawn one row each, and the rest folded into a strip. */
export interface DaySection {
  readonly key: string;
  readonly heading: SectionHeading;
  readonly lines: readonly Etl[];
  readonly rest: readonly Etl[];
}

const byName = (a: Etl, b: Etl): number => a.name.localeCompare(b.name);

/** A paused schedule first (nothing will run until someone resumes it), then by name. */
const attentionOrder = (a: Etl, b: Etl): number => Number(b.schedule_inactive) - Number(a.schedule_inactive) || byName(a, b);

/** The ETLs split as the side list groups them, by the line each says, each group in its own order. */
function split(etls: readonly Etl[], runsNow: RunsNowByEtl): Record<EtlGroupKind, Etl[]> {
  const kinds: Record<EtlGroupKind, Etl[]> = { attention: [], running: [], rest: [] };
  for (const etl of etls) kinds[groupOf(etlLine(etl, runsNowOf(runsNow, etl.name)))].push(etl);
  kinds.attention.sort(attentionOrder);
  kinds.running.sort(byName);
  kinds.rest.sort(byName);
  return kinds;
}

function needsSections(running: readonly Etl[], rest: readonly Etl[]): DaySection[] {
  const sections: DaySection[] = [
    { key: "running", heading: { kind: "running" }, lines: running, rest: [] },
    { key: "rest", heading: { kind: "rest" }, lines: [], rest },
  ];
  return sections.filter((section) => section.lines.length > 0 || section.rest.length > 0);
}

/** Labelled groups by value, the unlabelled one last. */
const byLabel = ([a]: readonly [string | null, unknown], [b]: readonly [string | null, unknown]): number => {
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  return a.localeCompare(b);
};

function labelSections(etls: readonly Etl[], runsNow: RunsNowByEtl, prefix: string): DaySection[] {
  const byValue = new Map<string | null, Etl[]>();
  for (const etl of etls) {
    const value = valueOf(etl, prefix);
    const members = byValue.get(value);
    if (members === undefined) byValue.set(value, [etl]);
    else members.push(etl);
  }
  return [...byValue].sort(byLabel).map(([value, members]) => {
    const { running, rest } = split(members, runsNow);
    return { key: `${prefix}:${value ?? ""}`, heading: { kind: "label", prefix, value }, lines: running, rest };
  });
}

/** The panel's two parts: what needs attention, listed apart (a paused schedule first, then by name), and the rest on
 * the 24-hour axis, grouped by what needs me (Running, then Everything else) or by a facet (any tag prefix). */
interface DayGroups {
  readonly incidents: readonly Etl[];
  readonly sections: readonly DaySection[];
}

export function dayGroups(etls: readonly Etl[], runsNow: RunsNowByEtl, groupBy: EtlGroupBy): DayGroups {
  const { attention, running, rest } = split(etls, runsNow);
  const sections = groupBy === GROUP_BY_NEEDS ? needsSections(running, rest) : labelSections([...running, ...rest], runsNow, groupBy);
  return { incidents: attention, sections };
}

/** The looks the strip draws (and so the summary counts): a stopped run is neither done nor failed. */
const COUNTED: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>(["completed", "failed", "running"]);

/** The folded ETLs' runs that started inside the window and that the strip draws, so its summary says what it shows. */
export function restRuns(etls: readonly Etl[], axisWindow: DayWindow): TimedStatus[] {
  const runs: TimedStatus[] = [];
  for (const etl of etls) {
    for (const run of etl.recent) {
      // At its current (or last) attempt's start: a run retried from Prefect's UI keeps its first start.
      if (run.attempt_started_at === null) continue;
      const at = Date.parse(run.attempt_started_at);
      const status = statusOf(run.state, run.attempt_started_at);
      if (at >= axisWindow.start && at <= axisWindow.now && COUNTED.has(status)) runs.push({ at, status });
    }
  }
  return runs;
}

interface RestSummary {
  readonly runs: number;
  readonly failed: number;
}

/** "N runs · M failed earlier, fine now": the folded ETLs are fine now by definition, so any failure was earlier. */
export function restSummary(runs: readonly TimedStatus[]): RestSummary {
  return { runs: runs.length, failed: runs.filter((run) => run.status === "failed").length };
}
