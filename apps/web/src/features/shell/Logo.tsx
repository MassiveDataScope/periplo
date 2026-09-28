import styles from "./Logo.module.css";

export interface LogoProps {
  /** `sm` for a favicon-sized mark, `md` for the menu, `lg` where there is room for the shell in the porthole. */
  readonly size?: "sm" | "md" | "lg";
  /** The periscope rises and lowers while something is being read. */
  readonly busy?: boolean;
  readonly className?: string;
}

const HULL = "M4 19c0-4 4-7 10-7h7c5 0 8 3 8 7s-3 7-8 7h-7c-6 0-10-3-10-7z";
const TOWER = "M12 12.4V8.5A1.5 1.5 0 0 1 13.5 7h5A1.5 1.5 0 0 1 20 8.5v3.9z";
const hole = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

const PORTHOLES = {
  sm: hole(21, 19, 3),
  md: `${hole(12, 19, 2.1)}${hole(18, 19, 2.1)}${hole(24, 19, 2.1)}`,
  lg: `${hole(9.5, 19, 1.7)}${hole(14.5, 19, 1.7)}${hole(22.5, 19, 4.6)}`,
};

/**
 * The product mark (provisional): a friendly solid submarine, all in ink, with a spiral shell in the
 * main porthole when there is room for it. Decorative: the link or
 * heading around it carries the name. The view box hugs the drawing, so the mark fills the size it is given.
 */
export function Logo({ size = "md", busy = false, className }: LogoProps) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="1 2 29 25" data-busy={busy || undefined} className={[styles.logo, className].filter(Boolean).join(" ")}>
      <path className={styles.periscope} d={size === "sm" ? "M16 8V3.5h4" : "M16 7V3.5h3.5"} data-size={size} />
      <path className={styles.body} fillRule="evenodd" d={`${HULL}${PORTHOLES[size]}${TOWER}`} />
      {size === "sm" ? null : <path className={styles.line} d="M4 19H1.5M1.5 15.5v7" />}
            {size === "lg" ? <path className={styles.shell} d="M22.5 19.8h-2.7a2.9 2.9 0 0 1 5.8 0 1.8 1.8 0 0 1-3.6 0" /> : null}
    </svg>
  );
}
