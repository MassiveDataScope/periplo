import styles from "./Logo.module.css";

/**
 * `sm` draws the periscope alone; `lg`, where there is room, adds the waterline and what lies below it,
 * and only there can the periscope rise and lower while something is being read (`busy`).
 */
export type LogoProps = { readonly size?: "sm"; readonly className?: string } | { readonly size: "lg"; readonly busy?: boolean; readonly className?: string };

/**
 * The product mark (provisional, until the designer's final drawing): the periscope drawn as the l of the
 * wordmark, with the brand dot as its lens. At `lg` the tube crosses a waterline: what is under the surface
 * stays faint, what looks out is in full ink. Decorative: the link or heading around it carries the name.
 * The `sm` drawing is also the favicon and the docs logo (apps/web/public/favicon.svg, docs/_static/logo.svg).
 */
export function Logo(props: LogoProps) {
  const classes = [styles.logo, props.className].filter(Boolean).join(" ");
  if (props.size !== "lg") {
    return (
      <svg aria-hidden="true" focusable="false" viewBox="0 0 48 48" className={classes}>
        <path className={styles.tube} d="M15.1 43.2V15a6.75 6.75 0 0 1 6.75-6.74h2.7" />
        <circle className={styles.lens} cx="31.1" cy="8.26" r="5" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 48 48" data-busy={props.busy || undefined} className={classes}>
      <path className={styles.submerged} d="M24 43V30" />
      <g className={styles.periscope}>
        <path className={styles.round} d="M24 31V18a8 8 0 0 1 8-8" />
        <circle className={styles.lens} cx="40.5" cy="10" r="5.5" />
      </g>
      <path className={styles.water} d="M4 30H44" />
    </svg>
  );
}
