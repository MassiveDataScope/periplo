import { Fragment } from "react";
import { Trans, useTranslation } from "react-i18next";
import { href } from "../../app/routes";
import type { TranslationKey } from "../../i18n";
import { formatClock } from "../../i18n/format";
import type { EtlChain } from "./chain";
import { ChainStrip } from "./ChainStrip";
import { EtlCard } from "./EtlCard";
import { describeSchedule, formatInterval, isScheduleOff, type Schedule } from "./run-state";
import { placeOf, scheduleClockIn, scheduleTimeZone, scheduleZoneName, type ClockIn } from "./schedule-clock";
import { scheduleStrip } from "./schedule-strip";
import { describeCron } from "./schedule-words";
import { ScheduleDays } from "./ScheduleDays";
import { useInSection } from "./SectionLinks";
import type { Etl, FlowRun } from "./useEtl";
import link from "./inline-link.module.css";
import styles from "./ScheduleCard.module.css";

/** The team's own clock: a schedule kept in another time zone also says what time that is there. */
const TEAM_TIME_ZONE = "Europe/Madrid";

const CLOCK_IN: Readonly<Record<ClockIn["dayShift"], TranslationKey>> = {
  [-1]: "etl.page.clockInDayBefore",
  0: "etl.page.clockIn",
  1: "etl.page.clockInNextDay",
};

interface ScheduleCardProps {
  readonly etl: Etl;
  /** Its place among chained ETLs, or null when it is in no chain. */
  readonly chain: EtlChain | null;
  readonly runs: readonly FlowRun[];
  /** The start of the oldest run fetched when older ones may exist; null when `runs` is the whole history. */
  readonly knownSince: string | null;
  readonly now: number;
}

/**
 * When the ETL runs: in words, on the team's clock, the cron itself in small, and seven days back and seven ahead. A
 * chained ETL runs after its upstream completes: its days ahead are those of the schedule that paces the chain, and
 * the chain itself follows; then what this ETL starts next, when the chain cannot show it (it starts several).
 */
export function ScheduleCard({ etl, chain, runs, knownSince, now }: ScheduleCardProps) {
  const { t, i18n } = useTranslation();
  const pacedBy = etl.triggered_by !== null ? (chain?.pacedBy ?? null) : null;
  const paused = isScheduleOff(etl) || (pacedBy !== null && isScheduleOff(pacedBy));
  const days = scheduleStrip({
    schedule: pacedBy?.schedule ?? etl.schedule,
    paused,
    nextRunAt: pacedBy?.next_run_at ?? etl.next_run_at,
    runs,
    knownSince,
    now,
  });
  const teamClock = scheduleClockIn(etl.schedule, now, TEAM_TIME_ZONE);
  // The cron in small only beside its words: one shown as written is not repeated.
  const cron = etl.schedule?.kind === "cron" && etl.schedule.cron !== null && describeCron(etl.schedule.cron) !== null ? etl.schedule.cron : null;
  return (
    <EtlCard title={t("etl.page.schedule")}>
      <div className={styles.words}>
        <span className={styles.headline}>
          {etl.triggered_by !== null ? (
            <RunsAfter upstream={etl.triggered_by.etl} linked={chain?.upstream != null} />
          ) : (
            <ScheduleSentence schedule={etl.schedule} />
          )}
        </span>
        {etl.schedule !== null && scheduleTimeZone(etl.schedule) === null ? <span className={styles.note}>{t("etl.page.zoneNotRecognised")}</span> : null}
        {teamClock !== null || cron !== null ? (
          <span className={styles.muted}>
            {teamClock !== null ? <span>{t(CLOCK_IN[teamClock.dayShift], { time: teamClock.time, place: placeOf(TEAM_TIME_ZONE) })}</span> : null}
            {teamClock !== null && cron !== null ? " · " : null}
            {cron !== null ? <code className={styles.code}>{cron}</code> : null}
          </span>
        ) : null}
      </div>
      <ScheduleDays days={days} />
      {chain !== null ? <ChainStrip chain={chain} current={etl.name} /> : null}
      {chain !== null && chain.downstream.some((next) => !chain.links.includes(next)) ? <ThenTriggers downstream={chain.downstream} /> : null}
      {etl.schedule !== null ? (
        <span className={styles.muted}>
          {paused
            ? t("etl.page.pausedNothingRuns")
            : etl.next_run_at !== null
              ? t("etl.page.nextRun", { when: formatClock(new Date(etl.next_run_at), new Date(now), i18n.language) })
              : null}
        </span>
      ) : null}
    </EtlCard>
  );
}

/** "Runs after X completes", X a link to its page when the list holds it. */
function RunsAfter({ upstream, linked }: { readonly upstream: string; readonly linked: boolean }) {
  const inSection = useInSection();
  const name = linked ? <a className={link.inlineLink} href={href(inSection({ kind: "etl-deployment", name: upstream }))} /> : <span />;
  return <Trans i18nKey="etl.page.runsAfter" values={{ etl: upstream }} components={{ upstream: name }} />;
}

/** "Then triggers Y, Z": each ETL this one's completed run starts, a link to its page. */
function ThenTriggers({ downstream }: { readonly downstream: readonly Etl[] }) {
  const { t } = useTranslation();
  const inSection = useInSection();
  return (
    <p className={styles.muted}>
      {t("etl.page.thenTriggers")}{" "}
      {downstream.map((next, index) => (
        <Fragment key={next.name}>
          {index > 0 ? ", " : null}
          <a className={link.inlineLink} href={href(inSection({ kind: "etl-deployment", name: next.name }))}>
            {next.name}
          </a>
        </Fragment>
      ))}
    </p>
  );
}

/** The schedule as a sentence: `describeSchedule` says what kind it is (and the raw cron when there are no words for
 * it), `describeCron` puts the common cron shapes in words, always with the time zone they are counted in. */
function ScheduleSentence({ schedule }: { readonly schedule: Schedule | null }) {
  const { t } = useTranslation();
  const described = describeSchedule(schedule);
  switch (described.kind) {
    case "manual":
      return <>{t("etl.page.manualSchedule")}</>;
    case "cron": {
      const cron = schedule?.cron ?? null;
      const words = cron === null ? null : describeCron(cron);
      return <>{words === null ? described.text : t("etl.page.inTimeZone", { schedule: words, timeZone: scheduleZoneName(schedule) })}</>;
    }
    case "interval":
      return <>{schedule?.interval_seconds != null ? t("etl.every", { value: formatInterval(schedule.interval_seconds) }) : described.text}</>;
    case "rrule":
      return <>{t("etl.page.rrule")}</>;
  }
}
