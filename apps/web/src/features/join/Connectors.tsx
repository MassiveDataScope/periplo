import { useEffect, useState, type RefObject } from "react";
import type { TypeFamily } from "@periplo/core/ui";
import styles from "./JoinWorkspace.module.css";

export interface ConnectorLink {
  readonly id: string;
  readonly fromKey: string;
  readonly toKey: string;
  readonly family: TypeFamily;
  readonly suggested: boolean;
}

export interface LiveWire {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly family: TypeFamily | null;
}

export interface ConnectorsProps {
  readonly board: RefObject<HTMLDivElement | null>;
  /** Every band row's DOM node, keyed `alias:column`, kept live by the cards themselves. */
  readonly nodes: ReadonlyMap<string, HTMLElement>;
  readonly links: readonly ConnectorLink[];
  /** The wire being dragged right now, in viewport coordinates; absent when nothing is being dragged. */
  readonly live: LiveWire | null;
}

interface Path {
  readonly id: string;
  readonly d: string;
  readonly family: TypeFamily;
  readonly suggested: boolean;
}

/** A quadratic arch between two points: flat for neighbours, taller the further apart they sit. */
function arch(x1: number, y1: number, x2: number, y2: number): string {
  const lift = Math.min(90, Math.abs(x2 - x1) * 0.3 + Math.abs(y2 - y1) * 0.2);
  const midY = (y1 + y2) / 2 - lift;
  return `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${midY} ${x2} ${y2}`;
}

/**
 * The decorative overlay R4 asks for: one arch per pair between the two band rows it joins (family
 * colour, dashed while it came from a suggestion, solid once touched), plus the wire a drag is drawing
 * right now. Entirely `aria-hidden`: the band and the Pairs list are the accessible truth (R10).
 */
export function Connectors({ board, nodes, links, live }: ConnectorsProps) {
  const [paths, setPaths] = useState<readonly Path[]>([]);

  useEffect(() => {
    const recompute = () => {
      const boardEl = board.current;
      if (!boardEl) return;
      const boardRect = boardEl.getBoundingClientRect();
      const next: Path[] = [];
      for (const link of links) {
        const from = nodes.get(link.fromKey);
        const to = nodes.get(link.toKey);
        if (!from || !to) continue;
        const a = from.getBoundingClientRect();
        const b = to.getBoundingClientRect();
        const leftToRight = a.left <= b.left;
        const x1 = (leftToRight ? a.right : a.left) - boardRect.left + boardEl.scrollLeft;
        const y1 = a.top + a.height / 2 - boardRect.top + boardEl.scrollTop;
        const x2 = (leftToRight ? b.left : b.right) - boardRect.left + boardEl.scrollLeft;
        const y2 = b.top + b.height / 2 - boardRect.top + boardEl.scrollTop;
        next.push({ id: link.id, d: arch(x1, y1, x2, y2), family: link.family, suggested: link.suggested });
      }
      setPaths(next);
    };
    recompute();
    const boardEl = board.current;
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(recompute) : null;
    if (boardEl && observer) observer.observe(boardEl);
    boardEl?.addEventListener("scroll", recompute);
    window.addEventListener("resize", recompute);
    return () => {
      observer?.disconnect();
      boardEl?.removeEventListener("scroll", recompute);
      window.removeEventListener("resize", recompute);
    };
  }, [links, nodes, board]);

  const liveD = (() => {
    if (!live) return null;
    const boardEl = board.current;
    if (!boardEl) return null;
    const boardRect = boardEl.getBoundingClientRect();
    const x1 = live.x1 - boardRect.left + boardEl.scrollLeft;
    const y1 = live.y1 - boardRect.top + boardEl.scrollTop;
    const x2 = live.x2 - boardRect.left + boardEl.scrollLeft;
    const y2 = live.y2 - boardRect.top + boardEl.scrollTop;
    return arch(x1, y1, x2, y2);
  })();

  return (
    <svg aria-hidden="true" focusable="false" className={styles.connectors}>
      {paths.map((path) => (
        <path key={path.id} d={path.d} data-family={path.family} data-suggested={path.suggested} className={styles.connector} />
      ))}
      {liveD ? <path d={liveD} data-family={live?.family ?? "nested"} className={styles.liveWire} /> : null}
    </svg>
  );
}
