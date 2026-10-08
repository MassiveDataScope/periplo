import type { ApiError } from "@periplo/core/api";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, ErrorNotice } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort } from "../../api/loadable";
import { ParameterField } from "./ParameterField";
import { buildParameters, differingKeys, draftOf, formFields, isChanged, type FormField } from "./run-parameters";
import { StartFromField } from "./StartFromField";
import type { Etl, RunDetail } from "./useEtl";
import styles from "./RunDialog.module.css";

export interface RunDialogProps {
  readonly dependencies: Dependencies;
  readonly etl: Etl;
  readonly open: boolean;
  /** The values the form starts from instead of the schedule's (another run's, to run it again); still compared with
   * the schedule's own. */
  readonly initialParameters?: Record<string, unknown>;
  onClose(): void;
  onLaunched(run: RunDetail): void;
}

/** The parameter "Start from" owns, when the ETL accepts one: no field of its own. */
const PROCESSES = "processes";

/** Runs a deployment once with other values; the core Dialog gives it the top layer and the focus trap. */
export function RunDialog({ dependencies, etl, open, initialParameters, onClose, onLaunched }: RunDialogProps) {
  const titleId = useId();
  return (
    <Dialog open={open} titleId={titleId} className={styles.dialog} onClose={onClose}>
      {/* The Dialog mounts its children only while open, so the form starts from its values every time. */}
      <RunOnceForm dependencies={dependencies} etl={etl} titleId={titleId} initialParameters={initialParameters} onClose={onClose} onLaunched={onLaunched} />
    </Dialog>
  );
}

interface RunOnceFormProps {
  readonly dependencies: Dependencies;
  readonly etl: Etl;
  readonly titleId: string;
  readonly initialParameters?: Record<string, unknown>;
  onClose(): void;
  onLaunched(run: RunDetail): void;
}

interface FormSetup {
  readonly fields: readonly FormField[];
  /** Values no field shows (the processes list "Start from" owns), sent as they were. */
  readonly kept: Readonly<Record<string, unknown>>;
  readonly drafts: Readonly<Record<string, string>>;
}

function setUp(etl: Etl, initialParameters: Record<string, unknown> | undefined): FormSetup {
  const start = initialParameters ?? etl.parameters;
  const owned = etl.accepts_processes ? [PROCESSES] : [];
  const fields = formFields(etl.parameters, start, owned);
  return {
    fields,
    kept: Object.fromEntries(Object.entries(start).filter(([name]) => owned.includes(name))),
    drafts: Object.fromEntries(fields.map((field) => [field.name, draftOf(field.start)])),
  };
}

/** One field per parameter, "Start from" when the ETL takes a processes list, how many values differ from the
 * schedule, and the whole as JSON on demand. */
function RunOnceForm({ dependencies, etl, titleId, initialParameters, onClose, onLaunched }: RunOnceFormProps) {
  const { t } = useTranslation();
  const { client } = dependencies;
  const jsonId = useId();
  const [setup] = useState(() => setUp(etl, initialParameters));
  const [drafts, setDrafts] = useState(setup.drafts);
  const [startFrom, setStartFrom] = useState<readonly string[] | null>(null);
  const [showJson, setShowJson] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  // Closing the dialog mid-request abandons it: a run launched after the form is gone must not navigate anywhere.
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  const built = buildParameters(setup.fields, drafts, setup.kept, startFrom === null ? {} : { [PROCESSES]: startFrom });
  const differing = built.ok ? differingKeys(built.value, etl.parameters).length : null;

  function setDraft(name: string, draft: string): void {
    setDrafts((current) => ({ ...current, [name]: draft }));
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!built.ok) {
      event.currentTarget.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    setFailure(null);
    setPending(true);
    const abort = new AbortController();
    inFlight.current = abort;
    try {
      const { data } = await client.POST("/etl/{name}/runs", { params: { path: { name: etl.name } }, body: { parameters: built.value }, signal: abort.signal });
      if (!data) throw new Error("The run response was empty");
      onLaunched(data);
      onClose();
    } catch (error: unknown) {
      if (isAbort(error)) return;
      setFailure(asApiError(error));
      setPending(false);
    } finally {
      if (inFlight.current === abort) inFlight.current = null;
    }
  }

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <div className={styles.head}>
        <h2 id={titleId} className={styles.title}>
          {t("etl.runOnce.title", { name: etl.name })}
        </h2>
        <p className={styles.intro}>{t("etl.runOnce.intro")}</p>
      </div>
      <div className={styles.fields}>
        {setup.fields.length === 0 ? <p className={styles.intro}>{t("etl.runOnce.noParameters")}</p> : null}
        {setup.fields.map((field) => {
          const draft = drafts[field.name] ?? draftOf(field.start);
          return (
            <ParameterField
              key={field.name}
              field={field}
              draft={draft}
              changed={isChanged(field, draft)}
              problem={built.ok ? null : (built.problems[field.name] ?? null)}
              disabled={pending}
              onChange={(next) => setDraft(field.name, next)}
            />
          );
        })}
        {etl.accepts_processes ? (
          <StartFromField dependencies={dependencies} etlName={etl.name} value={startFrom} disabled={pending} onChange={setStartFrom} />
        ) : null}
        {showJson ? (
          <section id={jsonId} aria-label={t("etl.runOnce.jsonLabel")}>
            <pre className={styles.json}>{built.ok ? JSON.stringify(built.value, null, 2) : t("etl.runOnce.fixFirst")}</pre>
          </section>
        ) : null}
        {failure !== null ? <ErrorNotice title={t("etl.launchFailed")} error={failure} /> : null}
      </div>
      <div className={styles.footer}>
        <span className={styles.summary}>
          {differing !== null ? <span>{differing === 0 ? t("etl.runOnce.same") : t("etl.runOnce.differ", { count: differing })}</span> : null}
          <button
            type="button"
            className={styles.linkButton}
            aria-expanded={showJson}
            aria-controls={showJson ? jsonId : undefined}
            onClick={() => setShowJson((current) => !current)}
          >
            {t("etl.runOnce.seeJson")}
          </button>
        </span>
        <span className={styles.actions}>
          <Button disabled={pending} onClick={onClose}>
            {t("etl.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={pending}>
            {t("etl.runOnce.submit")}
          </Button>
        </span>
      </div>
    </form>
  );
}
