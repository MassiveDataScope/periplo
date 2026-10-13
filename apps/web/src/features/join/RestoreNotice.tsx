import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { JoinRestoreNotice } from "./useJoinFromUrl";
import styles from "./JoinWorkspace.module.css";

function linesOf(notice: JoinRestoreNotice, t: TFunction): readonly string[] {
  switch (notice.kind) {
    case "broken":
      return [t("join.restoreBroken")];
    case "unwritable":
      return [t("join.specUnwritable")];
    case "dropped":
      return [
        notice.tables > 0 ? t("join.restoreDroppedTables", { count: notice.tables }) : "",
        notice.unreadable.length > 0 ? t("join.restoreUnreadable", { count: notice.unreadable.length, tables: notice.unreadable.join(", ") }) : "",
        notice.keys > 0 ? t("join.restoreDroppedKeys", { count: notice.keys }) : "",
      ];
  }
}

/** What became of the join link the workspace opened with (unreadable, or restored with tables or keys left out, naming the tables that could not be loaded right now), or that the join no longer fits in one. */
export function RestoreNotice({ notice }: { readonly notice: JoinRestoreNotice }) {
  const { t } = useTranslation();
  return (
    <p role="status" className={styles.warning}>
      {linesOf(notice, t).filter(Boolean).join(" ")}
    </p>
  );
}
