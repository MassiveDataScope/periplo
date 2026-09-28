// Generates dev/fixtures/etl.json: the ETL fixture of the development mock (dev/mock-api.mjs) and of
// App.test.tsx, for a fictional online shop. Deterministic: a fixed seed and a fixed time anchor, so the
// same code always writes the same bytes.
//
//   node dev/fixtures/generate-etl.mjs           rewrite etl.json
//   node dev/fixtures/generate-etl.mjs --check   exit 1 if etl.json is not what this script generates
import { readFileSync, writeFileSync } from "node:fs";

const OUTPUT = new URL("./etl.json", import.meta.url);
const SEED = 0x5eed_2026;
// Every run of the fixture ends before this instant; the mock moves the whole fixture next to "now".
const ANCHOR = Date.parse("2026-09-23T13:00:00.000Z");
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SCHEDULER = "prefect-scheduler";
const OPERATOR = "operator@periplo.example";
const TASK_DEFINITION = "arn:aws:ecs:us-east-1:000000000000:task-definition/periplo-shop-etl:42";

// ---- deterministic randomness -----------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const random = mulberry32(SEED);
const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (items) => items[Math.floor(random() * items.length)];

function uuid() {
  const bytes = Array.from({ length: 16 }, () => Math.floor(random() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Prefect names its runs after an adjective and an animal; so does the fixture.
const ADJECTIVES = ["amber", "brisk", "calm", "dapper", "eager", "fuzzy", "gentle", "hardy", "ivory", "jolly", "keen", "lively", "mellow", "nimble", "olive", "plucky", "quiet", "rustic", "silver", "tidy"];
const ANIMALS = ["heron", "otter", "badger", "falcon", "gecko", "ibis", "jackal", "koala", "lemur", "marten", "newt", "ocelot", "puffin", "quail", "raven", "stoat", "tapir", "urchin", "vole", "wombat"];
const runName = () => `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;

const iso = (ms) => new Date(ms).toISOString();
const seconds = (fromMs, toMs) => Math.round((toMs - fromMs) / 10) / 100;
const snake = (name) => name.replace(/Process$/, "").replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

// ---- deployments ------------------------------------------------------------------------------

const cron = (expression, active = true) => ({ kind: "cron", cron: expression, interval_seconds: null, timezone: "UTC", active });
const interval = (secondsBetween) => ({ kind: "interval", cron: null, interval_seconds: secondsBetween, timezone: "UTC", active: true });

// Order matters: deployments[0] is scheduled, and the first manual one is a backfill (App.test.tsx relies on both).
const DEPLOYMENTS = [
  {
    name: "orders_snapshot_daily",
    description: "Daily snapshot of the orders database into the core and mart layers of the lake.",
    tags: ["cadence:daily", "source:postgres", "target:lake", "team:data-platform"],
    schedule: cron("0 3 * * *"),
    parameters: { source_kind: "postgres", feed: "orders" },
    meta: { schema: "shop_orders", sourceKind: "postgres" },
  },
  {
    name: "suppliers_catalog_weekly",
    description: "Weekly load of the suppliers' CSV catalog from SFTP into the core schema.",
    tags: ["cadence:weekly", "source:sftp_csv", "target:core", "team:data-platform"],
    schedule: cron("0 5 * * 3"),
    parameters: { source_kind: "sftp_csv", feed: "suppliers" },
    meta: { schema: "shop_suppliers", sourceKind: "sftp_csv" },
  },
  {
    name: "customer_facts_daily",
    description: "Rebuilds the customer fact table from the core orders and returns.",
    tags: ["cadence:daily", "source:table", "target:mart", "team:data-platform"],
    schedule: cron("0 4 * * *", false),
    parameters: { source_kind: "table", feed: "customer_facts" },
    meta: { schema: "shop_customer_facts", sourceKind: "table" },
  },
  {
    name: "staging_orders_dev",
    description: "Development copy of the orders pipeline; runs against a scratch schema.",
    tags: ["stage:dev", "cadence:daily", "source:postgres", "team:data-platform"],
    schedule: cron("0 2 * * *"),
    parameters: { source_kind: "postgres", feed: "orders" },
    meta: { schema: "shop_orders_dev", sourceKind: "postgres" },
  },
  {
    name: "suppliers_catalog_backfill_by_month",
    description: "One-off backfill of the suppliers' catalog for a given month range.",
    tags: ["mode:backfill", "cadence:manual", "team:data-platform"],
    schedule: null,
    parameters: { from_month: "2026-01", to_month: "2026-01", processes: null },
    meta: { schema: "shop_suppliers", sourceKind: "sftp_csv" },
  },
  {
    name: "orders_snapshot_backfill_by_month",
    description: "One-off backfill of order snapshots for a given month range.",
    tags: ["mode:backfill", "cadence:manual", "team:data-platform"],
    schedule: null,
    parameters: { from_month: "2026-01", to_month: "2026-01", processes: null },
    meta: { schema: "shop_orders", sourceKind: "postgres" },
  },
  {
    name: "inventory_sync_hourly",
    description: "Syncs stock levels from the warehouse API every hour.",
    tags: ["cadence:hourly", "source:http_api", "target:core", "team:data-platform"],
    schedule: interval(3_600),
    parameters: { source_kind: "http_api", processes: null },
    meta: { schema: "shop_inventory", sourceKind: "http_api" },
  },
  {
    name: "returns_reconciliation_daily",
    description: "Reconciles returns reported by the payments API with the orders. Meant to run daily but has no schedule configured.",
    tags: ["cadence:daily", "source:http_api", "target:mart", "team:data-platform"],
    schedule: null,
    parameters: { source_kind: "http_api", feed: "returns" },
    meta: { schema: "shop_returns", sourceKind: "http_api" },
  },
].map((deployment) => ({ id: uuid(), ...deployment }));
const deploymentNamed = (name) => DEPLOYMENTS.find((deployment) => deployment.name === name);

// ---- runs -------------------------------------------------------------------------------------

const EMPTY_PARTITION = "EmptyUserPartitionError: refusing to publish an empty partition";
const FAILURES = [EMPTY_PARTITION, "DanglingFamilyError: parent record missing for batch 2", "InvalidOperationError: unexpected upstream schema version 7"];
const CRASH = "Process exited with signal SIGKILL: process exceeded its memory limit";
const STATE_NAMES = { COMPLETED: "Completed", FAILED: "Failed", CRASHED: "Crashed", RUNNING: "Running" };

/**
 * One letter per run, oldest first: C completed, 2 completed on its 2nd attempt, R completed on its 3rd,
 * F failed, E failed after 3 attempts, X crashed.
 */
const OUTCOMES = {
  C: { state: "COMPLETED", attempts: 1 },
  2: { state: "COMPLETED", attempts: 2 },
  R: { state: "COMPLETED", attempts: 3 },
  F: { state: "FAILED", attempts: 1 },
  E: { state: "FAILED", attempts: 3 },
  X: { state: "CRASHED", attempts: 1 },
};

function outcomeMessage(state, attempts) {
  if (state === "COMPLETED") return "All states completed.";
  if (state === "CRASHED") return CRASH;
  if (attempts > 1) return `Flow run encountered an exception; retries exhausted after ${attempts} attempts`;
  return `Flow run encountered an exception: ${pick(FAILURES)}`;
}

function run(deployment, { expectedMs, startMs, code, durationSeconds, createdBy, parameters }) {
  const { state, attempts } = OUTCOMES[code];
  const endMs = startMs + durationSeconds * SECOND;
  return {
    id: uuid(),
    deployment_id: deployment.id,
    name: runName(),
    state,
    state_name: STATE_NAMES[state],
    state_message: outcomeMessage(state, attempts),
    expected_start_at: expectedMs === null ? null : iso(expectedMs),
    start_at: iso(startMs),
    end_at: iso(endMs),
    duration_seconds: durationSeconds,
    created_by: createdBy,
    run_count: attempts,
    retries: attempts - 1,
    retry_delay_seconds: attempts > 1 ? 60 : 0,
    parameters: parameters ?? deployment.parameters,
  };
}

function typicalSeconds(code, { base, spread }) {
  if (code === "F") return base / 2;
  if (OUTCOMES[code].attempts > 1) return base * 2 + spread;
  return base + randomInt(0, spread / 60) * 60;
}

/** A run every `stepMs`, the last one at `lastMs`; scheduled runs start 3 s after their expected time. */
function scheduledRuns(deployment, lastMs, stepMs, codes, durations) {
  return [...codes].map((code, index) => {
    const expectedMs = lastMs - (codes.length - 1 - index) * stepMs;
    return run(deployment, { expectedMs, startMs: expectedMs + 3 * SECOND, code, durationSeconds: typicalSeconds(code, durations), createdBy: SCHEDULER });
  });
}

/** Runs an operator started by hand, `daysAgo` before the anchor at `hourUtc`. */
function manualRuns(deployment, daysAgo, hourUtc, codes, durations, parametersOf = () => undefined) {
  return [...codes].map((code, index) => {
    const startMs = ANCHOR - daysAgo[index] * DAY - (13 - hourUtc) * HOUR;
    return run(deployment, { expectedMs: null, startMs, code, durationSeconds: typicalSeconds(code, durations), createdBy: OPERATOR, parameters: parametersOf(index) });
  });
}

/** `hourUtc:minute` on the anchor's day. */
const at = (hourUtc, minute = 0) => ANCHOR - (13 - hourUtc) * HOUR + minute * MINUTE;
const monthParameters = (index) => {
  const month = `2026-${String((index % 8) + 1).padStart(2, "0")}`;
  return { from_month: month, to_month: month, processes: null };
};
const BACKFILL_DAYS = [37, 33, 28, 25, 21, 16, 13, 9, 4, 3, 2, 1];

const orders = deploymentNamed("orders_snapshot_daily");
const suppliers = deploymentNamed("suppliers_catalog_weekly");
const customerFacts = deploymentNamed("customer_facts_daily");
const stagingOrders = deploymentNamed("staging_orders_dev");
const suppliersBackfill = deploymentNamed("suppliers_catalog_backfill_by_month");
const ordersBackfill = deploymentNamed("orders_snapshot_backfill_by_month");
const inventory = deploymentNamed("inventory_sync_hourly");
const returns = deploymentNamed("returns_reconciliation_daily");

const RUNS = [
  ...scheduledRuns(orders, at(3), DAY, "CFXCC2CCCCCC", { base: 240, spread: 180 }),
  ...scheduledRuns(suppliers, at(5), 7 * DAY, "CCCCXCRCCCCC", { base: 180, spread: 180 }),
  ...scheduledRuns(customerFacts, at(4), DAY, "CCCCCCXECCCF", { base: 180, spread: 240 }),
  ...scheduledRuns(stagingOrders, at(2), DAY, "CFCCFCCCXRFC", { base: 120, spread: 240 }),
  ...manualRuns(suppliersBackfill, BACKFILL_DAYS, 10, "XCCCFCCCCCRC", { base: 1_500, spread: 600 }, monthParameters),
  ...manualRuns(ordersBackfill, BACKFILL_DAYS, 10, "CCXCCCCFCCCR", { base: 1_500, spread: 600 }, monthParameters),
  ...scheduledRuns(inventory, at(12, 15), HOUR, "CCXCCCCFCC2C", { base: 60, spread: 180 }),
  ...manualRuns(returns, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], 12, "RCCCXCCCCCFC", { base: 240, spread: 180 }),
];
const runsOf = (deployment) => RUNS.filter((candidate) => candidate.deployment_id === deployment.id);

// ---- curated task trees -----------------------------------------------------------------------

/** Steps of one process, back to back from `startMs`; `plan` gives each step's name, length and outcome. */
function buildSteps(schema, base, startMs, plan, { rowsFrom, versionFrom, readsFrom = null }) {
  let cursor = startMs;
  let previous = readsFrom;
  return plan.map(({ name, length, state }, index) => {
    const stepStart = cursor;
    const open = state === "RUNNING" || state === "INTERRUPTED";
    cursor += length * SECOND;
    const produced = state === "COMPLETED";
    const target = `${schema}.${base}_${index}`;
    const step = {
      name,
      task_run_id: uuid(),
      state,
      start_at: iso(stepStart),
      end_at: open ? null : iso(cursor),
      duration_seconds: open ? null : length,
      reads: previous === null ? [] : [previous],
      writes: produced ? [target] : [],
      rows: produced ? rowsFrom + index * 37 : null,
      delta_version: produced ? versionFrom + index : null,
    };
    if (produced) previous = target;
    return step;
  });
}

function processOf(name, { marker = true, expectedSteps, steps }) {
  const last = steps.at(-1);
  const failed = steps.some((step) => step.state === "FAILED");
  const state = failed ? "FAILED" : last.state === "COMPLETED" ? "COMPLETED" : last.state;
  const startMs = Date.parse(steps[0].start_at);
  return {
    name,
    task_run_id: marker ? uuid() : null,
    state,
    start_at: steps[0].start_at,
    end_at: last.end_at,
    duration_seconds: last.end_at === null ? null : seconds(startMs, Date.parse(last.end_at)),
    expected_steps: marker ? expectedSteps : null,
    steps,
  };
}

const THREE = ["Snapshot", "Merge", "Validate"];
const SEVEN = [...THREE, "Publish", "Profile", "Compare", "Sign"];
const chain = (base, suffixes, length) => suffixes.map((suffix) => ({ name: `${base}${suffix}Step`, length, state: "COMPLETED" }));

/** A sequence of processes, each starting where the previous one ended. */
function processSequence(schema, startMs, specs) {
  let cursor = startMs;
  let version = randomInt(90, 140);
  let readsFrom = null;
  return specs.map(({ name, plan, marker, expectedSteps }) => {
    // A step outside any process (no name) writes under its own step name.
    const table = snake(name ?? plan[0].name.replace(/Step$/, ""));
    const steps = buildSteps(schema, table, cursor, plan, { rowsFrom: randomInt(1_000, 9_000), versionFrom: version, readsFrom });
    version += plan.length;
    readsFrom = steps.findLast((step) => step.writes.length > 0)?.writes[0] ?? readsFrom;
    const process = processOf(name, { marker, expectedSteps: expectedSteps ?? plan.length, steps });
    const lastEnd = steps.at(-1).end_at ?? steps.at(-1).start_at;
    cursor = Date.parse(lastEnd);
    return process;
  });
}

function attemptOf(number, processes, { state, message }) {
  const ended = processes.at(-1).end_at;
  return { number, state, started_at: processes[0].start_at, ended_at: state === "RUNNING" ? null : ended, message, processes };
}

const ORDER_PROCESSES = ["StagingOrdersProcess", "PreparedOrdersProcess", "CustomerFactsProcess", "StagingSuppliersProcess", "CoreSalesProcess", "DimensionRefreshProcess", "FactLoadProcess", "ReconciliationProcess", "PartitionCompactionProcess", "SnapshotPublishProcess", "LineageAuditProcess"];
const SINGLE_PROCESSES = ["SchemaDriftProcess", "RetentionSweepProcess", "ArchiveExportProcess", "IndexRebuildProcess", "MetricsRollupProcess", "AlertEvaluationProcess", "CatalogSyncProcess", "AuditLedgerProcess"];
const base = (name) => name.replace(/Process$/, "");

/** The big run: 20 processes, one of them with 7 steps. */
function bigCompletedTree(target) {
  const specs = [
    ...ORDER_PROCESSES.map((name) => ({ name, plan: chain(base(name), THREE, 24) })),
    { name: "QualityGateProcess", plan: chain("QualityGate", SEVEN, 24) },
    ...SINGLE_PROCESSES.map((name) => ({ name, plan: chain(base(name), [""], 45) })),
  ];
  const processes = processSequence(orders.meta.schema, Date.parse(target.start_at), specs);
  return { attempts: [attemptOf(1, processes, { state: "COMPLETED", message: target.state_message })], expected_steps_known: true };
}

const singleStep = (name) => ({ name, plan: chain(base(name), [""], 45) });

/** Ten one-step processes, then a failing process whose marker task run never got created. */
function failedWithoutMarkerTree(target) {
  const specs = [...ORDER_PROCESSES.slice(0, 10).map(singleStep), { name: "LineageAuditProcess", marker: false, plan: [{ name: "LineageAuditMergeStep", length: 45, state: "FAILED" }] }];
  const processes = processSequence(orders.meta.schema, Date.parse(target.start_at), specs);
  return { attempts: [attemptOf(1, processes, { state: "FAILED", message: target.state_message })], expected_steps_known: true };
}

/** The run still going: nine processes done, the tenth one's step running. */
function runningTree(startMs) {
  const specs = [...ORDER_PROCESSES.slice(0, 9).map(singleStep), { name: "SnapshotPublishProcess", plan: [{ name: "SnapshotPublishStep", length: 45, state: "RUNNING" }] }];
  const processes = processSequence(orders.meta.schema, startMs, specs);
  return { attempts: [attemptOf(1, processes, { state: "RUNNING", message: null })], expected_steps_known: true };
}

/** Two failed attempts and a third that completes, 60 s apart. */
function threeAttemptsTree(target) {
  const messages = ["Flow run encountered an exception: InvalidOperationError: schema mismatch on suppliers.sku", "Flow run encountered an exception: DanglingFamilyError: parent record missing for batch 4"];
  const attempts = [];
  let cursor = Date.parse(target.start_at);
  for (let number = 1; number <= 3; number += 1) {
    const last = number === 3;
    const specs = [
      { name: "StagingSuppliersProcess", plan: chain("StagingSuppliers", THREE.slice(0, 2), 24) },
      { name: "DimensionRefreshProcess", plan: [{ name: "DimensionRefreshSnapshotStep", length: 24, state: "COMPLETED" }, { name: "DimensionRefreshMergeStep", length: 24, state: last ? "COMPLETED" : "FAILED" }] },
    ];
    const processes = processSequence(suppliers.meta.schema, cursor, specs);
    attempts.push(attemptOf(number, processes, { state: last ? "COMPLETED" : "FAILED", message: last ? target.state_message : messages[number - 1] }));
    cursor = Date.parse(processes.at(-1).end_at) + 60 * SECOND;
  }
  return { attempts, expected_steps_known: true };
}

/** A step failing outside any process marker, and a process that expected 8 steps but failed on its 3rd. */
function failedStepOutsideProcessTree(target) {
  const specs = [
    { name: "StagingSuppliersProcess", plan: chain("StagingSuppliers", ["Snapshot"], 30) },
    { name: null, marker: false, plan: [{ name: "CustomerFactsMergeStep", length: 18, state: "FAILED" }] },
    { name: "CustomerFactsProcess", expectedSteps: 8, plan: [...chain("CustomerFacts", THREE.slice(0, 2), 18), { name: "CustomerFactsValidateStep", length: 18, state: "FAILED" }] },
  ];
  const processes = processSequence(customerFacts.meta.schema, Date.parse(target.start_at), specs);
  return { attempts: [attemptOf(1, processes, { state: "FAILED", message: target.state_message })], expected_steps_known: true };
}

/** The container was killed mid-step: the step and its process are left INTERRUPTED. */
function crashedTree(target) {
  const specs = [{ name: "StagingOrdersProcess", plan: [{ name: "StagingOrdersSnapshotStep", length: 24, state: "COMPLETED" }, { name: "StagingOrdersMergeStep", length: 24, state: "INTERRUPTED" }] }];
  const processes = processSequence(stagingOrders.meta.schema, Date.parse(target.start_at), specs);
  return { attempts: [attemptOf(1, processes, { state: "CRASHED", message: target.state_message })], expected_steps_known: true };
}

/** A curated run ends when its tree does (plus a few seconds of teardown), not at the typical length. */
/** A crashed attempt has no end of its own (its step was left open): it ends with the run. */
function fitRunToTree(target, tree, teardownSeconds) {
  const lastAttempt = tree.attempts.at(-1);
  const lastEnd = lastAttempt.ended_at ?? lastAttempt.processes.at(-1).steps.at(-1).start_at;
  const endMs = Date.parse(lastEnd) + teardownSeconds * SECOND;
  target.end_at = iso(endMs);
  target.duration_seconds = seconds(Date.parse(target.start_at), endMs);
  if (lastAttempt.ended_at === null) lastAttempt.ended_at = target.end_at;
}

const ordersRuns = runsOf(orders);
const bigRun = ordersRuns.at(-1);
const failedOrdersRun = ordersRuns[1];
const retriedSuppliersRun = runsOf(suppliers)[6];
const failedFactsRun = runsOf(customerFacts).at(-1);
const crashedDevRun = runsOf(stagingOrders)[8];

const runningStartMs = ANCHOR - 8 * MINUTE;
const RUNNING_RUN = {
  ...run(orders, { expectedMs: runningStartMs, startMs: runningStartMs, code: "C", durationSeconds: 0, createdBy: SCHEDULER }),
  state: "RUNNING",
  state_name: STATE_NAMES.RUNNING,
  state_message: null,
  end_at: null,
  duration_seconds: seconds(runningStartMs, ANCHOR),
};
RUNS.push(RUNNING_RUN);

const TASKS = {};
for (const [target, build, teardown] of [
  [bigRun, bigCompletedTree, 3],
  [retriedSuppliersRun, threeAttemptsTree, 3],
  [failedFactsRun, failedStepOutsideProcessTree, 3],
  [crashedDevRun, crashedTree, 336],
  [failedOrdersRun, failedWithoutMarkerTree, 0],
]) {
  // The curated failures all end on an empty partition, as their step logs say.
  if (target.state === "FAILED") target.state_message = `Flow run encountered an exception: ${EMPTY_PARTITION}`;
  TASKS[target.id] = build(target);
  fitRunToTree(target, TASKS[target.id], teardown);
}
TASKS[RUNNING_RUN.id] = runningTree(runningStartMs);

// ---- curated logs, in loom's log format ---------------------------------------------------------

const pyList = (items) => `[${items.map((item) => `'${item}'`).join(", ")}]`;
const uri = (ref) => `s3://periplo-lake/${ref.replace(".", "/")}`;
const line = (ms, level, message) => ({ timestamp: iso(ms), level, message });

/** What a step logs, 3 s apart; an open step stops after reading, a failed one logs `error` and never publishes. */
function stepLog(step, sourceKind, error) {
  const lines = [];
  let t = Date.parse(step.start_at);
  const push = (level, message) => {
    lines.push(line(t, level, message));
    t += 3 * SECOND;
  };
  push(20, `step start step=${step.name} sources=${pyList(step.reads)}`);
  push(20, `read source kind=${sourceKind} ref=${step.reads[0] ? `TableRef('${step.reads[0]}')` : "None"}`);
  if (step.state === "RUNNING" || step.state === "INTERRUPTED") return lines;
  const rowsRead = step.rows ?? randomInt(0, 40);
  push(20, `{'rows': ${rowsRead}, 'event': 'read complete', 'scope': 'STEP'}`);
  if (step.state === "FAILED") {
    if (error === EMPTY_PARTITION) push(30, `{'scope': 'STEP', 'name': '${step.name}', 'event': 'partition is empty after filters', 'rows': 0}`);
    push(40, `{'scope': 'STEP', 'name': '${step.name}', 'event': '${error}'}`);
    return lines;
  }
  const ref = step.writes[0];
  push(20, `write target ref=TableRef('${ref}')`);
  push(20, `{'mode': 'replace_partitions', 'uri': '${uri(ref)}', 'rows': ${step.rows}, 'cols': ${randomInt(8, 32)}}`);
  push(20, `{'mode': 'replace_partitions', 'uri': '${uri(ref)}', 'version': ${step.delta_version}, 'rows': None, 'bytes': None, 'files': None, 'event': 'delta write complete'}`);
  push(20, `{'scope': 'STEP', 'name': '${step.name}', 'duration_ms': ${step.duration_seconds * 1_000}, 'trace_id': '${uuid()}', 'correlation_id': '${uuid()}'}`);
  return lines;
}

// Infrastructure chatter every run prints before the pipeline starts; the API can fold it away as noise.
function preamble(target, deployment) {
  const startMs = Date.parse(target.start_at);
  return [
    line(startMs, 20, `Beginning flow run '${target.name}' for flow '${deployment.name}'`),
    line(startMs + 1_200, 20, "IntoHistory declared without 'partition_scope'; defaulting to the full table"),
    line(startMs + 2_400, 20, `Retrieving ECS task definition ${TASK_DEFINITION}`),
    line(startMs + 3_600, 20, "Using ECS task role credentials from the container metadata endpoint"),
  ];
}

const EXCEPTION_PREFIX = "Flow run encountered an exception: ";
const FINISHED = { COMPLETED: ["Completed", 20], FAILED: ["Failed", 40], CRASHED: ["Crashed", 50] };

function curatedLogs(target) {
  const deployment = DEPLOYMENTS.find((candidate) => candidate.id === target.deployment_id);
  const { sourceKind } = deployment.meta;
  const flow = preamble(target, deployment);
  const tasks = {};
  for (const attempt of TASKS[target.id].attempts) {
    for (const process of attempt.processes) {
      if (process.task_run_id !== null) {
        const mark = line(Date.parse(process.start_at), 20, `process start process=${process.name} nodes=${process.expected_steps}`);
        flow.push(mark);
        tasks[process.task_run_id] = [mark];
      }
      const error = attempt.message?.replace(EXCEPTION_PREFIX, "") ?? EMPTY_PARTITION;
      for (const step of process.steps) tasks[step.task_run_id] = stepLog(step, sourceKind, error);
    }
    if (attempt.state === "FAILED" && attempt.number < target.run_count) {
      flow.push(line(Date.parse(attempt.ended_at), 40, `Finished in state AwaitingRetry('${attempt.message}')`));
      flow.push(line(Date.parse(attempt.ended_at) + 500, 30, "notifier raised while sending the retry alert; continuing"));
    }
  }
  const [label, level] = FINISHED[target.state];
  flow.push(line(Date.parse(target.end_at), level, `Finished in state ${label}('${target.state_message}')`));
  flow.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { flow, tasks };
}

const LOGS = Object.fromEntries([retriedSuppliersRun, failedFactsRun, crashedDevRun].map((target) => [target.id, curatedLogs(target)]));

// ---- output and invariants --------------------------------------------------------------------

const publicDeployment = ({ id, name, description, tags, paused = false, schedule, parameters }) => ({ id, name, flow_name: name, description, tags, paused, schedule, parameters });
const fixture = {
  deployments: DEPLOYMENTS.map(publicDeployment),
  deploymentMeta: Object.fromEntries(DEPLOYMENTS.map((deployment) => [deployment.id, deployment.meta])),
  runs: RUNS,
  tasks: TASKS,
  logs: LOGS,
};

// Names dev/mock-api.mjs looks up to seed its "Running now" demo runs.
const MOCK_DEPLOYMENTS = ["suppliers_catalog_weekly", "returns_reconciliation_daily", "staging_orders_dev"];

function check(condition, message) {
  if (!condition) throw new Error(`etl fixture invariant broken: ${message}`);
}

function checkInvariants(data) {
  const { deployments, runs, tasks, logs } = data;
  check(deployments.length === 8, "8 deployments");
  check(runs.length === 97, "97 runs");
  check(deployments[0].schedule?.kind === "cron" && deployments[0].schedule.active, "deployments[0] has an active cron");
  check(deployments.some((deployment) => deployment.schedule?.kind === "cron"), "at least one cron deployment");
  check(deployments.some((deployment) => deployment.schedule === null), "at least one manual deployment");
  for (const name of MOCK_DEPLOYMENTS) check(deployments.some((deployment) => deployment.name === name), `the mock's ${name} exists`);
  const running = runs.filter((candidate) => candidate.state === "RUNNING");
  check(running.length === 1 && tasks[running[0].id] !== undefined, "one curated RUNNING run");
  check(runs.every((candidate) => candidate.end_at === null || Date.parse(candidate.end_at) <= ANCHOR), "every run ends before the anchor");
  check(runs.some((candidate) => candidate.run_count > 1 && tasks[candidate.id]?.attempts.length === candidate.run_count), "a curated retried run");
  const lines = Object.values(logs).flatMap(({ flow, tasks: byTask }) => [...flow, ...Object.values(byTask).flat()]);
  check(lines.some((entry) => entry.level === 40), "ERROR log lines");
  check(lines.some((entry) => entry.message.startsWith("Finished in state AwaitingRetry")), "a retry in the logs");
  for (const id of [...Object.keys(tasks), ...Object.keys(logs)]) check(runs.some((candidate) => candidate.id === id), `curated ${id} belongs to a run`);
}

checkInvariants(fixture);
const text = `${JSON.stringify(fixture, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(OUTPUT, "utf8");
  if (current !== text) {
    console.error("etl.json is stale: run `npm run fixtures:etl -w periplo-web`");
    process.exit(1);
  }
  console.log("etl.json is up to date");
} else {
  writeFileSync(OUTPUT, text);
  console.log(`wrote etl.json: ${fixture.deployments.length} deployments, ${fixture.runs.length} runs`);
}
