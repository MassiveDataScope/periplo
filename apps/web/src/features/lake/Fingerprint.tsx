import { TYPE_FAMILIES, typeFamily } from "@periplo/core/ui";
import styles from "./Fingerprint.module.css";

/**
 * A table's fingerprint: one strip whose segments are its column type families, in proportion.
 * Tables become recognisable before their names are read. Decorative; the column count is said in text beside it.
 */
export function Fingerprint({ types }: { types: readonly string[] }) {
  const families = types.map(typeFamily);
  return (
    <span aria-hidden="true" className={styles.strip}>
      {TYPE_FAMILIES.map((family) => {
        const count = families.filter((candidate) => candidate === family).length;
        return count > 0 ? <span key={family} data-family={family} className={styles.segment} style={{ flexGrow: count }} /> : null;
      })}
    </span>
  );
}
