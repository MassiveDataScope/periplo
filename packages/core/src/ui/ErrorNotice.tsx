import { Button } from "./Button";
import styles from "./ErrorNotice.module.css";

/** Structural on purpose: the UI area does not depend on the API area. */
export interface ErrorNoticeError {
  readonly code: string;
  readonly message: string;
  readonly traceId?: string;
  readonly violations?: readonly { readonly field: string; readonly message: string }[];
}

export interface ErrorNoticeProps {
  readonly error: ErrorNoticeError;
  readonly title?: string;
  readonly onRetry?: () => void;
  /** Text of the retry action; the host passes it translated. */
  readonly retryLabel?: string;
}

export function ErrorNotice({ error, title, onRetry, retryLabel = "Retry" }: ErrorNoticeProps) {
  const violations = error.violations ?? [];
  return (
    <div role="alert" className={styles.notice}>
      {title ? <p className={styles.title}>{title}</p> : null}
      <p className={styles.message}>{error.message}</p>
      {violations.length > 0 ? (
        <ul className={styles.violations}>
          {violations.map((violation) => (
            <li key={`${violation.field}:${violation.message}`}>
              <code>{violation.field}</code> <span>{violation.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className={styles.meta}>
        <code>{error.code}</code>
        {error.traceId ? <code>{error.traceId}</code> : null}
      </p>
      {onRetry ? <Button onClick={onRetry}>{retryLabel}</Button> : null}
    </div>
  );
}
