import type { ApiError } from "@periplo/core/api";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog, ErrorNotice } from "@periplo/core/ui";
import type { Dependencies } from "../../app/dependencies";
import { asApiError, isAbort } from "../../api/loadable";
import type { TranslationKey } from "../../i18n";
import type { Etl, RunDetail } from "./useEtl";
import styles from "./RunDialog.module.css";

export interface RunDialogProps {
  readonly dependencies: Dependencies;
  readonly etl: Etl;
  readonly open: boolean;
  /** Seeds the parameters editor instead of `etl.parameters` — a re-run from a failed process's own parameters
   * (plus `processes`), never launched with a single click: the reader still confirms in the form. */
  readonly initialParameters?: Record<string, unknown>;
  /** A short warning shown above the actions, e.g. that `${now…}` placeholders resolve at launch. */
  readonly notice?: ReactNode;
  onClose(): void;
  onLaunched(run: RunDetail): void;
}

type Problem = "invalidJson" | "notAnObject";

const PROBLEM_LABELS: Record<Problem, TranslationKey> = {
  invalidJson: "etl.invalidJson",
  notAnObject: "etl.notAnObject",
};

export type ParsedParameters = { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly problem: Problem };

/** The textarea's text as the request's parameters: JSON, and a plain object rather than null, an array or a scalar. */
export function parseParameters(text: string): ParsedParameters {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, problem: "invalidJson" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, problem: "notAnObject" };
  return { ok: true, value: value as Record<string, unknown> };
}

/** Confirms a run of one deployment with editable parameters; the core Dialog gives it the top layer and the focus trap. */
export function RunDialog({ dependencies, etl, open, initialParameters, notice, onClose, onLaunched }: RunDialogProps) {
  const titleId = useId();
  return (
    <Dialog open={open} titleId={titleId} className={styles.dialog} onClose={onClose}>
      {/* The Dialog mounts its children only while open, so the form starts from its parameters every time. */}
      <RunForm dependencies={dependencies} etl={etl} titleId={titleId} initialParameters={initialParameters} notice={notice} onClose={onClose} onLaunched={onLaunched} />
    </Dialog>
  );
}

interface RunFormProps {
  readonly dependencies: Dependencies;
  readonly etl: Etl;
  readonly titleId: string;
  readonly initialParameters?: Record<string, unknown>;
  readonly notice?: ReactNode;
  onClose(): void;
  onLaunched(run: RunDetail): void;
}

function RunForm({ dependencies, etl, titleId, initialParameters, notice, onClose, onLaunched }: RunFormProps) {
  const { t } = useTranslation();
  const { client } = dependencies;
  const fieldId = useId();
  const problemId = useId();
  const [text, setText] = useState(() => JSON.stringify(initialParameters ?? etl.parameters, null, 2));
  const [problem, setProblem] = useState<Problem | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [pending, setPending] = useState(false);
  // Closing the dialog mid-request abandons it: a run launched after the form is gone must not navigate anywhere.
  const inFlight = useRef<AbortController | null>(null);
  useEffect(() => () => inFlight.current?.abort(), []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const parsed = parseParameters(text);
    if (!parsed.ok) {
      setProblem(parsed.problem);
      return;
    }
    setProblem(null);
    setFailure(null);
    setPending(true);
    const abort = new AbortController();
    inFlight.current = abort;
    try {
      const { data } = await client.POST("/etl/{name}/runs", { params: { path: { name: etl.name } }, body: { parameters: parsed.value }, signal: abort.signal });
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
    <form className={styles.form} onSubmit={(event) => void submit(event)}>
      <h2 id={titleId} className={styles.title}>
        {t("etl.runDialogTitle", { name: etl.name })}
      </h2>
      <label htmlFor={fieldId} className={styles.label}>
        {t("etl.runDialogDescription")}
      </label>
      <textarea
        id={fieldId}
        className={styles.editor}
        value={text}
        rows={10}
        spellCheck={false}
        disabled={pending}
        aria-invalid={problem !== null}
        aria-describedby={problem !== null ? problemId : undefined}
        onChange={(event) => setText(event.target.value)}
      />
      {problem !== null ? (
        <p id={problemId} className={styles.problem}>
          {t(PROBLEM_LABELS[problem])}
        </p>
      ) : null}
      {failure !== null ? <ErrorNotice title={t("etl.launchFailed")} error={failure} /> : null}
      {notice ? (
        <p className={styles.notice} role="note">
          {notice}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button disabled={pending} onClick={onClose}>
          {t("etl.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={pending}>
          {t("etl.runNow")}
        </Button>
      </div>
    </form>
  );
}
