import { useCallback, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { TabPanel, Tabs } from "@periplo/core/ui";
import { useMediaQuery } from "../../../app/useMediaQuery";
import { readSplit, writeSplit } from "./split-ratio";
import { SplitDivider } from "./SplitDivider";
import { useTimelineReach } from "./useTimelineReach";
import styles from "./RunWorkspace.module.css";

/** Too short for a timeline and a log one above the other, or too narrow for either beside the shell: tabs instead. */
const COMPACT_LAYOUT = "(max-height: 759px), (max-width: 719px)";

interface RunWorkspaceProps {
  readonly logsOpen: boolean;
  onLogsChange(open: boolean): void;
  readonly timeline: ReactNode;
  readonly log: ReactNode;
}

/** `localStorage`, reached only inside `readSplit`/`writeSplit`'s own guard: merely touching it can throw. */
const browserStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};

/** The split, followed on every move and kept (in `localStorage`) only where the reader leaves it. */
function useSplitRatio(): { readonly ratio: number; readonly change: (ratio: number) => void; readonly keep: (ratio: number) => void } {
  const [ratio, change] = useState(() => readSplit(browserStorage));
  const keep = useCallback((next: number) => writeSplit(browserStorage, next), []);
  return { ratio, change, keep };
}

/** The timeline's share of the height, for the stylesheet: the most it may take, its content permitting. */
function splitStyle(ratio: number): CSSProperties {
  const style: CSSProperties & Readonly<Record<"--split", number>> = { "--split": ratio };
  return style;
}

function Split({ logsOpen, onLogsChange, timeline, log }: RunWorkspaceProps) {
  const { t } = useTranslation();
  const { ratio, change, keep } = useSplitRatio();
  const { frameRef, paneRef, reach } = useTimelineReach();
  if (!logsOpen) {
    return (
      <div className={styles.split} data-log="closed">
        <div className={styles.pane}>{timeline}</div>
        <button type="button" className={styles.logBar} onClick={() => onLogsChange(true)}>
          {t("etl.runPage.showLog")}
        </button>
      </div>
    );
  }
  return (
    <div ref={frameRef} className={styles.split} data-log="open" style={splitStyle(ratio)}>
      <div ref={paneRef} className={styles.pane}>
        {timeline}
      </div>
      <SplitDivider ratio={ratio} max={reach} label={t("etl.runPage.resize")} onChange={change} onCommit={keep} />
      <div className={styles.pane}>{log}</div>
    </div>
  );
}

type Tab = "timeline" | "log";

function Tabbed({ logsOpen, onLogsChange, timeline, log }: RunWorkspaceProps) {
  const { t } = useTranslation();
  const selected: Tab = logsOpen ? "log" : "timeline";
  return (
    <div className={styles.tabbed} data-log={logsOpen ? "open" : "closed"}>
      <Tabs
        label={t("etl.runPage.views")}
        tabs={[
          { id: "timeline", label: t("etl.runPage.timelineTab") },
          { id: "log", label: t("etl.runPage.logTab") },
        ]}
        selected={selected}
        onSelect={(id) => onLogsChange(id === "log")}
      />
      <TabPanel tab={selected} className={styles.pane}>
        {logsOpen ? log : timeline}
      </TabPanel>
    </div>
  );
}

/** The timeline and the run's log: one above the other past a divider, the log folding to a bar while closed; on a
 * small screen, two tabs instead, the Log tab standing for an open log. */
export function RunWorkspace(props: RunWorkspaceProps) {
  return useMediaQuery(COMPACT_LAYOUT) ? <Tabbed {...props} /> : <Split {...props} />;
}
