// Development-only stand-in for the Periplo API: the query, catalog and ETL endpoints, with the same
// shapes and error codes. It exists so the UI can be exercised without a lake or an orchestrator; it is
// never part of an image. Run it with `node apps/web/dev/mock-api.mjs` (port 8765, or $PORT).
import http from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Int32, Int64, RecordBatchStreamWriter, Table, Utf8, vectorFromArray } from "apache-arrow";

const PORT = Number(process.env.PORT ?? 8765);
const BATCH_ROWS = 2_000;
const REDISCOVERY_MS = 4_000;
const RUN_LOG_EVERY_MS = 2_000;
const RUN_DURATION_MS = 20_000;
const ETL_UI_URL = "https://prefect.example";

// The catalog comes from static fixtures: discovery logic lives in the API, not here.
const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const CATALOGS = { before: fixture("catalog.before.json"), after: fixture("catalog.after.json") };
const SOURCES = fixture("sources.json").sources;
const TABLE_META = fixture("table-meta.json");
let catalog = CATALOGS.before;
let discovery = { state: "idle", started_at: null };

const FIELDS = [
  { name: "order_id", type: "int64", nullable: false },
  { name: "customer_id", type: "int32", nullable: false },
  { name: "note", type: "utf8", nullable: true },
];
const findTable = (database, name) => catalog.tables.find((table) => table.database === database && table.name === name);

const queries = new Map();

// ETL: deployments and runs from etl.json (written by fixtures/generate-etl.mjs, a fictional shop); a
// RUNNING run gains a log line and a growing task tree every 2 s and completes after 20 s. Task trees,
// per-step facts and step logs are pre-built for a handful of curated runs (a 20-process run, a
// missing process marker, 3 attempts, CRASHED/INTERRUPTED, one still RUNNING); every other run gets a
// small generic tree built on first request and cached, so every route works for every run.
const ETL = fixture("etl.json");
const LEVEL_NAMES = { 10: "DEBUG", 20: "INFO", 30: "WARNING", 40: "ERROR", 50: "CRITICAL" };
const TERMINAL_STATES = new Set(["COMPLETED", "FAILED", "CANCELLED", "CRASHED"]);
// Log lines starting with one of these prefixes are flagged as noise, as the API does with
// PERIPLO_ETL_LOG_NOISE (comma-separated, trimmed, empty entries dropped). Empty by default, like the API.
const LOG_NOISE_PREFIXES = (process.env.PERIPLO_ETL_LOG_NOISE ?? "")
  .split(",")
  .map((prefix) => prefix.trim())
  .filter((prefix) => prefix.length > 0);
const SUMMARY_WINDOW_MS = 24 * 60 * 60 * 1000;

function logEntry(timestamp, level, message) {
  const noise = LOG_NOISE_PREFIXES.some((prefix) => message.startsWith(prefix));
  return { id: randomUUID(), timestamp, level, level_name: LEVEL_NAMES[level], message, noise };
}

/**
 * The fixture is generated against a fixed anchor, so on its own it ages: after a few days nothing would have
 * run in the last 24 h. The whole fixture (runs, curated task trees and logs) moves by the same amount, so the
 * latest run ended 5 minutes before the mock started. Relative order and spacing are unchanged; the time of day
 * of past runs no longer matches their cron, which a demo can live with.
 */
const REBASE_GAP_MS = 5 * 60 * 1000;
const TIME_KEYS = new Set(["expected_start_at", "start_at", "end_at", "started_at", "ended_at", "timestamp"]);
function shiftTimes(value, deltaMs) {
  if (Array.isArray(value)) return value.forEach((item) => shiftTimes(item, deltaMs));
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (TIME_KEYS.has(key) && typeof item === "string") value[key] = new Date(Date.parse(item) + deltaMs).toISOString();
    else shiftTimes(item, deltaMs);
  }
}
function rebaseToNow(etl) {
  const latest = Math.max(...etl.runs.map((run) => Date.parse(run.end_at ?? run.start_at)).filter(Number.isFinite));
  if (!Number.isFinite(latest)) return;
  const deltaMs = Date.now() - REBASE_GAP_MS - latest;
  for (const part of [etl.runs, etl.tasks, etl.logs]) shiftTimes(part, deltaMs);
}
rebaseToNow(ETL);

const etlRuns = ETL.runs.map((run) => ({ ...run }));
const findDeployment = (name) => ETL.deployments.find((deployment) => deployment.name === name);
const deploymentById = (id) => ETL.deployments.find((deployment) => deployment.id === id);
// Archived ETLs, by name, as the API's open-core store keeps them: in memory, gone on restart. Nothing changes in the
// "orchestrator" (the fixture); the list marks them and counts over the active ones alone.
const archives = new Map();
const activeDeployments = () => ETL.deployments.filter((deployment) => !archives.has(deployment.name));
// START_TIME_DESC with the scheduled runs (no start_at) last, as the orchestrator sorts them.
const byStartDesc = (a, b) => (a.start_at && b.start_at ? b.start_at.localeCompare(a.start_at) : Number(!a.start_at) - Number(!b.start_at));
const byStartAsc = (a, b) => (a.start_at && b.start_at ? a.start_at.localeCompare(b.start_at) : Number(!a.start_at) - Number(!b.start_at));
const runsOf = (deploymentId) => etlRuns.filter((run) => run.deployment_id === deploymentId).sort(byStartDesc);

// ---- chained ETLs: "when X completes, run Y" automations ------------------
// respondio_messages_daily (on a schedule) → respondio_message_nlp_daily → customer_conversations_model_daily,
// each link passing its window (updated_at_from/updated_at_to). A run an automation created carries the
// mock-only `automation_id`. Yesterday the last link did not run after its upstream completed (the console says
// it didn't run); today the middle link completed ten minutes ago and the last has not started yet.
const DAY_MS = 24 * 60 * 60 * 1000;
const CHAIN_PASSES = ["updated_at_from", "updated_at_to"];
const CHAIN_DESCRIPTIONS = [
  "Pulls the day's Respond.io conversations and messages.",
  "Classifies each new message: language, intent and sentiment.",
  "Rebuilds the customer conversations model from the classified messages.",
];
const chainDeployments = ["respondio_messages_daily", "respondio_message_nlp_daily", "customer_conversations_model_daily"].map((name, index) => ({
  id: randomUUID(),
  name,
  flow_name: name,
  description: CHAIN_DESCRIPTIONS[index],
  paused: false,
  schedule: index === 0 ? { kind: "cron", cron: "0 3 * * *", interval_seconds: null, timezone: "UTC", active: true } : null,
  parameters: index === 2 ? { updated_at_from: "${yesterday}", updated_at_to: "${today}", mode: "full" } : { updated_at_from: "${yesterday}", updated_at_to: "${today}" },
  tags: ["team:conversations", "cadence:daily", "source:respondio"],
}));
ETL.deployments.push(...chainDeployments);

// The mock speaks an installation of its own: its tags use prefixes no other installation need share (owner:, system:,
// writes:, tier:, domain:, every:) and a few free labels, which proves the console knows none of them in advance.
const MOCK_PREFIXES = { team: "owner", source: "system", target: "writes", stage: "domain", cadence: "every" };
const MOCK_TIERS = ["gold", "silver", "bronze"];
const MOCK_LABELS = { customer_facts_daily: ["pii"], returns_reconciliation_daily: ["pii", "finance"], orders_snapshot_daily: ["finance"] };
ETL.deployments.forEach((deployment, index) => {
  const prefixOf = (tag) => tag.slice(0, tag.indexOf(":"));
  deployment.tags = [
    ...deployment.tags
      .filter((tag) => tag.includes(":") && MOCK_PREFIXES[prefixOf(tag)] !== undefined)
      .map((tag) => `${MOCK_PREFIXES[prefixOf(tag)]}:${tag.slice(tag.indexOf(":") + 1)}`),
    `tier:${MOCK_TIERS[index % MOCK_TIERS.length]}`,
    ...(MOCK_LABELS[deployment.name] ?? []),
  ];
});
// How this installation names its facets (as PERIPLO_ETL_FACETS would say it): labels, an order, lineage roles, and the
// values that mean an ETL should be scheduled.
const MOCK_FACETS = {
  system: { label: "Source system", order: 1, hidden: false, role: "reads", values: null },
  writes: { label: "Writes to", order: 2, hidden: false, role: "writes", values: null },
  owner: { label: "Owner", order: 3, hidden: false, role: null, values: null },
  every: { label: "Runs", order: 4, hidden: false, role: "expects_schedule", values: ["daily", "hourly"] },
};
// The last link also sets a constant of its own, which its card and its runs show as "set by the automation".
const CHAIN_LINKS = chainDeployments.slice(1).map((downstream, index) => ({
  automationId: randomUUID(),
  automationName: `${downstream.name}__automation_1`,
  upstream: chainDeployments[index],
  downstream,
  sets: index === chainDeployments.length - 2 ? { mode: "incremental" } : {},
}));
const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10);
function seedChainRun(deployment, startMs, minutes, parameters, link) {
  const start = new Date(startMs).toISOString();
  const run = {
    id: randomUUID(),
    deployment_id: deployment.id,
    name: `${deployment.name.split("_")[0]}-${Math.random().toString(36).slice(2, 8)}`,
    state: "COMPLETED",
    state_message: "All states completed.",
    expected_start_at: start,
    start_at: start,
    end_at: new Date(startMs + minutes * 60_000).toISOString(),
    duration_seconds: minutes * 60,
    created_by: link ? link.automationName : "prefect-scheduler",
    automation_id: link ? link.automationId : null,
    run_count: 1,
    retries: 0,
    retry_delay_seconds: 0,
    parameters,
  };
  etlRuns.push(run);
  return run;
}
for (let day = 6; day >= 0; day -= 1) {
  // Today's chain started 32 minutes ago: its middle link (9 + 1 + 12 minutes) completed ten minutes ago.
  const startMs = day === 0 ? Date.now() - 32 * 60_000 : Date.now() - day * DAY_MS - 3 * 60 * 60 * 1000;
  const parameters = { updated_at_from: dateOnly(startMs - DAY_MS), updated_at_to: dateOnly(startMs) };
  let previous = seedChainRun(chainDeployments[0], startMs, 9, parameters, null);
  for (const link of CHAIN_LINKS) {
    if (day <= 1 && link === CHAIN_LINKS.at(-1)) break;
    const runParameters = { ...link.downstream.parameters, ...parameters, ...link.sets };
    previous = seedChainRun(link.downstream, Date.parse(previous.end_at) + 60_000, 12 + 4 * CHAIN_LINKS.indexOf(link), runParameters, link);
  }
}
const chainTriggerOf = (deployment) => {
  const link = CHAIN_LINKS.find((candidate) => candidate.downstream.id === deployment.id);
  return link ? { etl: link.upstream.name, on: "completed", passes: [...CHAIN_PASSES], sets: { ...link.sets } } : null;
};
const chainTriggersOf = (deployment) =>
  CHAIN_LINKS.filter((link) => link.upstream.id === deployment.id)
    .map((link) => link.downstream.name)
    .sort();
const runLinkOf = (run) => ({ etl: deploymentById(run.deployment_id)?.name ?? run.deployment_id, run_id: run.id, run_name: run.name });
// As the API reads it: the upstream's newest run completed before this one, preferring one with the same window.
function triggeredByRunOf(run) {
  const link = CHAIN_LINKS.find((candidate) => candidate.automationId === run.automation_id);
  if (!link) return null;
  const candidates = runsOf(link.upstream.id).filter((up) => up.state === "COMPLETED" && up.end_at && up.end_at <= run.expected_start_at);
  const same = candidates.find((up) => CHAIN_PASSES.every((name) => up.parameters?.[name] === run.parameters?.[name]));
  const chosen = same ?? candidates[0];
  return chosen ? runLinkOf(chosen) : null;
}
// Each downstream ETL's first run its automation created after this one ended.
function triggeredRunsOf(run) {
  if (run.state !== "COMPLETED" || !run.end_at) return [];
  return CHAIN_LINKS.filter((link) => link.upstream.id === run.deployment_id).flatMap((link) => {
    const started = runsOf(link.downstream.id)
      .filter((down) => down.automation_id === link.automationId && down.expected_start_at >= run.end_at)
      .sort(byStartAsc)[0];
    return started ? [runLinkOf(started)] : [];
  });
}
const FLOW_RUN_KEYS = [
  "id",
  "name",
  "state",
  "state_message",
  "expected_start_at",
  "start_at",
  "end_at",
  "duration_seconds",
  "created_by",
  "run_count",
  "retries",
  "retry_delay_seconds",
];
// `FlowRun.attempts`/`RecentRun.attempts`: one entry per attempt, from the
// same task tree `tasksOf` already builds (curated or generic) for `run_count` > 1; `null`
// otherwise. `tasksOf` is a function declaration (hoisted), defined further down.
function flowRunAttempts(run) {
  if (!run.run_count || run.run_count <= 1) return null;
  // A demo run that says how its attempts went, as Prefect's state history would.
  if (run.__attempts) return run.__attempts;
  return tasksOf(run).attempts.map((attempt) => ({
    index: attempt.number,
    start_at: attempt.started_at,
    end_at: attempt.ended_at,
    state: attempt.state,
    duration_seconds: attempt.ended_at ? Math.round((Date.parse(attempt.ended_at) - Date.parse(attempt.started_at)) / 10) / 100 : null,
  }));
}
// A deep link into the orchestrator's own UI, mirroring the real adapter's `_run_url`/`_deployment_url`.
const runUrl = (id) => `${ETL_UI_URL}/runs/flow-run/${id}`;
const deploymentUrl = (id) => `${ETL_UI_URL}/deployments/deployment/${id}`;

// When the run's current (or last) attempt started, as the API's `attempt_started_at`: a run retried from Prefect's
// UI keeps its first start as `start_at`, and waits for its next attempt with none.
const attemptStartOf = (run) => (run.attempt_started_at !== undefined ? run.attempt_started_at : run.start_at);
// Since when it has waited for its current attempt, as the API's `waiting_since`: a retried run waiting again since its
// retry (Prefect keeps its first expected start), any other since it was due.
const waitingSinceOf = (run) => (attemptStartOf(run) === null && run.start_at !== null ? (run.state_since ?? run.expected_start_at) : run.expected_start_at);

function flowRun(run) {
  const base = Object.fromEntries(FLOW_RUN_KEYS.map((key) => [key, run[key]]));
  const scheduled = run.created_by === "prefect-scheduler";
  const trigger = run.automation_id ? "automation" : scheduled ? "scheduled" : "manual";
  // As the API: an automation's name is never sent as a run's creator (it can name a hidden upstream ETL).
  const created_by = run.automation_id ? null : base.created_by;
  return {
    ...base,
    attempt_started_at: attemptStartOf(run),
    waiting_since: waitingSinceOf(run),
    created_by,
    trigger,
    external_url: runUrl(run.id),
    attempts: flowRunAttempts(run),
  };
}
const lastRunOf = (deploymentId) => runsOf(deploymentId).find((run) => run.state !== "SCHEDULED");
const recentOf = (deploymentId) =>
  runsOf(deploymentId)
    .filter((run) => run.state !== "SCHEDULED")
    .sort(byStartAsc)
    .slice(-12)
    .map((run) => ({
      id: run.id,
      state: run.state,
      run_count: run.run_count || 1,
      expected_start_at: run.expected_start_at,
      start_at: run.start_at,
      attempt_started_at: attemptStartOf(run),
      end_at: run.end_at,
      attempts: flowRunAttempts(run),
    }));

// A simplification of the API's next_run_at: an interval fires at the next multiple of its length (from
// the epoch); a cron is read only for its minute/hour, returning the next occurrence of that time of day and
// ignoring day-of-week/day-of-month fields (the real API uses croniter for the exact schedule).
function nextRunAt(schedule, paused) {
  if (!schedule || !schedule.active || paused) return null;
  if (schedule.kind === "interval" && schedule.interval_seconds > 0) {
    const everyMs = schedule.interval_seconds * 1000;
    return new Date((Math.floor(Date.now() / everyMs) + 1) * everyMs).toISOString();
  }
  if (schedule.kind !== "cron") return null;
  const [minute, hour] = schedule.cron.split(" ").map(Number);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  const next = new Date();
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(minute);
  next.setUTCHours(hour);
  if (next <= new Date()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

const etlOf = (deployment) => {
  const schedule_inactive = Boolean(deployment.schedule && !deployment.schedule.active && !deployment.paused);
  return {
    id: deployment.id,
    name: deployment.name,
    flow_name: deployment.flow_name,
    description: deployment.description,
    tags: deployment.tags,
    paused: deployment.paused,
    schedule: deployment.schedule,
    parameters: deployment.parameters,
    last_run: lastRunOf(deployment.id) ? flowRun(lastRunOf(deployment.id)) : null,
    recent: recentOf(deployment.id),
    next_run_at: nextRunAt(deployment.schedule, deployment.paused),
    schedule_inactive,
    accepts_processes: Object.hasOwn(deployment.parameters, "processes"),
    external_url: deploymentUrl(deployment.id),
    triggered_by: chainTriggerOf(deployment),
    triggers: chainTriggersOf(deployment),
    archived: archives.get(deployment.name) ?? null,
  };
};

function summaryOf() {
  const deploymentIds = new Set(activeDeployments().map((deployment) => deployment.id));
  const since = Date.now() - SUMMARY_WINDOW_MS;
  const recent24h = etlRuns.filter((run) => deploymentIds.has(run.deployment_id) && run.end_at && Date.parse(run.end_at) >= since);
  // As the API counts it: ETLs with a run that has started (RUNNING, or PENDING with a start time).
  const going = (run) => run.state === "RUNNING" || (run.start_at !== null && (run.state === "PENDING" || run.state === "SCHEDULED"));
  const running = activeDeployments().filter((deployment) => etlRuns.some((run) => run.deployment_id === deployment.id && going(run))).length;
  const failed_24h = Math.min(200, recent24h.filter((run) => run.state === "FAILED" || run.state === "CRASHED").length);
  const completed_24h = Math.min(200, recent24h.filter((run) => run.state === "COMPLETED").length);
  return { running, failed_24h, completed_24h };
}

const runDetail = (run) => {
  const deployment = deploymentById(run.deployment_id);
  return {
    ...flowRun(run),
    parameters: run.parameters,
    deployment_id: run.deployment_id,
    deployment_name: deployment?.name ?? null,
    flow_name: deployment?.flow_name ?? run.name,
    terminal: TERMINAL_STATES.has(run.state),
    // When it entered its state, as Prefect's state timestamp: set by a change the mock makes, else its last moment.
    state_since: run.state_since ?? run.end_at ?? run.start_at ?? run.expected_start_at ?? null,
    triggered_by_run: triggeredByRunOf(run),
    triggered_runs: triggeredRunsOf(run),
  };
};

// ---- task trees (attempts › processes › steps), step facts and step logs --------------------

// logsStore: run id -> { flow: LogEntry[], tasks: Map(task_run_id -> LogEntry[]) }
// tasksStore: run id -> RunTasks, with the internal-only reads/writes/rows/delta_version kept on
// each Step so /etl/runs/{id}/steps/{task_run} can answer without re-deriving facts from text.
// stepIndex: task_run_id -> { step, runId } for every step (not process) task run, fixture or generic.
const logsStore = new Map();
const tasksStore = new Map();
const stepIndex = new Map();

function toLogEntries(lines) {
  return lines.map((line) => logEntry(line.timestamp, line.level, line.message));
}
for (const [runId, { flow, tasks }] of Object.entries(ETL.logs)) {
  logsStore.set(runId, { flow: toLogEntries(flow), tasks: new Map(Object.entries(tasks).map(([taskRunId, lines]) => [taskRunId, toLogEntries(lines)])) });
}

function registerSteps(runId, runTasks) {
  for (const attempt of runTasks.attempts) {
    for (const process of attempt.processes) {
      for (const step of process.steps) {
        if (step.task_run_id) stepIndex.set(step.task_run_id, { step, processName: process.name, runId });
      }
    }
  }
}
for (const [runId, runTasks] of Object.entries(ETL.tasks)) {
  tasksStore.set(runId, runTasks);
  registerSteps(runId, runTasks);
}

// Public Step shape only: drops the reads/writes/rows/delta_version kept internally for StepFacts.
const STEP_KEYS = ["name", "task_run_id", "state", "start_at", "end_at", "duration_seconds"];
const TRY_KEYS = ["index", "task_run_id", "state", "start_at", "end_at", "duration_seconds"];
// `tries` as the API sends it: each try of a step started again after failing, or null for a step that ran once.
const publicStep = (step) => ({
  ...Object.fromEntries(STEP_KEYS.map((key) => [key, step[key]])),
  tries: step.tries ? step.tries.map((attempt) => Object.fromEntries(TRY_KEYS.map((key) => [key, attempt[key]]))) : null,
});
const publicTasks = (runTasks) => ({
  attempts: runTasks.attempts.map((attempt) => ({ ...attempt, processes: attempt.processes.map((process) => ({ ...process, steps: process.steps.map(publicStep) })) })),
  expected_steps_known: runTasks.expected_steps_known,
});

// ---- dashboard: "Running now" and the activity history ----------------------------------------

const RUNNING_LIMIT = 20;
const HISTORY_1H_BUCKETS = 24;
const HISTORY_7D_BUCKETS = 7;
const UPCOMING_WINDOW_MS = 6 * 60 * 60 * 1000;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// Median duration of a deployment's COMPLETED `recent` entries, mirroring the API's
// `_typical_seconds`; a `__typical_override` on the run itself (demo runs only) wins.
function typicalSecondsOf(deploymentId) {
  const durations = recentOf(deploymentId)
    .filter((run) => run.state === "COMPLETED" && run.start_at && run.end_at)
    .map((run) => (Date.parse(run.end_at) - Date.parse(run.start_at)) / 1000);
  return median(durations);
}
// The running run's current process/step, its 1-based position, and processes-so-far,
// mirroring `tasks.current_process`: the process with the latest RUNNING step wins,
// falling back to the last process opened.
function currentOf(run) {
  const processes = tasksStore.get(run.id)?.attempts.at(-1)?.processes ?? [];
  if (processes.length === 0) return null;
  let index = processes.findLastIndex((process) => process.state === "RUNNING");
  if (index === -1) index = processes.length - 1;
  const process = processes[index];
  const step = [...process.steps].reverse().find((s) => s.state === "RUNNING") ?? null;
  return { process: process.name, step: step?.name ?? null, index: index + 1, total: processes.length };
}
// As the API: an archived ETL's live runs stay in the list (its own page reads them); only the counts leave it out.
function runningRunsOf() {
  const running = etlRuns.filter((run) => run.state === "RUNNING" || run.state === "PENDING").sort(byStartDesc);
  const capped = running.slice(0, RUNNING_LIMIT);
  return {
    running: capped.map((run) => ({
      id: run.id,
      name: run.name,
      etl: deploymentById(run.deployment_id)?.name ?? run.deployment_id,
      state: run.state,
      start_at: run.start_at,
      attempt_started_at: attemptStartOf(run),
      expected_start_at: run.expected_start_at,
      waiting_since: waitingSinceOf(run),
      created_by: run.automation_id ? null : run.created_by,
      trigger: run.automation_id ? "automation" : run.created_by === "prefect-scheduler" ? "scheduled" : "manual",
      current: currentOf(run),
      typical_seconds: Object.hasOwn(run, "__typical_override") ? run.__typical_override : typicalSecondsOf(run.deployment_id),
    })),
    running_truncated: running.length > RUNNING_LIMIT,
  };
}
// SCHEDULED runs due within 6h are not in the fixture (it has none): derived from each
// active, unpaused schedule the same way `nextRunAt` does, one fire per deployment.
function upcomingOf(deploymentIds) {
  const now = Date.now();
  return ETL.deployments
    .filter((deployment) => deploymentIds.has(deployment.id))
    .map((deployment) => ({ etl: deployment.name, expected_start_at: nextRunAt(deployment.schedule, deployment.paused) }))
    .filter((entry) => entry.expected_start_at && Date.parse(entry.expected_start_at) - now <= UPCOMING_WINDOW_MS)
    .sort((a, b) => a.expected_start_at.localeCompare(b.expected_start_at))
    .slice(0, 50);
}
function historyOf(interval, bucketMs, bucketCount, deploymentIds, upcoming) {
  const now = Date.now();
  const buckets = [];
  for (let i = bucketCount - 1; i >= 0; i -= 1) {
    const end = now - i * bucketMs;
    const start = end - bucketMs;
    const ended = etlRuns.filter(
      (run) => deploymentIds.has(run.deployment_id) && run.end_at && Date.parse(run.end_at) >= start && Date.parse(run.end_at) < end,
    );
    const stillRunning = etlRuns.filter(
      (run) =>
        deploymentIds.has(run.deployment_id) &&
        (run.state === "RUNNING" || run.state === "PENDING") &&
        run.start_at &&
        Date.parse(run.start_at) < end &&
        (!run.end_at || Date.parse(run.end_at) >= start),
    );
    buckets.push({
      start: new Date(start).toISOString(),
      completed: ended.filter((run) => run.state === "COMPLETED").length,
      failed: ended.filter((run) => run.state === "FAILED" || run.state === "CRASHED").length,
      running: stillRunning.length,
    });
  }
  const windowStart = now - bucketMs * bucketCount;
  const durations = etlRuns
    .filter((run) => deploymentIds.has(run.deployment_id) && run.state === "COMPLETED" && run.end_at && Date.parse(run.end_at) >= windowStart && run.start_at)
    .map((run) => (Date.parse(run.end_at) - Date.parse(run.start_at)) / 1000);
  return { interval, buckets, upcoming, median_seconds: median(durations) };
}
function dashboardSummary() {
  const deploymentIds = new Set(activeDeployments().map((deployment) => deployment.id));
  const upcoming = upcomingOf(deploymentIds);
  return {
    ...summaryOf(),
    history: historyOf("1h", 60 * 60 * 1000, HISTORY_1H_BUCKETS, deploymentIds, upcoming),
    history_7d: historyOf("1d", 24 * 60 * 60 * 1000, HISTORY_7D_BUCKETS, deploymentIds, upcoming),
  };
}

// A Python-ish list literal for a loom log line: `[]`, `['a.b']`, `['a.b', 'c.d']`.
function pyList(items) {
  return `[${items.map((item) => `'${item}'`).join(", ")}]`;
}

function stepLogLines(step, deployment) {
  const sourceKind = ETL.deploymentMeta[deployment.id]?.sourceKind ?? "table";
  const lines = [];
  let t = Date.parse(step.start_at ?? new Date().toISOString());
  const push = (level, message) => {
    lines.push(logEntry(new Date(t).toISOString(), level, message));
    t += 3_000;
  };
  // Still running (or interrupted mid-flight): only what has actually happened so far — a write already looking
  // "complete" for a step with no end_at yet would read as a bug, not a demo of the run in progress.
  const open = step.state === "RUNNING" || step.state === "INTERRUPTED";
  push(20, `step start step=${step.name} sources=${pyList(step.reads)}`);
  push(20, `read source kind=${sourceKind} ref=${step.reads[0] ? `TableRef('${step.reads[0]}')` : "None"}`);
  if (step.rows !== null) push(20, `{'rows': ${step.rows}, 'event': 'read complete', 'scope': 'STEP'}`);
  if (!open && step.writes[0]) {
    push(20, `write target ref=TableRef('${step.writes[0]}')`);
    push(20, `{'mode': 'replace_partitions', 'uri': 's3://periplo-lake/${step.writes[0].replace(".", "/")}', 'rows': ${step.rows}, 'cols': 24}`);
    if (step.state === "COMPLETED") {
      push(
        20,
        `{'mode': 'replace_partitions', 'uri': 's3://periplo-lake/${step.writes[0].replace(".", "/")}', 'version': ${step.delta_version}, 'rows': None, 'bytes': None, 'files': None, 'event': 'delta write complete'}`,
      );
    }
  }
  if (step.state === "FAILED") push(40, `{'scope': 'STEP', 'name': '${step.name}', 'event': 'EmptyUserPartitionError: refusing to publish an empty partition'}`);
  return lines;
}

// A deployment with a curated run tree (a hand-authored fixture entry in ETL.tasks) lends its most recent
// COMPLETED run's process names, in order, as the deployment's own shape: every other run of that deployment —
// curated or generic — is then built or logged against that same shape, rather than the two-process default.
function deploymentProcessNames(deploymentId) {
  const curated = runsOf(deploymentId).filter((run) => tasksStore.has(run.id));
  const preferred = [...curated.filter((run) => run.state === "COMPLETED"), ...curated];
  for (const run of preferred) {
    const names = (tasksStore.get(run.id).attempts.at(-1)?.processes ?? []).map((process) => process.name).filter((name) => name !== null);
    if (names.length > 0) return names;
  }
  return null;
}

const DEFAULT_PROCESS_NAMES = ["StagingProcess", "TransformProcess"];

// A step's own log, always kept task-scoped (`runLogs.tasks`, one entry's own view of itself); on a deployment
// with a shape (`rich`) the same lines are also folded into the flow-level log, exactly as loom's driver process
// re-logs what each of its steps logs: as log records of their own (ids of their own), since the API never
// answers one record both with and without a task run.
// A step that failed twice and completed on its third try, as loom records it: each try its own task run, with its own
// log lines; the step itself carries the last try's task run and state, and spans all three. Returns where it ends.
const RETRY_DEMO_SECONDS = [12, 14, 18];
const RETRY_DEMO_GAP_SECONDS = 6;
function withTries(step, runLogs, deployment, rich) {
  let at = Date.parse(step.start_at);
  step.tries = RETRY_DEMO_SECONDS.map((seconds, index) => {
    const failed = index < RETRY_DEMO_SECONDS.length - 1;
    const attempt = {
      index: index + 1,
      task_run_id: randomUUID(),
      state: failed ? "FAILED" : "COMPLETED",
      start_at: new Date(at).toISOString(),
      end_at: new Date(at + seconds * 1000).toISOString(),
      duration_seconds: seconds,
    };
    at += (seconds + RETRY_DEMO_GAP_SECONDS) * 1000;
    const lines = failed
      ? [logEntry(attempt.start_at, 20, `step start step=${step.name} try=${attempt.index}`), logEntry(attempt.end_at, 40, `step failed step=${step.name} error=TimeoutError: the warehouse did not answer in ${seconds}s`)]
      : stepLogLines({ ...step, start_at: attempt.start_at, end_at: attempt.end_at, task_run_id: attempt.task_run_id }, deployment);
    runLogs.tasks.set(attempt.task_run_id, lines);
    if (rich) runLogs.flow.push(...lines.map((line) => ({ ...line, id: randomUUID() })));
    return attempt;
  });
  const last = step.tries.at(-1);
  step.task_run_id = last.task_run_id;
  step.end_at = last.end_at;
  step.duration_seconds = Math.round((Date.parse(last.end_at) - Date.parse(step.start_at)) / 10) / 100;
  return Date.parse(last.end_at);
}

function recordStepLogs(runLogs, deployment, step, rich) {
  const lines = stepLogLines(step, deployment);
  if (step.task_run_id) runLogs.tasks.set(step.task_run_id, lines);
  if (rich) runLogs.flow.push(...lines.map((line) => ({ ...line, id: randomUUID() })));
}

// The "process start" line loom logs once per process, flow-level only (there is no per-process log stream): the
// nodes count is the process's own step count, present even for a process with no marker task run of its own.
function recordProcessStart(runLogs, process, rich) {
  if (!rich || !process.name || !process.start_at) return;
  runLogs.flow.push(logEntry(process.start_at, 20, `process start process=${process.name} nodes=${process.steps.length}`));
}

function pushFlowPreamble(runLogs, run, deployment) {
  runLogs.flow.push(logEntry(run.start_at ?? new Date().toISOString(), 20, `Beginning flow run '${run.name}' for flow '${deployment.flow_name}'`));
}

// "Finished in state <Label>('<message>')" for every terminal state, `state_message` verbatim (it already reads
// as a full sentence, failed or not) — the same narrative shape the curated fixtures already use.
const TERMINAL_STATE_LABELS = { COMPLETED: "Completed", FAILED: "Failed", CANCELLED: "Cancelled", CRASHED: "Crashed" };

function pushFlowTrailer(runLogs, run) {
  if (!run.end_at) return; // still running: nothing to close yet
  const label = TERMINAL_STATE_LABELS[run.state];
  if (label === undefined) return;
  const level = run.state === "COMPLETED" ? 20 : 40;
  const message = run.state_message ?? (run.state === "COMPLETED" ? "All states completed." : "no further detail");
  runLogs.flow.push(logEntry(run.end_at, level, `Finished in state ${label}('${message}')`));
}

const byTimestamp = (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp);

// A curated run tree (fixture-authored, bypasses `genericTasks`) still needs realistic logs once its deployment
// has a shape: built once, lazily, from the tree itself, and left alone if the fixture already supplied its own
// (other deployments' curated runs, still hand-authored, keep exactly what they have).
function ensureCuratedLogs(run, runTasks) {
  if (logsStore.has(run.id)) return;
  const deployment = deploymentById(run.deployment_id);
  if (deployment === undefined || deploymentProcessNames(deployment.id) === null) return;
  const runLogs = { flow: [], tasks: new Map() };
  logsStore.set(run.id, runLogs);
  pushFlowPreamble(runLogs, run, deployment);
  for (const attempt of runTasks.attempts) {
    for (const process of attempt.processes) {
      recordProcessStart(runLogs, process, true);
      for (const step of process.steps) recordStepLogs(runLogs, deployment, step, true);
    }
  }
  pushFlowTrailer(runLogs, run);
  runLogs.flow.sort(byTimestamp);
}

// Small deterministic pipeline for any run without a curated tasks fixture (built once, cached).
function genericTasks(run, deployment) {
  const attemptsCount = Math.max(1, run.run_count || 1);
  const start = Date.parse(run.start_at ?? new Date().toISOString());
  const end = Date.parse(run.end_at ?? new Date(start + 60_000).toISOString());
  const perAttemptMs = Math.max(4_000, (end - start) / attemptsCount);
  const openEnded = run.state === "RUNNING" || run.state === "CRASHED";
  // A deployment with a curated shape (see `deploymentProcessNames`) gets its own process list and the fuller,
  // flow-duplicated logs (`rich`); every other deployment keeps the plain two-process fallback, unchanged.
  const shapeNames = deploymentProcessNames(deployment.id);
  const rich = shapeNames !== null;
  const processNames = shapeNames ?? DEFAULT_PROCESS_NAMES;
  const attempts = [];
  let cursor = start;
  const runLogs = logsStore.get(run.id) ?? { flow: [], tasks: new Map() };
  logsStore.set(run.id, runLogs);
  if (rich) pushFlowPreamble(runLogs, run, deployment);
  for (let a = 0; a < attemptsCount; a += 1) {
    const isLast = a === attemptsCount - 1;
    const attemptState = isLast ? run.state : "FAILED";
    // A run that says how its attempts went (one retried from the UI hours later) runs each one where it ran.
    const planned = run.__attempts?.[a];
    if (planned) cursor = Date.parse(planned.start_at);
    const attemptStart = cursor;
    const attemptMs = planned ? Date.parse(planned.end_at ?? new Date().toISOString()) - attemptStart : perAttemptMs;
    const processes = [];
    const procCount = processNames.length;
    const stepMs = Math.max(500, attemptMs) / (procCount * 2);
    for (let p = 0; p < procCount; p += 1) {
      const failHere = isLast && attemptState === "FAILED" && p === procCount - 1;
      const openHere = isLast && openEnded && p === procCount - 1;
      const procStart = cursor;
      const steps = [];
      for (let s = 0; s < 2; s += 1) {
        const failThis = failHere && s === 1;
        const openThis = openHere && s === 1;
        const stepStart = new Date(cursor).toISOString();
        cursor += stepMs;
        const step = {
          name: `${processNames[p % processNames.length].replace("Process", "")}Step${s + 1}`,
          task_run_id: randomUUID(),
          state: failThis ? "FAILED" : openThis ? (run.state === "CRASHED" ? "INTERRUPTED" : "RUNNING") : "COMPLETED",
          start_at: stepStart,
          end_at: failThis || openThis ? null : new Date(cursor).toISOString(),
          duration_seconds: failThis || openThis ? null : Math.round(stepMs / 10) / 100,
          reads: s === 0 ? [] : [`${deployment.name}.stage_${p}`],
          writes: failThis ? [] : [`${deployment.name}.stage_${p}_${s}`],
          rows: failThis ? null : 1_000 + s * 10,
          delta_version: failThis ? null : 10 + p + s,
        };
        // The retried-step demo: this run's second step took three tries, the first two failed (see `withTries`).
        if (run.__retried_step && p === 0 && s === 1 && step.state === "COMPLETED") {
          cursor = withTries(step, runLogs, deployment, rich);
        } else {
          recordStepLogs(runLogs, deployment, step, rich);
        }
        for (const id of step.tries ? step.tries.map((attempt) => attempt.task_run_id) : [step.task_run_id]) {
          stepIndex.set(id, { step, processName: processNames[p % processNames.length], runId: run.id });
        }
        steps.push(step);
        if (failThis) break;
      }
      const procTaskRunId = randomUUID();
      const lastStep = steps.at(-1);
      const process = {
        name: processNames[p % processNames.length],
        task_run_id: procTaskRunId,
        state: lastStep.state === "FAILED" ? "FAILED" : lastStep.state === "RUNNING" || lastStep.state === "INTERRUPTED" ? lastStep.state : "COMPLETED",
        start_at: new Date(procStart).toISOString(),
        end_at: lastStep.end_at,
        duration_seconds: lastStep.end_at ? Math.round((cursor - procStart) / 10) / 100 : null,
        expected_steps: 2,
        steps,
      };
      recordProcessStart(runLogs, process, rich);
      processes.push(process);
      if (failHere) break;
    }
    attempts.push({
      number: a + 1,
      state: attemptState,
      started_at: new Date(attemptStart).toISOString(),
      ended_at: isLast ? run.end_at : (planned?.end_at ?? new Date(cursor).toISOString()),
      message: isLast ? run.state_message : "Flow run encountered an exception; retrying",
      processes,
    });
  }
  if (rich) {
    pushFlowTrailer(runLogs, run);
    runLogs.flow.sort(byTimestamp);
  }
  return { attempts, expected_steps_known: true };
}

function tasksOf(run) {
  if (tasksStore.has(run.id)) {
    const runTasks = tasksStore.get(run.id);
    ensureCuratedLogs(run, runTasks);
    return runTasks;
  }
  // A run that has not started has run no task yet: nothing to draw, as Prefect has nothing for it.
  if (run.start_at === null) return { attempts: [], expected_steps_known: false };
  const deployment = deploymentById(run.deployment_id);
  const built = genericTasks(run, deployment);
  tasksStore.set(run.id, built);
  return built;
}

// GET /etl/{name}/grid: the last attempt's processes per run, keyed by name (later
// attempts overwrite earlier ones, which is what "last attempt" means here).
function gridProcessesOf(run) {
  const byName = new Map();
  for (const attempt of tasksOf(run).attempts) {
    for (const process of attempt.processes) {
      if (process.name) byName.set(process.name, process);
    }
  }
  return byName;
}

function gridOf(deployment, limit) {
  const runsDesc = runsOf(deployment.id)
    .filter((run) => run.state !== "SCHEDULED")
    .slice(0, limit);
  const perRun = runsDesc.map((run) => ({ run, processes: gridProcessesOf(run) }));

  // Processes: first appearance in the most recent run that has any, then any others.
  const order = [];
  const seen = new Set();
  for (const { processes } of perRun) {
    for (const name of processes.keys()) {
      if (!seen.has(name)) {
        order.push(name);
        seen.add(name);
      }
    }
  }

  const runs = [...perRun].reverse().map(({ run, processes }) => ({
    id: run.id,
    name: run.name,
    state: run.state,
    start_at: run.start_at,
    duration_seconds: run.duration_seconds,
    cells: order
      .filter((name) => processes.has(name))
      .map((name) => {
        const process = processes.get(name);
        return { process: name, state: process.state, duration_seconds: process.duration_seconds };
      }),
  }));
  return { runs, processes: order, truncated: false };
}

// Page rule of the contract: no `after` → the last `limit` lines; with `after` → lines at or after it (inclusive).
function logPage(lines, after, limit) {
  const entries = after === null ? lines.slice(-limit) : lines.filter((line) => Date.parse(line.timestamp) >= Date.parse(after)).slice(0, limit);
  return { entries, next: entries.at(-1)?.timestamp ?? after, truncated: entries.length === limit };
}

function logsOf(run, taskRun) {
  const runLogs = logsStore.get(run.id) ?? { flow: [], tasks: new Map() };
  return taskRun ? (runLogs.tasks.get(taskRun) ?? []).map((line) => ({ ...line, task_run_id: taskRun })) : runLogs.flow;
}

// GET /etl/runs/{id}/logs: several `task_run` merge and sort by timestamp (a process's
// scope is its marker plus its steps); `q` is a case-insensitive substring; `min_level` a floor.
function combinedLogsOf(run, taskRuns) {
  if (!taskRuns || taskRuns.length === 0) return logsOf(run, null);
  return taskRuns
    .flatMap((taskRun) => logsOf(run, taskRun))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function filterLogLines(lines, q, minLevel) {
  let result = lines;
  if (q) {
    const needle = q.toLowerCase();
    result = result.filter((line) => line.message.toLowerCase().includes(needle));
  }
  if (minLevel !== null) result = result.filter((line) => line.level >= minLevel);
  return result;
}

function startRun(run, deployment) {
  const started = Date.now();
  const runLogs = { flow: [], tasks: new Map() };
  logsStore.set(run.id, runLogs);
  run.start_at = new Date(started).toISOString();
  run.expected_start_at = run.start_at;
  const log = (message) => runLogs.flow.push(logEntry(new Date().toISOString(), 20, message));
  const tick = () => (run.duration_seconds = Math.round((Date.now() - started) / 10) / 100);
  log(`Beginning flow run '${run.name}' for flow '${deployment.flow_name}'`);

  const process = { name: "ManualRunProcess", task_run_id: randomUUID(), state: "RUNNING", start_at: run.start_at, end_at: null, duration_seconds: null, expected_steps: null, steps: [] };
  const attempt = { number: 1, state: "RUNNING", started_at: run.start_at, ended_at: null, message: null, processes: [process] };
  tasksStore.set(run.id, { attempts: [attempt], expected_steps_known: false });

  let stepIx = 0;
  const ticker = setInterval(() => {
    tick();
    stepIx += 1;
    const stepStart = new Date().toISOString();
    const step = {
      name: `ManualRunStep${stepIx}`,
      task_run_id: randomUUID(),
      state: "COMPLETED",
      start_at: stepStart,
      end_at: stepStart,
      duration_seconds: 2,
      reads: [],
      writes: [`${deployment.name}.manual_${stepIx}`],
      rows: 100 * stepIx,
      delta_version: stepIx,
    };
    process.steps.push(step);
    runLogs.tasks.set(step.task_run_id, stepLogLines(step, deployment));
    stepIndex.set(step.task_run_id, { step, processName: process.name, runId: run.id });
    log(`Processed chunk ${stepIx} of ${RUN_DURATION_MS / RUN_LOG_EVERY_MS}`);
  }, RUN_LOG_EVERY_MS);
  setTimeout(() => {
    clearInterval(ticker);
    tick();
    Object.assign(run, { state: "COMPLETED", state_message: "All states completed.", end_at: new Date().toISOString() });
    process.state = "COMPLETED";
    process.end_at = run.end_at;
    process.duration_seconds = run.duration_seconds;
    process.expected_steps = process.steps.length;
    attempt.state = "COMPLETED";
    attempt.ended_at = run.end_at;
    attempt.message = "All states completed.";
    log("Finished in state Completed('All states completed.')");
  }, RUN_DURATION_MS);
}
etlRuns.filter((run) => run.state === "RUNNING").forEach((run) => registerSteps(run.id, tasksOf(run)));

function createRun(deployment, parameters) {
  const run = {
    id: randomUUID(),
    deployment_id: deployment.id,
    name: `manual-${Math.random().toString(36).slice(2, 8)}`,
    state: "RUNNING",
    state_message: null,
    expected_start_at: null,
    start_at: null,
    end_at: null,
    duration_seconds: 0,
    created_by: "periplo-web",
    run_count: 1,
    retries: 0,
    retry_delay_seconds: 0,
    parameters: parameters ?? deployment.parameters,
  };
  etlRuns.push(run);
  startRun(run, deployment);
  return run;
}

function setScheduleActive(deployment, active) {
  if (!deployment.schedule) return false;
  deployment.schedule = { ...deployment.schedule, active };
  if (active) deployment.paused = false;
  console.log(`etl.schedule_changed deployment=${deployment.name} active=${active}`);
  return true;
}

// Three extra "Running now" demo runs, beyond the curated orders_snapshot_daily one already RUNNING
// in the fixture: one deliberately slow (> 1.5x its deployment's typical, never flips, so the
// dashboard's "lento" styling has something to show for the whole session) and one with a
// `__typical_override: null` ("no history" demo) that flips to FAILED at ~40s so the exit
// animation is visible; a third, normal-paced one flips to COMPLETED at ~20s.
function seedDemoRun(deployment, { processName, stepName, elapsedMs, flipTo, flipAfterMs, typicalOverride }) {
  const startAt = new Date(Date.now() - elapsedMs).toISOString();
  const run = {
    id: randomUUID(),
    deployment_id: deployment.id,
    name: `demo-${Math.random().toString(36).slice(2, 8)}`,
    state: "RUNNING",
    state_message: null,
    expected_start_at: startAt,
    start_at: startAt,
    end_at: null,
    duration_seconds: Math.round(elapsedMs / 10) / 100,
    created_by: "periplo-web",
    run_count: 1,
    retries: 0,
    retry_delay_seconds: 0,
    parameters: deployment.parameters,
  };
  if (typicalOverride !== undefined) run.__typical_override = typicalOverride;

  const taskRunId = randomUUID();
  const step = {
    name: stepName,
    task_run_id: taskRunId,
    state: "RUNNING",
    start_at: startAt,
    end_at: null,
    duration_seconds: null,
    reads: [],
    writes: [`${deployment.name}.demo`],
    rows: null,
    delta_version: null,
  };
  const process = {
    name: processName,
    task_run_id: randomUUID(),
    state: "RUNNING",
    start_at: startAt,
    end_at: null,
    duration_seconds: null,
    expected_steps: 1,
    steps: [step],
  };
  const attempt = { number: 1, state: "RUNNING", started_at: startAt, ended_at: null, message: null, processes: [process] };
  tasksStore.set(run.id, { attempts: [attempt], expected_steps_known: true });
  const runLogs = {
    flow: [logEntry(startAt, 20, `Beginning flow run '${run.name}' for flow '${deployment.flow_name}'`)],
    tasks: new Map([[taskRunId, stepLogLines(step, deployment)]]),
  };
  logsStore.set(run.id, runLogs);
  stepIndex.set(taskRunId, { step, processName: process.name, runId: run.id });
  etlRuns.push(run);

  if (flipTo === null) return run; // stays RUNNING (and slow) for the whole session
  setTimeout(() => {
    const endAt = new Date().toISOString();
    const completed = flipTo === "COMPLETED";
    Object.assign(run, {
      state: flipTo,
      state_message: completed ? "All states completed." : "EmptyUserPartitionError: refusing to publish an empty partition",
      end_at: endAt,
      duration_seconds: Math.round((Date.now() - Date.parse(startAt)) / 10) / 100,
    });
    process.state = run.state;
    process.end_at = endAt;
    process.duration_seconds = run.duration_seconds;
    step.state = run.state;
    step.end_at = endAt;
    step.duration_seconds = run.duration_seconds;
    attempt.state = run.state;
    attempt.ended_at = endAt;
    attempt.message = run.state_message;
    runLogs.flow.push(
      logEntry(endAt, completed ? 20 : 40, completed ? "Finished in state Completed('All states completed.')" : `Finished in state Failed('${run.state_message}')`),
    );
  }, flipAfterMs);
  return run;
}

const suppliersWeekly = findDeployment("suppliers_catalog_weekly");
if (suppliersWeekly) {
  const typical = typicalSecondsOf(suppliersWeekly.id) ?? 60;
  seedDemoRun(suppliersWeekly, {
    processName: "SuppliersExtractProcess",
    stepName: "SuppliersExtractStep",
    elapsedMs: Math.round(typical * 1.8 * 1000),
    flipTo: null, // stays slow (> 1.5x typical) for the whole session
    flipAfterMs: 0,
  });
}
const returnsDaily = findDeployment("returns_reconciliation_daily");
if (returnsDaily) {
  seedDemoRun(returnsDaily, {
    processName: "ReturnsIngestProcess",
    stepName: "ReturnsIngestStep",
    elapsedMs: 15_000,
    flipTo: "FAILED",
    flipAfterMs: 40_000,
    typicalOverride: null, // "no history" demo, regardless of this deployment's real fixture history
  });
}
const stagingOrders = findDeployment("staging_orders_dev");
if (stagingOrders) {
  seedDemoRun(stagingOrders, {
    processName: "StagingLoadProcess",
    stepName: "StagingLoadStep",
    elapsedMs: 8_000,
    flipTo: "COMPLETED",
    flipAfterMs: 20_000,
  });
}

// A run retried from Prefect's UI hours after it failed, running again: the same run id, its first attempt's start
// kept as `start_at` (6 h ago, failed after 6 min), its second attempt started 3 min ago.
const suppliersBackfill = findDeployment("suppliers_catalog_backfill_by_month");
if (suppliersBackfill) {
  const firstStart = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const attemptStart = new Date(Date.now() - 3 * 60 * 1000).toISOString();
  etlRuns.push({
    id: randomUUID(),
    deployment_id: suppliersBackfill.id,
    name: "retried-from-ui",
    state: "RUNNING",
    state_message: null,
    state_since: attemptStart,
    expected_start_at: firstStart,
    start_at: firstStart,
    attempt_started_at: attemptStart,
    end_at: null,
    duration_seconds: 6 * 60,
    created_by: "ana",
    run_count: 2,
    retries: 0,
    retry_delay_seconds: 0,
    parameters: suppliersBackfill.parameters,
    __attempts: [
      { index: 1, start_at: firstStart, end_at: new Date(Date.parse(firstStart) + 6 * 60 * 1000).toISOString(), state: "FAILED", duration_seconds: 360 },
      { index: 2, start_at: attemptStart, end_at: null, state: "RUNNING", duration_seconds: null },
    ],
  });
}

// A run stuck submitting in the orchestrator: PENDING with no start time, weeks past its expected start.
const STUCK_FOR_MS = 7 * 7 * 24 * 60 * 60 * 1000;
// A second one, on another ETL and stuck for less long, so Needs attention can cancel the stuck runs together.
const STUCK_TOO_FOR_MS = 3 * 24 * 60 * 60 * 1000;
const stuckRunOf = (deployment, name, forMs) => ({
  id: randomUUID(),
  deployment_id: deployment.id,
  name,
  state: "PENDING",
  state_message: null,
  expected_start_at: new Date(Date.now() - forMs).toISOString(),
  start_at: null,
  end_at: null,
  duration_seconds: null,
  created_by: "prefect-scheduler",
  run_count: 0,
  retries: 0,
  retry_delay_seconds: 0,
  parameters: deployment.parameters,
});
const inventoryHourly = findDeployment("inventory_sync_hourly");
if (inventoryHourly) etlRuns.push(stuckRunOf(inventoryHourly, "stuck-submitting", STUCK_FOR_MS));
const suppliersCatalog = findDeployment("suppliers_catalog_weekly");
if (suppliersCatalog) etlRuns.push(stuckRunOf(suppliersCatalog, "stuck-pending", STUCK_TOO_FOR_MS));

// The retried-step demo: inventory_sync_hourly's newest completed run has a step that took three tries.
const retriedStepRun = runsOf(findDeployment("inventory_sync_hourly")?.id).find((run) => run.state === "COMPLETED");
if (retriedStepRun) retriedStepRun.__retried_step = true;

// The retried-runs demo: two runs in a row of inventory_sync_hourly, just older than that one, needed 2 and 3 attempts,
// so its dense strips (the dashboard's Last 12, the 24-hour panel) show two neighbouring retry dots.
const inventoryRuns = runsOf(findDeployment("inventory_sync_hourly")?.id).filter((run) => run.state !== "SCHEDULED");
const retriedRunsAt = inventoryRuns.indexOf(retriedStepRun) + 1;
inventoryRuns.slice(retriedRunsAt, retriedRunsAt + 2).forEach((run, index) => {
  run.run_count = 3 - index;
});

// The archive demo: a one-off backfill archived three days ago, and a dev ETL archived two days ago that still runs
// on its schedule ("Archived, but ran at …").
archives.set("orders_snapshot_backfill_by_month", { at: new Date(Date.now() - 3 * DAY_MS).toISOString(), by: null, reason: "One-off backfill, done" });
archives.set("staging_orders_dev", { at: new Date(Date.now() - 2 * DAY_MS).toISOString(), by: null, reason: null });

// Cancel and retry as the API asks Prefect for them (see the API's `run_control`), with the worker played by timers: a
// started run is stopped a few seconds after it turns CANCELLING; one that never started is CANCELLED at once; a
// retried run is the same run, scheduled, then running again (one more attempt, its first start kept, as Prefect does),
// then completed.
const CANCELLABLE = new Set(["RUNNING", "PENDING", "SCHEDULED", "PAUSED"]);
const FORCE_CANCEL_AFTER_MS = 10 * 60 * 1000;
const WORKER_STOPS_AFTER_MS = 4000;
const RETRY_STARTS_AFTER_MS = 3000;
const RETRY_RUNS_FOR_MS = 20000;

function setRunState(run, state, message) {
  run.state = state;
  run.state_message = message;
  run.state_since = new Date().toISOString();
  if (TERMINAL_STATES.has(state)) {
    run.end_at = run.state_since;
    run.duration_seconds = run.start_at ? Math.round((Date.parse(run.end_at) - Date.parse(run.start_at)) / 1000) : 0;
  }
}

function cancelRun(run, force) {
  const notCancellable = (message) => ({ code: "etl_run_not_cancellable", message });
  if (force) {
    if (run.state !== "CANCELLING") return notCancellable("Only a run stuck cancelling can be forced to cancelled");
    if (Date.now() - Date.parse(run.state_since ?? 0) < FORCE_CANCEL_AFTER_MS)
      return notCancellable("A run can be forced once it has been cancelling for 10 minutes");
    setRunState(run, "CANCELLED", "Cancelled from Periplo");
    return null;
  }
  if (run.state === "CANCELLING") return notCancellable("This run is already being cancelled");
  if (!CANCELLABLE.has(run.state)) return notCancellable("This run has already finished");
  if (!run.start_at) {
    setRunState(run, "CANCELLED", "Cancelled from Periplo");
    return null;
  }
  setRunState(run, "CANCELLING", "Cancelled from Periplo");
  setTimeout(() => run.state === "CANCELLING" && setRunState(run, "CANCELLED", "Flow run was cancelled."), WORKER_STOPS_AFTER_MS);
  return null;
}

function retryRun(run) {
  if (run.state !== "FAILED" && run.state !== "CRASHED") return { code: "etl_run_not_retryable", message: "Only a failed or crashed run can be retried" };
  // Its attempts so far, as they went: the next one runs where it starts, not right after them.
  const earlier = run.__attempts ?? [{ index: 1, start_at: run.start_at, end_at: run.end_at, state: run.state, duration_seconds: run.duration_seconds }];
  setRunState(run, "SCHEDULED", "Retried from Periplo");
  run.end_at = null;
  run.attempt_started_at = null;
  setTimeout(() => {
    setRunState(run, "RUNNING", null);
    run.attempt_started_at = run.state_since;
    run.__attempts = [...earlier, { index: earlier.length + 1, start_at: run.state_since, end_at: null, state: "RUNNING", duration_seconds: null }];
    tasksStore.delete(run.id);
    run.run_count = (run.run_count || 1) + 1;
    setTimeout(() => run.state === "RUNNING" && setRunState(run, "COMPLETED", "All states completed."), RETRY_RUNS_FOR_MS);
  }, RETRY_STARTS_AFTER_MS);
  return null;
}

// FastAPI answers 422 to a `limit` outside its bounds; the mock does the same.
const limitOf = (url, max, fallback) => {
  const limit = Number(url.searchParams.get("limit") ?? fallback);
  return Number.isInteger(limit) && limit >= 1 && limit <= max ? limit : null;
};

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
// A request's JSON body, handed to `then`; a body that is not JSON answers 422, as FastAPI does.
const readJson = (req, res, then) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return fail(res, 422, "validation_error", "Body is not valid JSON");
    }
    return then(body);
  });
};

const fail = (res, status, code, message, extra = {}) =>
  json(res, status, { detail: { code, message, trace_id: randomUUID(), ...extra } }, status === 429 ? { "retry-after": "1" } : {});

// Plain Utf8: a dictionary column would need a new dictionary per batch, which an IPC stream cannot replace.
function batch(start, rows) {
  const index = Array.from({ length: rows }, (_, i) => start + i);
  return new Table({
    order_id: vectorFromArray(index.map((i) => 9007199254740993n + BigInt(i)), new Int64()),
    customer_id: vectorFromArray(index.map((i) => i % 97), new Int32()),
    note: vectorFromArray(index.map((i) => (i % 5 === 0 ? null : `note ${i}`)), new Utf8()),
  }).batches[0];
}

async function runQuery(req, res, body) {
  const sql = String(body.sql ?? "");
  if (!/^\s*(select|with)\b/i.test(sql)) return fail(res, 400, "sql_not_allowed", "Only read queries are allowed");
  if ([...queries.values()].filter((q) => q.state === "running").length >= 2) return fail(res, 429, "capacity", "Two queries are already running", { retryable: true });

  const limit = Number(/limit\s+(\d+)/i.exec(sql)?.[1] ?? 20_000);
  const maxRows = Math.min(limit, Number(body.max_rows ?? 100_000), 100_000);
  // Accepts base.tabla and "base"."tabla"; anything outside the published catalog is unknown, as in the API.
  const reference = /from\s+"?([a-z0-9_]+)"?\s*\.\s*"?([a-z0-9_]+)"?/i.exec(sql);
  if (reference && !findTable(reference[1], reference[2])) {
    return fail(res, 404, "not_found", `Table ${reference[1]}.${reference[2]} is not in the catalog`, { entity: "Table", id: `${reference[1]}.${reference[2]}` });
  }
  const id = randomUUID();
  const snapshots = reference ? { [`${reference[1]}.${reference[2]}`]: 4 } : {};
  const query = { id, state: "running", rows: 0, bytes: 0, truncated: limit > maxRows, snapshots, error: null };
  queries.set(id, query);

  res.writeHead(200, { "content-type": "application/vnd.apache.arrow.stream", "x-query-id": id });
  // A Node duplex: writing batches in, encoded IPC bytes out, and it ends the response by itself.
  const writer = RecordBatchStreamWriter.throughNode();
  writer.on("data", (chunk) => (query.bytes += chunk.byteLength));
  writer.on("error", (error) => console.error("arrow writer failed:", error.message));
  writer.pipe(res);
  res.on("close", () => query.state === "running" && (query.state = "cancelled"));

  // `-- slow` streams visibly; `-- break` cuts the stream to exercise the partial-result path.
  const delay = /--\s*slow/i.test(sql) ? 400 : 30;
  for (let start = 0; start < maxRows && query.state === "running"; start += BATCH_ROWS) {
    const rows = Math.min(BATCH_ROWS, maxRows - start);
    writer.write(batch(start, rows));
    query.rows += rows;
    await new Promise((resolve) => setTimeout(resolve, delay));
    if (/--\s*break/i.test(sql) && start >= BATCH_ROWS) {
      query.state = "failed";
      query.error = { code: "storage", message: "Simulated storage failure" };
      return res.destroy();
    }
  }
  if (query.state !== "running") return res.destroy();
  query.state = "completed";
  writer.end();
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://mock");
    const route = `${req.method} ${url.pathname}`;
    const queryId = /^\/api\/v1\/queries\/([^/]+)$/.exec(url.pathname)?.[1];
    const tableRoute = /^\/api\/v1\/catalog\/tables\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const metaRoute = /^\/api\/v1\/catalog\/tables\/([^/]+)\/([^/]+)\/(stats|history)$/.exec(url.pathname);
    // `/etl/runs/...` before `/etl/{name}/...`, as in the API router.
    const runRoute = /^\/api\/v1\/etl\/runs\/([^/]+)(\/logs)?$/.exec(url.pathname);
    const runTasksRoute = /^\/api\/v1\/etl\/runs\/([^/]+)\/tasks$/.exec(url.pathname);
    const runStepRoute = /^\/api\/v1\/etl\/runs\/([^/]+)\/steps\/([^/]+)$/.exec(url.pathname);
    const etlRunsRoute = /^\/api\/v1\/etl\/([^/]+)\/runs$/.exec(url.pathname);
    const gridRoute = /^\/api\/v1\/etl\/([^/]+)\/grid$/.exec(url.pathname);
    const scheduleRoute = /^\/api\/v1\/etl\/([^/]+)\/schedule\/(resume|pause)$/.exec(url.pathname);
    const archiveRoute = /^\/api\/v1\/etl\/([^/]+)\/(archive|restore)$/.exec(url.pathname);
    const controlRoute = /^\/api\/v1\/etl\/runs\/([^/]+)\/(cancel|retry)$/.exec(url.pathname);

    if (route === "GET /health/live" || route === "GET /health/ready") return json(res, 200, { status: "ok" });
    if (route === "GET /api/v1/catalog") return json(res, 200, { ...catalog, links: TABLE_META.links });
    if (route === "GET /api/v1/sources") return json(res, 200, { discovery, published_at: catalog.published_at, sources: SOURCES });
    if (route === "POST /api/v1/discovery") {
      if (discovery.state === "idle") {
        discovery = { state: "running", started_at: new Date().toISOString() };
        setTimeout(() => {
          catalog = { ...CATALOGS.after, published_at: new Date().toISOString() };
          discovery = { state: "idle", started_at: null };
        }, REDISCOVERY_MS);
      }
      res.writeHead(202);
      return res.end();
    }
    if (req.method === "GET" && metaRoute) {
      if (!findTable(decodeURIComponent(metaRoute[1]), decodeURIComponent(metaRoute[2]))) {
        return fail(res, 404, "not_found", "Table not found in the catalog", { entity: "Table", id: metaRoute[2] });
      }
      if (metaRoute[3] === "stats") return json(res, 200, TABLE_META.stats);
      return json(res, 200, { entries: TABLE_META.history });
    }
    if (req.method === "GET" && tableRoute) {
      const table = findTable(decodeURIComponent(tableRoute[1]), decodeURIComponent(tableRoute[2]));
      if (!table) return fail(res, 404, "not_found", "Table not found in the catalog", { entity: "Table", id: tableRoute[2] });
      if (table.name === "contracts") return fail(res, 503, "storage", "The table could not be read from storage", { retryable: true });
      return json(res, 200, { ...table, delta_version: 4, fields: FIELDS });
    }
    if (route === "POST /api/v1/queries") {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      return req.on("end", () => {
        try {
          void runQuery(req, res, JSON.parse(raw || "{}"));
        } catch {
          fail(res, 422, "validation_error", "Body is not valid JSON");
        }
      });
    }
    if (route === "GET /api/v1/etl/status")
      return json(res, 200, { configured: true, operate_enabled: true, archive_enabled: true, archive_mode: "process", facets: MOCK_FACETS });
    if (route === "GET /api/v1/etl") {
      const etls = [...ETL.deployments].sort((a, b) => a.name.localeCompare(b.name) || a.flow_name.localeCompare(b.flow_name)).map(etlOf);
      return json(res, 200, { etls, summary: dashboardSummary(), ...runningRunsOf() });
    }
    if (req.method === "GET" && runStepRoute) {
      const run = etlRuns.find((candidate) => candidate.id === runStepRoute[1]);
      if (!run) return fail(res, 404, "not_found", "Unknown flow run", { entity: "FlowRun", id: runStepRoute[1] });
      tasksOf(run); // registers stepIndex/logsStore for a step never reached through /tasks first
      const found = stepIndex.get(runStepRoute[2]);
      if (!found || found.runId !== run.id) return fail(res, 404, "not_found", "Unknown step", { entity: "Step", id: runStepRoute[2] });
      const { step, processName } = found;
      const facts = { reads: step.reads, writes: step.writes, rows: step.rows, delta_version: step.delta_version };
      return json(res, 200, { step: publicStep(step), process: processName, facts, logs: logPage(logsOf(run, step.task_run_id), null, 200) });
    }
    if (req.method === "GET" && runTasksRoute) {
      const run = etlRuns.find((candidate) => candidate.id === runTasksRoute[1]);
      if (!run) return fail(res, 404, "not_found", "Unknown flow run", { entity: "FlowRun", id: runTasksRoute[1] });
      return json(res, 200, publicTasks(tasksOf(run)));
    }
    if (req.method === "GET" && runRoute) {
      const run = etlRuns.find((candidate) => candidate.id === runRoute[1]);
      if (!run) return fail(res, 404, "not_found", "Unknown flow run", { entity: "FlowRun", id: runRoute[1] });
      if (!runRoute[2]) return json(res, 200, runDetail(run));
      tasksOf(run); // registers logsStore for a run whose logs are read before its /tasks ever is
      const limit = limitOf(url, 200, 200);
      if (limit === null) return fail(res, 422, "validation_error", "limit must be between 1 and 200");
      const taskRuns = url.searchParams.getAll("task_run");
      if (taskRuns.length > 100) return fail(res, 422, "validation_error", "task_run accepts at most 100 ids");
      const q = url.searchParams.get("q");
      if (q !== null && q.length > 200) return fail(res, 422, "validation_error", "q must be at most 200 characters");
      const minLevelRaw = url.searchParams.get("min_level");
      const minLevel = minLevelRaw !== null ? Number(minLevelRaw) : null;
      const lines = filterLogLines(combinedLogsOf(run, taskRuns), q, minLevel);
      return json(res, 200, logPage(lines, url.searchParams.get("after"), limit));
    }
    if (req.method === "GET" && gridRoute) {
      const deployment = findDeployment(decodeURIComponent(gridRoute[1]));
      if (!deployment) return fail(res, 404, "not_found", "Unknown deployment", { entity: "Deployment", id: gridRoute[1] });
      const limit = limitOf(url, 20, 20);
      if (limit === null) return fail(res, 422, "validation_error", "limit must be between 1 and 20");
      return json(res, 200, gridOf(deployment, limit));
    }
    if (controlRoute && req.method === "POST") {
      const run = etlRuns.find((candidate) => candidate.id === controlRoute[1]);
      if (!run) return fail(res, 404, "not_found", "Unknown flow run", { entity: "FlowRun", id: controlRoute[1] });
      return readJson(req, res, (body) => {
        const refusal = controlRoute[2] === "cancel" ? cancelRun(run, body.force === true) : retryRun(run);
        if (refusal) return fail(res, 409, refusal.code, refusal.message);
        return json(res, 202, runDetail(run));
      });
    }
    // As the API: archiving asks the orchestrator only whether it knows the ETL; restoring does not ask it.
    if (archiveRoute && req.method === "POST") {
      const name = decodeURIComponent(archiveRoute[1]);
      if (archiveRoute[2] === "restore") {
        archives.delete(name);
        return json(res, 200, { name, archived: null });
      }
      if (!findDeployment(name)) return fail(res, 404, "not_found", "Unknown deployment", { entity: "Deployment", id: name });
      if (!archives.has(name)) archives.set(name, { at: new Date().toISOString(), by: null, reason: null });
      return json(res, 200, { name, archived: archives.get(name) });
    }
    if (scheduleRoute) {
      const deployment = findDeployment(decodeURIComponent(scheduleRoute[1]));
      if (!deployment) return fail(res, 404, "not_found", "Unknown deployment", { entity: "Deployment", id: scheduleRoute[1] });
      if (req.method !== "POST") return fail(res, 404, "not_found", `No route for ${route}`);
      if (!deployment.schedule) return fail(res, 400, "etl_rejected", "This deployment has no schedule");
      setScheduleActive(deployment, scheduleRoute[2] === "resume");
      return json(res, 202, etlOf(deployment));
    }
    if (etlRunsRoute) {
      const deployment = findDeployment(decodeURIComponent(etlRunsRoute[1]));
      if (!deployment) return fail(res, 404, "not_found", "Unknown deployment", { entity: "Deployment", id: etlRunsRoute[1] });
      if (req.method === "GET") {
        const limit = limitOf(url, 100, 25);
        if (limit === null) return fail(res, 422, "validation_error", "limit must be between 1 and 100");
        const nonScheduled = runsOf(deployment.id).filter((run) => run.state !== "SCHEDULED");
        return json(res, 200, { runs: nonScheduled.slice(0, limit).map(flowRun) });
      }
      if (req.method === "POST") {
        return readJson(req, res, (body) => {
          console.log(`etl.run_requested deployment=${deployment.name}`);
          json(res, 202, runDetail(createRun(deployment, body.parameters ?? null)));
        });
      }
    }
    if (queryId && req.method === "GET") {
      const query = queries.get(queryId);
      return query ? json(res, 200, query) : fail(res, 404, "not_found", "Unknown query");
    }
    if (queryId && req.method === "DELETE") {
      const query = queries.get(queryId);
      if (!query) return fail(res, 404, "not_found", "Unknown query");
      if (query.state === "running") query.state = "cancelled";
      res.writeHead(202);
      return res.end();
    }
    fail(res, 404, "not_found", `No route for ${route}`);
  })
  .listen(PORT, "0.0.0.0", () => console.log(`mock Periplo API on :${PORT}`));
