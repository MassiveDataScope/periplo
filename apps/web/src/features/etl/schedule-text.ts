import type { TFunction } from "i18next";
import { describeSchedule } from "./run-state";
import { describeCron } from "./schedule-words";
import type { Etl } from "./useEtl";

/** The schedule as words for a sub-line: a cron in plain English (falling back to the raw line for a shape
 * `describeCron` does not cover), its timezone appended, "after X completes" for a chained ETL, "manual" for an
 * on-demand one. */
export function scheduleWords(etl: Pick<Etl, "schedule" | "triggered_by">, t: TFunction): string {
  const schedule = etl.schedule;
  if (schedule === null) return etl.triggered_by !== null ? t("etl.afterCompletes", { etl: etl.triggered_by.etl }) : t("etl.manual");
  if (schedule.kind === "cron" && schedule.cron) {
    const base = describeCron(schedule.cron) ?? schedule.cron;
    return schedule.timezone ? `${base} ${schedule.timezone}` : base;
  }
  return describeSchedule(schedule).text;
}
