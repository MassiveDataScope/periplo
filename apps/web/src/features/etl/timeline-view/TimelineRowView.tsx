import type { KeyboardEvent, MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { isPlainLeftClick } from "../../../app/clicks";
import { STATE_LABELS } from "../parts";
import type { StepRow, TimelineRow, TryRow } from "../timeline/rows";
import { labelSpot } from "./label-spot";
import { RowDrawing } from "./RowDrawing";
import { labelText, rowLabel, rowName, type LabelPart } from "./row-text";
import { textWidth } from "./text-width";
import { treeRowOf } from "./tree-keys";
import styles from "./RunTimeline.module.css";

interface RowViewProps {
  readonly row: TimelineRow;
  readonly axisWidth: number;
  /** The font labels are drawn in, to measure them before they are placed. */
  readonly font: string;
  /** The one row the Tab key reaches. */
  readonly tabbable: boolean;
  rowRef(element: HTMLDivElement | null): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>): void;
  onActivate(): void;
  stepHref(row: StepRow): string;
  onSelectStep(row: StepRow): void;
  tryHref(row: TryRow): string;
  onSelectTry(row: TryRow): void;
}

function Label({
  parts,
  row,
  axisWidth,
  font,
}: {
  readonly parts: readonly LabelPart[];
  readonly row: TimelineRow;
  readonly axisWidth: number;
  readonly font: string;
}) {
  if (parts.length === 0 || row.kind === "not-run") return null;
  const spot = labelSpot(row.bar, textWidth(labelText(parts), font), axisWidth);
  const style =
    spot.placement === "left"
      ? { insetInlineEnd: spot.end, maxInlineSize: axisWidth - spot.end }
      : { insetInlineStart: spot.start, maxInlineSize: axisWidth - spot.start };
  return (
    <span className={styles.label} data-placement={spot.placement} style={style} aria-hidden="true">
      {parts.map((part, index) => (
        <span key={index}>
          {index > 0 ? " · " : null}
          <span data-tone={part.tone}>{part.text}</span>
        </span>
      ))}
    </span>
  );
}

/** A step's or a try's name is a link to the page with it selected: a plain click selects it in place (replace), a
 * modified one opens it elsewhere as the browser does. */
function SelectLink({ name, href, onSelect }: { readonly name: string; readonly href: string; onSelect(): void }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>): void {
    // The row would take the click as its own activation too.
    event.stopPropagation();
    if (!isPlainLeftClick(event)) return;
    event.preventDefault();
    onSelect();
  }
  return (
    <a className={styles.stepLink} href={href} tabIndex={-1} onClick={onClick}>
      {name}
    </a>
  );
}

/** What a row's name cell holds: a link for a step or a try, its name otherwise. */
function NameCell({ row, name, props }: { readonly row: TimelineRow; readonly name: string; readonly props: RowViewProps }) {
  const { t } = useTranslation();
  if (row.kind === "step") return <SelectLink name={name} href={props.stepHref(row)} onSelect={() => props.onSelectStep(row)} />;
  if (row.kind === "try") return <SelectLink name={name} href={props.tryHref(row)} onSelect={() => props.onSelectTry(row)} />;
  return (
    <span className={styles.name} data-action={row.kind === "gap"} title={row.kind === "group" ? t("etl.timeline.stageInferred") : undefined}>
      {name}
    </span>
  );
}

const CHEVRONS = { open: "▾", folded: "▸" } as const;

/** One row of the treegrid: its name (with its fold chevron) and its track (its drawing and the label beside it). */
export function TimelineRowView(props: RowViewProps) {
  const { row, axisWidth, font, tabbable, rowRef, onKeyDown, onActivate } = props;
  const { t } = useTranslation();
  const tree = treeRowOf(row);
  const name = rowName(row, t);
  const parts = rowLabel(row, t);
  // A gap's or a group's state is in its label already.
  const state = row.kind === "process" || row.kind === "step" || row.kind === "try" ? t(STATE_LABELS[row.state]) : null;
  const accessibleName = [name, state, labelText(parts)].filter((part) => part !== null && part !== "").join(", ");
  return (
    <div
      ref={rowRef}
      role="row"
      className={styles.row}
      data-kind={row.kind}
      tabIndex={tabbable ? 0 : -1}
      aria-label={accessibleName}
      aria-level={row.level}
      aria-setsize={row.setSize}
      aria-posinset={row.posInSet}
      aria-expanded={tree.expanded ?? undefined}
      aria-selected={row.kind === "step" || row.kind === "try" ? row.selected : undefined}
      onKeyDown={onKeyDown}
      onClick={onActivate}
    >
      <div role="gridcell" className={styles.nameCell} style={{ paddingInlineStart: `${row.level - 1}rem` }}>
        <span className={styles.chevron} aria-hidden="true">
          {tree.expanded === null ? null : tree.expanded ? CHEVRONS.open : CHEVRONS.folded}
        </span>
        <NameCell row={row} name={name} props={props} />
      </div>
      <div role="gridcell" className={styles.track}>
        <RowDrawing row={row} />
        <Label parts={parts} row={row} axisWidth={axisWidth} font={font} />
      </div>
    </div>
  );
}
