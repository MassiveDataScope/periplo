import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import { href } from "../../app/routes";
import { formatDuration, type RunState } from "./run-state";
import { useNow } from "./useNow";
import type { RunningRun } from "./useEtl";
import styles from "./RunningNow.module.css";

export interface RunningNowProps {
  readonly running: readonly RunningRun[];
  /** The dashboard's own runs (each ETL's `last_run` and `recent`), by run id: the only place a run's real
   * outcome shows up once it drops out of `running`, which carries no terminal state of its own. */
  readonly runStateById: ReadonlyMap<string, RunState>;
}

const FAILED_STATES: ReadonlySet<RunState> = new Set(["FAILED", "CRASHED"]);

/** Visible before "N more running" takes over. */
const MAX_VISIBLE = 3;
/** How long a finished run keeps its outcome colour before it leaves the stack. */
const DWELL_MS = 4_000;
/** The CSS transition's own duration (kept in sync with RunningNow.module.css `.leaving`). */
const EXIT_MS = 240;
const SLOW_RATIO = 1.5;

interface Finishing {
  readonly run: RunningRun;
  readonly finishedAt: number;
  /** The run's real terminal state, looked up in the dashboard's own list by id; null when it is not known yet
   * (a very fresh finish the poll carrying `etls[]` has not caught up with) — falls back to the ok tone. */
  readonly state: RunState | null;
}

function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** How far along a run is against its typical duration, and whether it counts as slow (> 1.5×). */
function progress(run: RunningRun, now: number): { elapsedSeconds: number | null; ratio: number | null; slow: boolean } {
  const start = run.start_at ? Date.parse(run.start_at) : NaN;
  const elapsedSeconds = Number.isNaN(start) ? null : Math.max(0, (now - start) / 1000);
  const ratio = elapsedSeconds !== null && run.typical_seconds !== null && run.typical_seconds > 0 ? elapsedSeconds / run.typical_seconds : null;
  return { elapsedSeconds, ratio, slow: ratio !== null && ratio > SLOW_RATIO };
}

/**
 * The "Running now" stack: live runs growing off the shared clock, each with its process › step, elapsed vs
 * typical, and a thin progress bar; a run that leaves `running` lingers ~4 s in its outcome colour (its last
 * known snapshot, since the list this reads from carries no terminal state) before it slides out — never while
 * hovered or focused. `aria-live` announces only starts and finishes, never the tick.
 */
export function RunningNow({ running, runStateById }: RunningNowProps) {
  const { t } = useTranslation();
  const now = useNow();
  const [expanded, setExpanded] = useState(false);
  const [finishing, setFinishing] = useState<Map<string, Finishing>>(new Map());
  const [announcement, setAnnouncement] = useState("");
  const previousIds = useRef<Set<string>>(new Set());
  const lastKnown = useRef<Map<string, RunningRun>>(new Map());
  const hovered = useRef<Set<string>>(new Set());
  const mounted = useRef(false);

  useEffect(() => {
    const currentIds = new Set(running.map((run) => run.id));
    const previous = previousIds.current;
    const justFinished = [...previous].filter((id) => !currentIds.has(id) && lastKnown.current.has(id));
    const justStarted = mounted.current ? running.filter((run) => !previous.has(run.id)) : [];

    if (justFinished.length > 0) {
      const finishedAt = Date.now();
      setFinishing((current) => {
        const next = new Map(current);
        for (const id of justFinished) {
          const run = lastKnown.current.get(id);
          if (run && !next.has(id)) next.set(id, { run, finishedAt, state: runStateById.get(id) ?? null });
        }
        return next;
      });
      setAnnouncement(
        justFinished
          .map((id) => lastKnown.current.get(id))
          .filter((run): run is RunningRun => run !== undefined)
          .map((run) => {
            const duration = formatDuration(run.start_at ? (finishedAt - Date.parse(run.start_at)) / 1000 : null) ?? "—";
            const state = runStateById.get(run.id) ?? null;
            return state !== null && FAILED_STATES.has(state)
              ? t("etl.dashboard.running.failed", { etl: run.etl, duration })
              : t("etl.dashboard.running.finished", { etl: run.etl, duration });
          })
          .join(" "),
      );
    } else if (justStarted.length > 0) {
      setAnnouncement(justStarted.map((run) => t("etl.dashboard.running.started", { etl: run.etl })).join(" "));
    }

    previousIds.current = currentIds;
    lastKnown.current = new Map(running.map((run) => [run.id, run]));
    mounted.current = true;
  }, [running, runStateById, t]);

  // One tick per second drops any finishing entry whose dwell (plus its own exit transition) is over, unless it
  // is currently hovered or focused: the row stays until the pointer or the keyboard focus lets go of it.
  useEffect(() => {
    setFinishing((current) => {
      if (current.size === 0) return current;
      const cutoff = reducedMotion() ? DWELL_MS : DWELL_MS + EXIT_MS;
      let changed = false;
      const next = new Map(current);
      for (const [id, entry] of current) {
        if (now - entry.finishedAt >= cutoff && !hovered.current.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [now]);

  if (running.length === 0 && finishing.size === 0) return null;

  const visibleLive = expanded ? running : running.slice(0, MAX_VISIBLE);
  const hiddenLive = expanded ? [] : running.slice(MAX_VISIBLE);

  return (
    <section aria-labelledby="etl-running-heading">
      <h3 className={`nt-overline ${styles.overline}`}>
        <span id="etl-running-heading">{t("etl.dashboard.running.heading")}</span>
        <span>{t("etl.dashboard.running.count", { count: running.length })}</span>
      </h3>
      <p className={styles.srOnly} aria-live="polite">
        {announcement}
      </p>
      <div className={styles.frame}>
        {visibleLive.map((run) => (
          <RunningRow key={run.id} run={run} now={now} onHover={(hovering) => setHoverState(hovered, run.id, hovering)} />
        ))}
        {[...finishing.values()].map(({ run, finishedAt, state }) => (
          <FinishedRow
            key={run.id}
            run={run}
            failed={state !== null && FAILED_STATES.has(state)}
            leaving={now - finishedAt >= DWELL_MS}
            onHover={(hovering) => setHoverState(hovered, run.id, hovering)}
          />
        ))}
      </div>
      {hiddenLive.length > 0 ? (
        <button type="button" className={styles.more} aria-expanded={expanded} onClick={() => setExpanded(true)}>
          {t("etl.dashboard.running.more", { count: hiddenLive.length, names: hiddenLive.map((run) => run.etl).join(", ") })}
        </button>
      ) : null}
    </section>
  );
}

function setHoverState(ref: MutableRefObject<Set<string>>, id: string, hovering: boolean): void {
  if (hovering) ref.current.add(id);
  else ref.current.delete(id);
}

function RunningRow({ run, now, onHover }: { readonly run: RunningRun; readonly now: number; onHover(hovering: boolean): void }) {
  const { t } = useTranslation();
  const { elapsedSeconds, ratio, slow } = progress(run, now);
  const typicalText = run.typical_seconds !== null ? formatDuration(run.typical_seconds) : null;
  const percent = ratio !== null ? Math.min(100, ratio * 100) : 0;
  return (
    <a
      className={styles.row}
      data-slow={slow || undefined}
      href={href({ kind: "etl-run", id: run.id })}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
    >
      <span>
        <span className={styles.etl}>{run.etl}</span>
        <span className={styles.step}>
          {run.current ? t("etl.dashboard.running.step", { step: run.current.step ?? "—", index: run.current.index, total: run.current.total }) : "—"}
        </span>
      </span>
      <span className={styles.clock}>
        <span className={styles.line}>
          <span className={styles.elapsed}>{formatDuration(elapsedSeconds) ?? "—"}</span>
          <span className={styles.typ}>{typicalText !== null ? t(slow ? "etl.dashboard.running.slow" : "etl.dashboard.running.typical", { value: typicalText, ratio: ratio?.toFixed(1) }) : ""}</span>
        </span>
        <span className={styles.track}>
          <span className={styles.fill} style={{ inlineSize: `${percent}%` }} />
        </span>
      </span>
    </a>
  );
}

function FinishedRow({
  run,
  failed,
  leaving,
  onHover,
}: {
  readonly run: RunningRun;
  readonly failed: boolean;
  readonly leaving: boolean;
  onHover(hovering: boolean): void;
}) {
  const { t } = useTranslation();
  return (
    <a
      className={styles.row}
      data-done={!failed || undefined}
      data-failed={failed || undefined}
      data-leaving={leaving || undefined}
      href={href({ kind: "etl-run", id: run.id })}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
    >
      <span>
        <span className={styles.etl}>{run.etl}</span>
        <span className={styles.step}>
          {run.current ? t("etl.dashboard.running.step", { step: run.current.step ?? "—", index: run.current.index, total: run.current.total }) : "—"}
        </span>
      </span>
      <span className={styles.clock}>
        <span className={styles.line}>
          <span className={styles.elapsed} />
          <span className={styles.typ}>{t(failed ? "etl.dashboard.running.doneFailed" : "etl.dashboard.running.done")}</span>
        </span>
        <span className={styles.track}>
          <span className={styles.fill} style={{ inlineSize: "100%" }} />
        </span>
      </span>
    </a>
  );
}
