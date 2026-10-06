import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { settled, useQuerySession } from "@periplo/core/api/react";
import type { ResultBuffer } from "@periplo/core/arrow";
import { Button, ErrorNotice, Icon, Progress, typeFamily } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import type { PreferencesStore } from "../../app/preferences";
import { href, navigate, replaceRoute, type Route } from "../../app/routes";
import { wantOnce } from "../../api/table-facts";
import { tableKey, type Catalog } from "../catalog-tree/catalog-model";
import { matchTokens } from "../catalog-tree/names";
import { ResultPane } from "../table/data/ResultPane";
import { TableHeader } from "../table/TableHeader";
import { crumbsFor } from "../lake/crumbs";
import { useTableFacts } from "../lake/useTableFacts";
import { CheckJoinCard, type CheckJoinState } from "./CheckJoinCard";
import { Connectors, type ConnectorLink } from "./Connectors";
import {
  addTable,
  baseAlias,
  buildCheckJoinSql,
  buildJoinSql,
  canPair,
  joinedTables,
  keysOf,
  orderedAliases,
  pairColumns,
  readCheckJoin,
  removePair,
  removeTable,
  setKind,
  setOutput,
  startJoin,
  type CheckJoinResult,
  type JoinDefinition,
  type JoinKind,
  type JoinPairSide,
  type JoinTable,
} from "./join-model";
import { decodeJoinSpec, encodeJoinSpec, restoreJoin } from "./join-spec";
import { SqlReceipt } from "./SqlReceipt";
import { TableCard, type Armed, type BandRow } from "./TableCard";
import styles from "./JoinWorkspace.module.css";

export interface JoinWorkspaceProps {
  readonly dependencies: Dependencies;
  readonly preferences: PreferencesStore;
  readonly catalog: Catalog | null;
  readonly database: string;
  readonly table: string;
  /** A column of the base table to arm on arrival ("Join on this column…"), claimed once. */
  readonly arm?: string;
  /** The whole join from the URL (`encodeJoinSpec`): restored on arrival, then kept up to date in place. */
  readonly spec?: string;
  readonly back: Route | null;
  /** Hands the join's SQL to the free SQL workspace, the same way Home and the database page do. */
  onOpenInEditor(sql: string): void;
}

const MAX_CHOICES = 8;
/** Below this, a pointer release is a click that missed, not a drag: click keeps handling it. */
const DRAG_THRESHOLD_PX = 4;

interface DragState {
  readonly from: Armed;
  readonly originX: number;
  readonly originY: number;
  readonly x: number;
  readonly y: number;
  readonly moved: boolean;
}

function rowsOf(buffer: ResultBuffer, count: number): Record<string, unknown>[] {
  const fields = buffer.schema?.fields ?? [];
  return Array.from({ length: count }, (_, row) => {
    const record: Record<string, unknown> = {};
    fields.forEach((field, column) => {
      const cell = buffer.cell(row, column);
      record[field.name] = cell.kind === "null" ? null : cell.fullText();
    });
    return record;
  });
}

function bandRowsFor(
  def: JoinDefinition,
  alias: string,
  suggestedKeys: ReadonlySet<string>,
  onRemove: (owner: string, rightColumn: string) => void,
): BandRow[] {
  const own = def.joins.find((step) => step.alias === alias);
  const ownRows: BandRow[] = (own?.pairs ?? []).map((pair) => ({
    column: pair.right,
    otherAlias: pair.left.alias,
    otherColumn: pair.left.column,
    suggested: suggestedKeys.has(`${alias}:${pair.right}`),
    remove: () => onRemove(alias, pair.right),
  }));
  const referencedRows: BandRow[] = def.joins.flatMap((step) =>
    step.pairs
      .filter((pair) => pair.left.alias === alias)
      .map((pair) => ({
        column: pair.left.column,
        otherAlias: step.alias,
        otherColumn: pair.right,
        suggested: suggestedKeys.has(`${step.alias}:${pair.right}`),
        remove: () => onRemove(step.alias, pair.right),
      })),
  );
  return [...ownRows, ...referencedRows];
}

/** Which of two tables a pair belongs to: always the one added later. */
function ownerOf(def: JoinDefinition, a: JoinPairSide, b: JoinPairSide): JoinPairSide {
  const order = orderedAliases(def);
  return order.indexOf(a.alias) < order.indexOf(b.alias) ? b : a;
}

/**
 * Tables face to face: a card per table, pairs made by click or by dragging a wire, a check before Run
 * and a live SQL receipt. Owns its own query sessions (Run and Check are independent), so it survives
 * leaving the table's Data tab.
 */
export function JoinWorkspace({ dependencies, preferences, catalog, database, table, arm, spec, back, onOpenInEditor }: JoinWorkspaceProps) {
  const { t, i18n } = useTranslation();
  const facts = useTableFacts(dependencies, database, table, ["detail", "stats", "history"]);
  const detail = useMemo(() => facts.detail ?? { kind: "loading" as const }, [facts.detail]);

  const [def, setDef] = useState<JoinDefinition | null>(null);
  const [armed, setArmed] = useState<Armed | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  /** Pair keys (`alias:column`) that `addTable` proposed, untouched since: dashed in the band and the wires. */
  const [suggestedKeys, setSuggestedKeys] = useState<ReadonlySet<string>>(new Set());
  const [status, setStatus] = useState("");
  const [pickerOpen, setPickerOpen] = useState(true);
  const [search, setSearch] = useState("");
  const [pickError, setPickError] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [checkState, setCheckState] = useState<CheckJoinState>("idle");
  const [checkGeneration, setCheckGeneration] = useState<number | null>(null);
  const claimedArm = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const bandNodes = useRef(new Map<string, HTMLElement>());

  /** How many tables or keys of the join in the URL no longer exist: said once, not silently ignored. */
  const [restoreNotice, setRestoreNotice] = useState<{ readonly kind: "dropped"; readonly count: number } | { readonly kind: "broken" } | null>(null);

  // Arrival: the join in the URL is rebuilt from the tables as they read now; without one, just the base.
  useEffect(() => {
    if (def !== null || detail.kind !== "ready") return;
    const base: JoinTable = { database, table, columns: detail.value.fields };
    const decoded = spec ? decodeJoinSpec(spec) : null;
    if (!decoded || decoded.steps.length === 0) {
      setDef(startJoin(base));
      if (spec && !decoded) setRestoreNotice({ kind: "broken" });
      return;
    }
    let cancelled = false;
    void (async () => {
      const read = new Map<string, JoinTable | null>();
      await Promise.all(
        decoded.steps.map(async (step) => {
          const key = `${step.database}.${step.table}`;
          try {
            const snapshot = await wantOnce(dependencies.tableFacts, step.database, step.table, ["detail"]);
            read.set(key, snapshot.detail?.kind === "ready" ? { database: step.database, table: step.table, columns: snapshot.detail.value.fields } : null);
          } catch {
            read.set(key, null);
          }
        }),
      );
      if (cancelled) return;
      const restored = restoreJoin(base, decoded, (otherDatabase, otherTable) => read.get(`${otherDatabase}.${otherTable}`) ?? null);
      setDef(restored.def);
      setPickerOpen(restored.def.joins.length === 0);
      if (restored.dropped > 0) setRestoreNotice({ kind: "dropped", count: restored.dropped });
    })();
    return () => {
      cancelled = true;
    };
  }, [def, detail, database, table, spec, dependencies.tableFacts]);

  // Every change to the join replaces the URL in place: a reload, the way back from the SQL editor or a
  // shared link find the same join, and editing it never piles up Back presses.
  useEffect(() => {
    if (!def) return;
    const next = def.joins.length > 0 ? encodeJoinSpec(def) : undefined;
    if (next === spec) return;
    replaceRoute({ kind: "join", database, table, ...(next ? { spec: next } : {}) });
  }, [def, spec, database, table]);

  useEffect(() => {
    if (claimedArm.current || def === null || detail.kind !== "ready") return;
    claimedArm.current = true;
    if (!arm) return;
    const field = detail.value.fields.find((candidate) => candidate.name === arm);
    if (!field) return;
    setArmed({ alias: baseAlias({ base: def.base }), column: field.name, type: field.type });
    setPickerOpen(false);
  }, [def, detail, arm]);

  const announce = (message: string) => setStatus(message);

  const session = useQuerySession(dependencies.createQuerySession);
  const checkSession = useQuerySession(dependencies.createQuerySession);
  const busy = session.state.kind === "starting" || session.state.kind === "streaming";

  const built = def ? buildJoinSql(def) : { ok: false as const, reasons: [] };
  const builtCheck = def ? buildCheckJoinSql(def) : { ok: false as const };

  const checkSettled = settled(checkSession.state, checkGeneration);
  const checkResults: readonly CheckJoinResult[] | null = useMemo(() => {
    if (!checkSettled || checkSession.state.kind !== "completed" || !checkSession.resource) return null;
    return readCheckJoin(rowsOf(checkSession.resource, checkSession.state.rows), def?.joins.map((step) => step.alias) ?? []);
  }, [checkSettled, checkSession.state, checkSession.resource, def]);

  useEffect(() => {
    if (checkSettled && checkSession.state.kind === "completed") setCheckState("done");
  }, [checkSettled, checkSession.state]);

  const markStale = () => {
    setCheckState((current) => (current === "done" ? "stale" : current));
  };

  const mutate = (change: (current: JoinDefinition) => JoinDefinition) => {
    setDef((current) => (current ? change(current) : current));
    markStale();
  };

  /** Marks the pair a person just made by hand as no longer a suggestion: it draws solid, not dashed. */
  const markManual = (a: JoinPairSide, b: JoinPairSide) => {
    if (!def) return;
    const owner = ownerOf(def, a, b);
    setSuggestedKeys((current) => {
      const next = new Set(current);
      next.delete(`${owner.alias}:${owner.column}`);
      return next;
    });
  };

  const pairFromCard = (a: JoinPairSide, b: JoinPairSide) => {
    markManual(a, b);
    mutate((current) => pairColumns(current, a, b));
  };

  const removeOnePair = (owner: string, rightColumn: string) => {
    mutate((current) => removePair(current, owner, rightColumn));
    setSuggestedKeys((current) => {
      const next = new Set(current);
      next.delete(`${owner}:${rightColumn}`);
      return next;
    });
  };

  const pick = async (otherDatabase: string, otherTable: string) => {
    setPickError(false);
    if (!def) return;
    try {
      const snapshot = await wantOnce(dependencies.tableFacts, otherDatabase, otherTable, ["detail"]);
      if (snapshot.detail?.kind !== "ready") throw new Error("unreadable");
      const picked: JoinTable = { database: otherDatabase, table: otherTable, columns: snapshot.detail.value.fields };
      const next = addTable(def, picked);
      const newStep = next.joins.at(-1);
      setDef(next);
      markStale();
      if (newStep) {
        const added = newStep.pairs.map((pair) => `${newStep.alias}:${pair.right}`);
        setSuggestedKeys((current) => new Set([...current, ...added]));
      }
      setPickerOpen(false);
      setSearch("");
    } catch {
      setPickError(true);
    }
  };

  const choices = useMemo(() => {
    if (!catalog || search.trim() === "" || !def) return [];
    const already = new Set(joinedTables(def).map((entry) => `${entry.table.database}.${entry.table.table}`));
    return catalog.tables.filter((candidate) => !already.has(tableKey(candidate)) && matchTokens(search, tableKey(candidate)) !== null).slice(0, MAX_CHOICES);
  }, [catalog, search, def]);

  const runJoin = () => {
    if (!built.ok) return;
    session.run(built.sql);
    setCollapsed(true);
  };

  const checkJoin = () => {
    if (!builtCheck.ok) return;
    const generation = checkSession.run(builtCheck.sql);
    setCheckGeneration(generation);
    setCheckState("running");
  };

  const onDragStart = (ref: Armed, point: { readonly x: number; readonly y: number }) => {
    setDrag({ from: ref, originX: point.x, originY: point.y, x: point.x, y: point.y, moved: false });
  };

  const onBoardPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const dx = event.clientX - drag.originX;
    const dy = event.clientY - drag.originY;
    const moved = drag.moved || Math.hypot(dx, dy) > DRAG_THRESHOLD_PX;
    setDrag({ ...drag, x: event.clientX, y: event.clientY, moved });
  };

  const onDragEnd = (ref: Armed) => {
    const active = drag;
    setDrag(null);
    // Released with no real movement: a plain click released over its own button, already handled by onClick.
    if (!active || !active.moved || !def) return;
    if (active.from.alias === ref.alias) return;
    if (!canPair(active.from.type, ref.type)) return;
    pairFromCard(active.from, ref);
    announce(t("join.paired", { a: `${active.from.alias}.${active.from.column}`, b: `${ref.alias}.${ref.column}` }));
  };

  const registerBandNode = (key: string, node: HTMLElement | null) => {
    if (node) bandNodes.current.set(key, node);
    else bandNodes.current.delete(key);
  };

  // Ctrl/Cmd+Enter runs, Ctrl/Cmd+Shift+Enter checks, Esc cancels a drag or disarms.
  useEffect(() => {
    if (collapsed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        if (event.shiftKey) checkJoin();
        else runJoin();
      } else if (event.key === "Escape") {
        if (drag) setDrag(null);
        else if (armed) setArmed(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed, armed, drag, built, builtCheck]);

  const crumbs = crumbsFor(catalog, database, table, { database: true });
  const stats = facts.stats?.kind === "ready" ? facts.stats.value : null;

  const chainLabel = def ? [def.base.table, ...def.joins.map((step) => step.table.table)].join(" ⟕ ") : table;
  const effectiveArmed = drag ? drag.from : armed;

  const links: readonly ConnectorLink[] = def
    ? def.joins.flatMap((step) =>
        step.pairs.map((pair) => {
          const type = step.table.columns.find((column) => column.name === pair.right)?.type ?? "";
          return {
            id: `${step.alias}:${pair.right}`,
            fromKey: `${pair.left.alias}:${pair.left.column}`,
            toKey: `${step.alias}:${pair.right}`,
            family: typeFamily(type),
            suggested: suggestedKeys.has(`${step.alias}:${pair.right}`),
          };
        }),
      )
    : [];
  const liveWire = drag && drag.moved ? { x1: drag.originX, y1: drag.originY, x2: drag.x, y2: drag.y, family: typeFamily(drag.from.type) } : null;

  return (
    <div className={styles.page}>
      <TableHeader
        crumbs={crumbs}
        back={back ? { href: href(back), label: table } : null}
        title={t("join.workspaceTitle", { table })}
        freshness={facts.freshness}
        stats={stats}
        columns={detail.kind === "ready" ? detail.value.fields.length : null}
        version={detail.kind === "ready" ? detail.value.delta_version : null}
      >
        <Button onClick={() => navigate({ kind: "table", database, table, tab: "data" })}>{t("join.close")}</Button>
      </TableHeader>

      <p aria-live="polite" className={styles.srOnly}>
        {status}
      </p>

      {detail.kind === "failed" ? <ErrorNotice title={t("table.unreadable")} error={detail.error} /> : null}
      {restoreNotice ? (
        <p role="status" className={styles.warning}>
          {restoreNotice.kind === "broken" ? t("join.restoreBroken") : t("join.restoreDropped", { count: restoreNotice.count })}
        </p>
      ) : null}
      {detail.kind === "loading" ? <Progress label={t("table.loading", { table })} /> : null}

      {def && collapsed ? (
        <div className={styles.strip}>
          <span className={styles.mono}>{t("join.stripLabel", { chain: chainLabel })}</span>
          <Button onClick={() => setCollapsed(false)}>{t("join.editJoin")}</Button>
          <Button aria-label={t("join.close")} onClick={() => navigate({ kind: "table", database, table, tab: "data" })}>
            ×
          </Button>
        </div>
      ) : null}

      {def && !collapsed ? (
        <div className={styles.workspace}>
          <div className={styles.chain}>
            {joinedTables(def).map((entry2) => (
              <span key={entry2.alias} className={styles.chainItem}>
                {entry2.table.table}
              </span>
            ))}
            <button type="button" className={styles.addTable} aria-expanded={pickerOpen} onClick={() => setPickerOpen((open) => !open)}>
              <Icon name="insert" /> {t("join.addTable")}
            </button>
          </div>

          {/* In the page, not floating: it pushes the tables down instead of covering them. */}
          {pickerOpen ? (
            <div className={styles.pickerRow}>
              <label className={styles.finder}>
                <Icon name="search" />
                <input
                  type="search"
                  autoFocus
                  aria-label={t("join.pickerSearch")}
                  placeholder={t("join.pickPlaceholder")}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    setPickerOpen(false);
                    setSearch("");
                  }}
                />
              </label>
              {pickError ? (
                <p role="alert" className={styles.warning}>
                  {t("join.unreadable")}
                </p>
              ) : null}
              {choices.length > 0 ? (
                <ul className={styles.choices}>
                  {choices.map((candidate) => (
                    <li key={tableKey(candidate)}>
                      <button type="button" className={styles.choice} onClick={() => void pick(candidate.database, candidate.name)}>
                        <span className={styles.dim}>{candidate.database}.</span>
                        {candidate.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          <div className={styles.board} ref={boardRef} onPointerMove={onBoardPointerMove} onPointerUp={() => setDrag(null)}>
            <Connectors board={boardRef} nodes={bandNodes.current} links={links} live={liveWire} />
            {joinedTables(def).map((entry2) => {
              const step = def.joins.find((candidate) => candidate.alias === entry2.alias);
              const output = new Set(def.output[entry2.alias] ?? []);
              const keys = keysOf(def, entry2.alias);
              const band = bandRowsFor(def, entry2.alias, suggestedKeys, removeOnePair);
              return (
                <TableCard
                  key={entry2.alias}
                  alias={entry2.alias}
                  table={entry2.table}
                  kind={step?.kind}
                  keys={keys}
                  output={output}
                  band={band}
                  armed={effectiveArmed}
                  announce={announce}
                  onArm={setArmed}
                  onPairWith={(ref) => {
                    if (!armed) return;
                    pairFromCard(armed, ref);
                    setArmed(null);
                  }}
                  onToggleOutput={(column) =>
                    mutate((current) => {
                      const next = new Set(current.output[entry2.alias] ?? []);
                      if (next.has(column)) next.delete(column);
                      else next.add(column);
                      return setOutput(
                        current,
                        entry2.alias,
                        entry2.table.columns.map((c) => c.name).filter((name) => next.has(name)),
                      );
                    })
                  }
                  onSetOutput={(columns) => mutate((current) => setOutput(current, entry2.alias, columns))}
                  onSetKind={step ? (kind: JoinKind) => mutate((current) => setKind(current, entry2.alias, kind)) : undefined}
                  onRemoveTable={step ? () => mutate((current) => removeTable(current, entry2.alias)) : undefined}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  registerBandNode={registerBandNode}
                />
              );
            })}
          </div>

          <div className={styles.instrument}>
            <CheckJoinCard state={def.joins.length === 0 ? "unavailable" : checkState} results={checkResults} language={i18n.language} onCheck={checkJoin} />
            <SqlReceipt built={built} busy={busy} onRun={runJoin} onOpenInEditor={() => (built.ok ? onOpenInEditor(built.sql) : undefined)} />
          </div>
        </div>
      ) : null}

      {collapsed ? (
        <div className={styles.resultArea}>
          <ResultPane state={session.state} buffer={session.resource} fields={null} stats={null} shown="join" preferences={preferences} />
        </div>
      ) : null}
    </div>
  );
}
