import { Icon } from "./Icon";
import type { TypeFamily } from "./type-family";
import styles from "./TypeBadge.module.css";

const GLYPHS: Record<Exclude<TypeFamily, "temporal">, string> = {
  integer: "#",
  decimal: ".0",
  text: "Aa",
  boolean: "tf",
  nested: "{}",
};

export interface TypeBadgeProps {
  readonly family: TypeFamily;
  /** `plain` drops the filled square: a bare coloured glyph for dense places such as grid headers. */
  readonly variant?: "filled" | "plain";
}

/** Shape, letter and colour say the same thing three times. Decorative: the exact type is announced as text nearby. */
export function TypeBadge({ family, variant = "filled" }: TypeBadgeProps) {
  return (
    <span aria-hidden="true" data-family={family} data-variant={variant} className={styles.badge}>
      {family === "temporal" ? <Icon name="clock" className={styles.glyphIcon} /> : GLYPHS[family]}
    </span>
  );
}
