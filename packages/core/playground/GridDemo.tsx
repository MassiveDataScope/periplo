import { useMemo, useRef, useState } from "react";
import { tableFromArrays, type RecordBatch } from "apache-arrow";
import { createResultBuffer, type ResultBuffer } from "../src/arrow";
import { ResultsGrid, type GridStatusInput } from "../src/grid";
import { Button, Panel } from "../src/ui";
import styles from "./playground.module.css";

const COLUMNS = 200;
const BATCH_ROWS = 10_000;
const BATCHES = 10;

declare global {
  interface Window {
    /** Test hook: how many cells the grid asked the buffer to format. */
    __cellCalls: number;
  }
}

/** Narrow types on purpose: 100,000 × 200 int64 columns would be ~160 MiB, over the default budget. */
function syntheticBatch(batchIndex: number): RecordBatch {
  const columns: Record<string, BigInt64Array | Int8Array | (string | null)[]> = {
    id: BigInt64Array.from({ length: BATCH_ROWS }, (_, row) => 9007199254740993n + BigInt(batchIndex * BATCH_ROWS + row)),
    note: Array.from({ length: BATCH_ROWS }, (_, row) => (row % 7 === 0 ? null : row % 11 === 0 ? "long ".repeat(80) : `row ${row}`)),
  };
  for (let column = 2; column < COLUMNS; column++) {
    columns[`c${column}`] = Int8Array.from({ length: BATCH_ROWS }, (_, row) => (row + column) % 127);
  }
  const batch = tableFromArrays(columns).batches[0];
  if (!batch) throw new Error("synthetic table has no batch");
  return batch;
}

function countingBuffer(buffer: ResultBuffer): ResultBuffer {
  const cell = buffer.cell;
  buffer.cell = (row, column) => {
    window.__cellCalls = (window.__cellCalls ?? 0) + 1;
    return cell(row, column);
  };
  return buffer;
}

export function GridDemo() {
  const buffer = useMemo(() => countingBuffer(createResultBuffer()), []);
  const [status, setStatus] = useState<GridStatusInput>({ kind: "idle" });
  const timer = useRef<number | undefined>(undefined);

  function load(delayMs: number, outcome: GridStatusInput) {
    window.clearInterval(timer.current);
    const first = syntheticBatch(0);
    buffer.open(first.schema);
    buffer.push(first);
    setStatus({ kind: "running" });
    let next = 1;
    const step = () => {
      if (next >= BATCHES) {
        window.clearInterval(timer.current);
        buffer.close(outcome.kind === "complete" ? "complete" : "incomplete");
        return setStatus(outcome);
      }
      buffer.push(syntheticBatch(next++));
    };
    if (delayMs === 0) {
      while (next < BATCHES) step();
      step();
    } else {
      timer.current = window.setInterval(step, delayMs);
    }
  }

  return (
    <Panel
      title="Results grid"
      actions={
        <>
          <Button onClick={() => load(0, { kind: "complete" })}>Load 100k × 200</Button>
          <Button onClick={() => load(250, { kind: "complete" })}>Stream slowly</Button>
          <Button onClick={() => load(0, { kind: "incomplete", message: "connection lost" })}>Partial</Button>
        </>
      }
    >
      <div className={styles.gridHost}>
        <ResultsGrid buffer={buffer} status={status} />
      </div>
    </Panel>
  );
}
