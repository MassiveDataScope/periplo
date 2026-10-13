import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StatusSwatch, TabPanel, Tabs } from "@periplo/core/ui";
import type { components } from "../../../api/schema";
import { STATE_LABELS } from "../parts";
import { statusOf } from "../run-state";

type Attempt = Pick<components["schemas"]["Attempt"], "number" | "state" | "started_at">;

/** The attempt on screen: the one numbered `number` (the URL's), else the newest; -1 with none. */
export function attemptIndex(attempts: readonly Attempt[], number: number | undefined): number {
  const named = attempts.findIndex((attempt) => attempt.number === number);
  return named === -1 ? attempts.length - 1 : named;
}

interface AttemptTabsProps {
  readonly attempts: readonly Attempt[];
  readonly selected: number;
  /** An attempt by its number, or null for the newest (the default, which the URL leaves out). */
  onSelect(number: number | null): void;
  /** The attempt on screen, in the selected tab's panel. */
  readonly children: ReactNode;
}

const tabId = (attempt: Attempt): string => `attempt-${attempt.number}`;

/** One tab per attempt, its state as a swatch and in words ("Attempt 1 · Failed"), the attempt on screen in its panel;
 * a run of one attempt shows it alone. */
export function AttemptTabs({ attempts, selected, onSelect, children }: AttemptTabsProps) {
  const { t } = useTranslation();
  const current = attempts[selected];
  if (attempts.length <= 1 || current === undefined) return children;
  const newest = attempts.at(-1);
  const tabs = attempts.map((attempt) => ({
    id: tabId(attempt),
    label: t("etl.run.attemptTab", { number: attempt.number, state: t(STATE_LABELS[attempt.state]) }),
    mark: <StatusSwatch status={statusOf(attempt.state, attempt.started_at)} />,
  }));
  const select = (id: string) => {
    const attempt = attempts.find((candidate) => tabId(candidate) === id);
    if (attempt !== undefined) onSelect(attempt === newest ? null : attempt.number);
  };
  return (
    <>
      <Tabs label={t("etl.run.attempts")} tabs={tabs} selected={tabId(current)} onSelect={select} />
      <TabPanel tab={tabId(current)}>{children}</TabPanel>
    </>
  );
}
