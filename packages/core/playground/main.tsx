import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import "../src/ui/fonts.css";
import "../src/ui/tokens.css";
import { Button, EmptyState, ErrorNotice, Panel, Progress, StatusBar, TabPanel, Tabs, applyTheme, getStoredTheme, type Theme } from "../src/ui";
import { GridDemo } from "./GridDemo";
import styles from "./playground.module.css";

const THEMES: readonly Theme[] = ["system", "light", "dark"];
const TABS = [
  { id: "data", label: "Data" },
  { id: "distribution", label: "Distribution" },
  { id: "history", label: "History" },
];

function Playground() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);
  const [tab, setTab] = useState("data");

  return (
    <main className={styles.page}>
      <div className={styles.toolbar}>
        <h1 className={styles.heading}>Periplo core playground</h1>
        <div className={styles.row} role="group" aria-label="Theme">
          {THEMES.map((option) => (
            <Button
              key={option}
              aria-pressed={theme === option}
              variant={theme === option ? "primary" : "secondary"}
              onClick={() => {
                applyTheme(option);
                setTheme(option);
              }}
            >
              {option}
            </Button>
          ))}
        </div>
      </div>

      <GridDemo />

      <Panel title="Tabs">
        <Tabs label="Table sections" tabs={TABS} selected={tab} onSelect={setTab} />
        <TabPanel tab={tab}>
          <p>Content of the {tab} tab.</p>
        </TabPanel>
      </Panel>

      <Panel title="Buttons" actions={<Button>Panel action</Button>}>
        <div className={styles.row}>
          <Button variant="primary">Run query</Button>
          <Button>Secondary</Button>
          <Button variant="danger">Cancel</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </div>
      </Panel>

      <Panel title="Status and progress">
        <div className={styles.stack}>
          <StatusBar label="Idle status" items={[{ label: "State", value: "idle" }]} />
          <StatusBar
            label="Completed status"
            tone="success"
            items={[
              { label: "State", value: "completed" },
              { label: "Rows", value: "100,000" },
              { label: "Bytes", value: "12.4 MiB" },
              { label: "orders", value: "v4" },
            ]}
          />
          <StatusBar label="Truncated status" tone="warning" items={[{ label: "State", value: "truncated at 100,000 rows" }]} />
          <StatusBar label="Failed status" tone="danger" items={[{ label: "State", value: "failed" }]} />
          <Progress label="Running query" />
        </div>
      </Panel>

      <Panel title="Errors">
        <div className={styles.stack}>
          <ErrorNotice
            title="Query rejected"
            error={{
              code: "rule_violations",
              message: "The request is not valid.",
              traceId: "7f3c2a9e-trace",
              violations: [{ field: "sql", message: "Only read queries are allowed" }],
            }}
          />
          <ErrorNotice error={{ code: "capacity", message: "Two queries are already running." }} onRetry={() => undefined} />
        </div>
      </Panel>

      <Panel title="Empty state">
        <EmptyState title="No results yet" description="Run a query to see rows here." />
      </Panel>
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing playground root");
createRoot(root).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
