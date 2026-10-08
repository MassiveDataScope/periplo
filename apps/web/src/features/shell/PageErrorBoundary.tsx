import { Component, useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ErrorNotice } from "@periplo/core/ui";
import { href } from "../../app/routes";
import styles from "./PageErrorBoundary.module.css";

interface PageErrorBoundaryProps {
  /** The view on screen: moving to another one starts over, so one broken view does not stick to the next. */
  readonly resetKey: string;
  /** What failed, as a whole sentence: the failure's title and its region's name ("This view could not be shown"). */
  readonly label: string;
  /** Offer a link Home beside Try again: for the work area, not for a side column whose page is still there. */
  readonly homeLink?: boolean;
  readonly children: ReactNode;
}

/** Whatever was thrown, kept as is: `throw null` is still a failure, so the flag is separate from the value. */
type PageErrorBoundaryState =
  { readonly failed: false; readonly resetKey: string } | { readonly failed: true; readonly thrown: unknown; readonly resetKey: string };

/**
 * Catches a view that fails to render and shows the failure in its place, with Try again (and a way Home), instead of
 * React unmounting the whole console. A class: React only lets a class catch render errors.
 */
export class PageErrorBoundary extends Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  override state: PageErrorBoundaryState = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(thrown: unknown): Partial<PageErrorBoundaryState> {
    return { failed: true, thrown };
  }

  static getDerivedStateFromProps(props: PageErrorBoundaryProps, state: PageErrorBoundaryState): PageErrorBoundaryState | null {
    return props.resetKey === state.resetKey ? null : { failed: false, resetKey: props.resetKey };
  }

  override render(): ReactNode {
    const { state } = this;
    if (!state.failed) return this.props.children;
    return (
      <ViewFailed
        label={this.props.label}
        homeLink={this.props.homeLink ?? false}
        thrown={state.thrown}
        onRetry={() => this.setState({ failed: false, resetKey: state.resetKey })}
      />
    );
  }
}

interface ViewFailedProps {
  readonly label: string;
  readonly homeLink: boolean;
  readonly thrown: unknown;
  onRetry(): void;
}

/** Focus lost with the failed content falls back to the body: that, and only that, is the user's focus to move. */
function focusWasHere(region: HTMLElement): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || region.contains(active);
}

/** The failure in words. It takes focus only when the user was in what failed (now gone): never from elsewhere. */
function ViewFailed({ label, homeLink, thrown, onRetry }: ViewFailedProps) {
  const { t } = useTranslation();
  const regionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const region = regionRef.current;
    if (region !== null && focusWasHere(region)) region.focus();
  }, []);
  const error =
    thrown instanceof Error && thrown.message !== ""
      ? { code: thrown.name, message: thrown.message }
      : { code: "render_failed", message: t("shell.viewFailedUnknown") };
  return (
    <section ref={regionRef} tabIndex={-1} aria-label={label} className={styles.failed}>
      <ErrorNotice title={label} error={error} onRetry={onRetry} retryLabel={t("shell.tryAgain")} />
      {homeLink ? <a href={href({ kind: "home" })}>{t("shell.goHome")}</a> : null}
    </section>
  );
}
