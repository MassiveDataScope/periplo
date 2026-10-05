import type { AnchorHTMLAttributes, ButtonHTMLAttributes, Ref } from "react";
import styles from "./Button.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: "primary" | "secondary" | "danger";
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", type = "button", className, ...rest }: ButtonProps) {
  return <button {...rest} type={type} data-variant={variant} className={[styles.button, className].filter(Boolean).join(" ")} />;
}

export interface ButtonLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly href: string;
  readonly variant?: "primary" | "secondary" | "danger";
  readonly ref?: Ref<HTMLAnchorElement>;
}

/** A link that looks like a button: for actions that open another view, so Cmd+click and "copy link" work. */
export function ButtonLink({ variant = "secondary", className, ...rest }: ButtonLinkProps) {
  return <a {...rest} data-variant={variant} className={[styles.button, styles.link, className].filter(Boolean).join(" ")} />;
}
