import { formatBytes, formatCount } from "../../i18n/format";
import { Fingerprint } from "./Fingerprint";
import { FreshnessMark } from "./FreshnessMark";
import type { TableFacts } from "./useTableFacts";

export interface TableRowCellsProps {
  readonly facts: TableFacts;
  readonly language: string;
  /** `td` inside a real table (`TableSheet`), `span` inside a CSS-grid row (`LakeGlance`). */
  readonly tag: "td" | "span";
  readonly skeletonClassName?: string;
  /** Applied to the fingerprint's own wrapper (the flex row of dots + count), not the cell around it. */
  readonly fingerprintClassName?: string;
  readonly columnsClassName?: string;
  readonly rowsClassName?: string;
  readonly bytesClassName?: string;
  readonly freshClassName?: string;
  /** `LakeGlance` compacts row counts ("1.2k"); `TableSheet` spells them out. */
  readonly compactRows?: boolean;
  /** `TableSheet` shows a size column; `LakeGlance`'s child rows do not. */
  readonly showBytes?: boolean;
}

/**
 * The four cells every table row shows, wherever it is listed: fingerprint + column count,
 * row count, size (optional) and freshness. Each cell reveals itself as its own fact settles.
 */
export function TableRowCells({
  facts,
  language,
  tag: Tag,
  skeletonClassName,
  fingerprintClassName,
  columnsClassName,
  rowsClassName,
  bytesClassName,
  freshClassName,
  compactRows = false,
  showBytes = true,
}: TableRowCellsProps) {
  const skeleton = <span className={skeletonClassName} aria-busy="true" />;
  const detail = facts.detail?.kind === "ready" ? facts.detail.value : undefined;
  const detailLoading = facts.detail === undefined || facts.detail.kind === "loading";
  const stats = facts.stats?.kind === "ready" ? facts.stats.value : undefined;
  const statsLoading = facts.stats === undefined || facts.stats.kind === "loading";
  const historyLoading = facts.history === undefined || facts.history.kind === "loading";

  return (
    <>
      <Tag className={columnsClassName}>
        {detailLoading ? (
          skeleton
        ) : detail ? (
          <span className={fingerprintClassName}>
            <Fingerprint types={detail.fields.map((field) => field.type)} /> {detail.fields.length}
          </span>
        ) : (
          "—"
        )}
      </Tag>
      <Tag className={rowsClassName} data-align="end">
        {statsLoading ? skeleton : stats ? formatCount(stats.rows, language, compactRows ? { compact: true } : undefined) : "—"}
      </Tag>
      {showBytes ? (
        <Tag className={bytesClassName} data-align="end">
          {statsLoading ? skeleton : stats ? formatBytes(stats.bytes, language) : "—"}
        </Tag>
      ) : null}
      <Tag className={freshClassName}>{historyLoading ? skeleton : facts.freshness?.lastWrite ? <FreshnessMark value={facts.freshness} /> : "—"}</Tag>
    </>
  );
}
