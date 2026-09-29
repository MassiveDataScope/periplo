import styles from "./Icon.module.css";

/** Stroke paths on a 16 × 16 box. One visual weight for the whole product; add a glyph here, never an icon library. */
const PATHS = {
  "chevron-right": "M6 3.5 10.5 8 6 12.5",
  close: "M4 4l8 8M12 4l-8 8",
  search: "M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.6 10.6 14 14",
  clock: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM8 4.5V8l2.5 1.5",
  key: "M6 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.2 7.8 13.5 2.5M11 5l2 2",
  insert: "M8 3v10M3 8h10",
  columns: "M2.5 3h11v10h-11zM6.2 3v10M9.8 3v10",
  table: "M2.5 3h11v10h-11zM2.5 6.5h11M6.5 6.5V13",
  database: "M3 4.5C3 3.4 5.2 2.5 8 2.5s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4.5v7c0 1.1 2.2 2 5 2s5-.9 5-2v-7M3 8c0 1.1 2.2 2 5 2s5-.9 5-2",
  home: "M2.5 7.5 8 2.5l5.5 5v6h-3.5v-4H6v4H2.5z",
  catalog: "M8 2 2 5l6 3 6-3zM2 8l6 3 6-3M2 11l6 3 6-3",
  sql: "M2.5 3h11v10h-11zM5 6.5 7 8.5 5 10.5M8.5 10.5H11",
  discovery: "M13.5 8A5.5 5.5 0 1 1 8 2.5M8 5.5A2.5 2.5 0 1 0 10.5 8M8 8l4.5-4.5",
  sun: "M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1",
  moon: "M13 9.5A5.5 5.5 0 0 1 6.5 3 5.5 5.5 0 1 0 13 9.5z",
  monitor: "M2 3h12v8H2zM6 13.5h4M8 11v2.5",
  copy: "M5.5 5.5h8v8h-8zM10.5 5.5v-3h-8v8h3",
  external: "M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4",
  delta: "M8 2.5 14 13H2zM8 6.5 10.6 11H5.4z",
  bucket: "M2.5 4h11l-1.5 9.5h-8zM2.5 4c0-1 2.5-1.5 5.5-1.5S13.5 3 13.5 4 11 5.5 8 5.5 2.5 5 2.5 4z",
  pin: "M9.5 2.5 13.5 6.5 11 7.5 8.5 10 8.5 12.5 3.5 7.5 6 7.5 8.5 5zM6 10 2.5 13.5",
  sidebar: "M2.5 3h11v10h-11zM6 3v10",
  lock: "M4 7.5h8v6H4zM5.5 7.5V5.5a2.5 2.5 0 0 1 5 0v2",
  alert: "M8 2.5 14 13H2zM8 6.5v3M8 11.2v.3",
  error: "M5.5 2.5h5l3 3v5l-3 3h-5l-3-3v-5zM6 6l4 4M10 6l-4 4",
  join: "M6 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM10 12.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9z",
  pipeline: "M2 3.5h4v4H2zM10 8.5h4v4h-4zM6 5.5h1.5a2 2 0 0 1 2 2v3H10",
  construction: "M6.5 2.5h3L12.5 13h-9zM5.4 6.5h5.2M4.4 9.8h7.2M2 13h12",
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps {
  readonly name: IconName;
  readonly className?: string;
}

/** Always decorative: the control that holds it carries the accessible name. */
export function Icon({ name, className }: IconProps) {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" className={[styles.icon, className].filter(Boolean).join(" ")}>
      <path d={PATHS[name]} />
    </svg>
  );
}
