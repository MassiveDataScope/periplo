import { createContext, useCallback, useContext, type ReactNode } from "react";
import { etlListQuery, withEtlListQuery } from "../../app/etl-routes";
import type { Route } from "../../app/routes";

type InSection = (target: Route) => Route;

/** Outside the section's views (a component's own test), a link is taken as it is. */
const SectionRoute = createContext<InSection>((target) => target);

/**
 * Gives every link inside the side list's filter of `route`, the section's route on screen: each row, bar and crumb
 * asks this one helper (`useInSection`), and nothing listens to the URL for it.
 */
export function SectionLinks({ route, children }: { readonly route: Route; readonly children: ReactNode }) {
  const q = etlListQuery(route);
  const inSection = useCallback((target: Route) => withEtlListQuery(target, q), [q]);
  return <SectionRoute value={inSection}>{children}</SectionRoute>;
}

/** A link target within the ETL section, carrying the side list's filter on screen. */
export function useInSection(): InSection {
  return useContext(SectionRoute);
}
