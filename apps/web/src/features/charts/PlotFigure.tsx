import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PlotOptions } from "@observablehq/plot";
import type { Plot } from "./plot-theme";
import styles from "./PlotFigure.module.css";

export interface PlotFigureProps<Datum> {
  /** What the chart shows and a one-line summary of it, for people who cannot see it. */
  readonly label: string;
  readonly description: string;
  readonly data: readonly Datum[];
  /** Builds the chart. `active` is the datum picked with the keyboard, to be drawn in ink. Must be stable between renders. */
  build(plot: Plot, active: Datum | null): PlotOptions;
  /** One line that says everything about a datum: shown under the chart for pointer and keyboard alike. */
  describe(datum: Datum): string;
  /** `vertical` charts step with ←/→, `horizontal` ones with ↑/↓. */
  readonly orientation?: "vertical" | "horizontal";
}

/**
 * One Observable Plot chart. The library loads on demand, so it costs nothing until a chart is asked for.
 * Plot's own pointer cannot be reached by keyboard, so the figure is focusable and the arrow keys walk the data;
 * both feed the same read-out line.
 */
export function PlotFigure<Datum>({ label, description, data, build, describe, orientation = "vertical" }: PlotFigureProps<Datum>) {
  const host = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [pointed, setPointed] = useState<Datum | null>(null);
  const active = index === null ? null : (data[index] ?? null);

  useEffect(() => {
    let cancelled = false;
    let chart: (Element & { value?: unknown }) | null = null;
    const onInput = () => setPointed((chart?.value as Datum | null | undefined) ?? null);
    void import("@observablehq/plot")
      .then((plot) => {
        if (cancelled || !host.current) return;
        chart = plot.plot({ ...build(plot, active), ariaLabel: label, ariaDescription: description });
        chart.addEventListener("input", onInput);
        host.current.replaceChildren(chart);
      })
      // A chart that cannot be drawn leaves the figures, which are always in the table beside it.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      chart?.removeEventListener("input", onInput);
      chart?.remove();
    };
  }, [build, active, label, description]);

  const [back, forward] = orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const last = data.length - 1;
    const targets: Record<string, number | null> = {
      [back]: Math.max((index ?? 1) - 1, 0),
      [forward]: Math.min((index ?? -1) + 1, last),
      Home: 0,
      End: last,
      Escape: null,
    };
    if (!(event.key in targets) || last < 0) return;
    event.preventDefault();
    setIndex(targets[event.key] ?? null);
  };

  const shown = active ?? pointed;
  return (
    <div className={styles.figure}>
      <div ref={host} role="group" tabIndex={0} aria-label={label} className={styles.plot} onKeyDown={onKeyDown} onBlur={() => setIndex(null)} />
      <p aria-live="polite" className={styles.readout}>
        {shown ? describe(shown) : null}
      </p>
    </div>
  );
}
