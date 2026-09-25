import type { ButtonHTMLAttributes, Ref } from "react";
import styles from "./Button.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: "primary" | "secondary" | "danger";
  readonly ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", type = "button", className, ...rest }: ButtonProps) {
  return <button {...rest} type={type} data-variant={variant} className={[styles.button, className].filter(Boolean).join(" ")} />;
}
