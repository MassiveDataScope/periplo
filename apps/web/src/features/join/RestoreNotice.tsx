import { useTranslation } from "react-i18next";
import type { JoinRestoreNotice } from "./useJoinFromUrl";
import styles from "./JoinWorkspace.module.css";

/** What became of the join link the workspace opened with: unreadable, or restored with tables or keys left out. */
export function RestoreNotice({ notice }: { readonly notice: JoinRestoreNotice }) {
  const { t } = useTranslation();
  const lines =
    notice.kind === "broken"
      ? [t("join.restoreBroken")]
      : [
          notice.tables > 0 ? t("join.restoreDroppedTables", { count: notice.tables }) : "",
          notice.keys > 0 ? t("join.restoreDroppedKeys", { count: notice.keys }) : "",
        ];
  return (
    <p role="status" className={styles.warning}>
      {lines.filter(Boolean).join(" ")}
    </p>
  );
}
