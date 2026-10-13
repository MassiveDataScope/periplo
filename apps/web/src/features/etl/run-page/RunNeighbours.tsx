import { useTranslation } from "react-i18next";
import type { Dependencies } from "../../../app/dependencies";
import { href } from "../../../app/routes";
import { useInSection } from "../SectionLinks";
import { useEtlRuns } from "../useEtl";
import { runNeighbours } from "./neighbours";
import styles from "./RunNeighbours.module.css";

/** The most runs the API lists at once; it cannot list them by date, so the neighbours come from these. */
const LOADED_RUNS = 100;
/** How often the neighbours are read again while one of them is live: links, not a live view, so seldom. */
const NEIGHBOURS_POLL_MS = 30_000;

interface RunNeighboursProps {
  readonly dependencies: Dependencies;
  readonly etl: string;
  readonly runId: string;
}

/** Links to the run before and the run after this one of the same ETL, by start time: another run is another view,
 * so a plain link (a new entry). Past the oldest run loaded, the ETL's own runs instead. */
export function RunNeighbours({ dependencies, etl, runId }: RunNeighboursProps) {
  const { t } = useTranslation();
  const inSection = useInSection();
  const { runs } = useEtlRuns(dependencies, etl, LOADED_RUNS, { pollMs: NEIGHBOURS_POLL_MS });
  if (runs.kind !== "ready") return null;
  const { older, newer } = runNeighbours(runs.value, runId, runs.value.length < LOADED_RUNS);
  return (
    <nav className={styles.neighbours} aria-label={t("etl.runPage.otherRuns", { etl })}>
      {older?.kind === "run" ? <a href={href(inSection({ kind: "etl-run", id: older.id }))}>{t("etl.runPage.previousRun")}</a> : null}
      {older?.kind === "more" ? <a href={href(inSection({ kind: "etl-deployment", name: etl }))}>{t("etl.runPage.olderRuns")}</a> : null}
      {newer?.kind === "run" ? <a href={href(inSection({ kind: "etl-run", id: newer.id }))}>{t("etl.runPage.nextRun")}</a> : null}
      {newer?.kind === "more" ? <a href={href(inSection({ kind: "etl-deployment", name: etl }))}>{t("etl.runPage.newerRuns")}</a> : null}
    </nav>
  );
}
