import { StatusSwatch } from "@periplo/core/ui";
import { useTranslation } from "react-i18next";
import type { TranslationKey } from "../../i18n";
import type { DayOutcome, StripDay } from "./schedule-strip";
import { dayDate, dayOfMonth } from "./zoned-time";
import styles from "./ScheduleDays.module.css";

const OUTCOME_LABELS: Readonly<Record<DayOutcome, TranslationKey>> = {
  completed: "etl.page.day.completed",
  failed: "etl.page.day.failed",
  running: "etl.page.day.running",
  scheduled: "etl.page.day.scheduled",
  stopped: "etl.page.day.stopped",
  none: "etl.page.day.none",
  unknown: "etl.page.day.unknown",
};

/** Ahead, a stopped day is one the paused schedule would run on, and an empty day one it does not. */
const AHEAD_LABELS: Readonly<Partial<Record<DayOutcome, TranslationKey>>> = {
  stopped: "etl.page.day.stoppedAhead",
  none: "etl.page.day.noneAhead",
};

/** What a day's outcome means in words: on a day still to come, stopped and empty speak of the schedule, not of a run. */
function outcomeLabel(day: StripDay): TranslationKey {
  return (day.ahead ? AHEAD_LABELS[day.outcome] : undefined) ?? OUTCOME_LABELS[day.outcome];
}

/** Fourteen days around today as swatches, each with its day of the month; the date and outcome in words for a screen
 * reader and on hover. */
export function ScheduleDays({ days }: { readonly days: readonly StripDay[] }) {
  const { t, i18n } = useTranslation();
  const dateFormat = new Intl.DateTimeFormat(i18n.language, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <ol className={styles.days} aria-label={t("etl.page.stripLabel")}>
      {days.map((day) => {
        const formatted = dateFormat.format(dayDate(day.key));
        const date = day.when === "today" ? `${formatted} (${t("etl.page.today")})` : formatted;
        const label = t("etl.page.dayLabel", { date, outcome: t(outcomeLabel(day)) });
        return (
          <li key={day.key} className={styles.day} data-when={day.when} aria-current={day.when === "today" ? "date" : undefined} title={label}>
            {day.outcome === "none" || day.outcome === "unknown" ? (
              <span aria-hidden="true" className={styles.empty} data-outcome={day.outcome} />
            ) : (
              <StatusSwatch status={day.outcome} shape="bar" className={styles.swatch} />
            )}
            <span aria-hidden="true" className={styles.number}>
              {dayOfMonth(day.key)}
            </span>
            <span className="nt-sr-only">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
