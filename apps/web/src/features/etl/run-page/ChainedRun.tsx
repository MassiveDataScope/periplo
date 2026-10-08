import { Trans } from "react-i18next";
import { href } from "../../../app/routes";
import { useInSection } from "../SectionLinks";
import type { RunLink } from "../useEtl";
import link from "../inline-link.module.css";

/** The sentences that name a chained run, "<etl> › <run>": the run that started this one, or one this one started. */
type ChainedRunSentence = "etl.runPage.triggeredBy" | "etl.runPage.triggered";

/** A chained run named in `sentence`: its ETL and the run itself, each a link to its own page. */
export function ChainedRun({ sentence, run }: { readonly sentence: ChainedRunSentence; readonly run: RunLink }) {
  const inSection = useInSection();
  return (
    <Trans
      i18nKey={sentence}
      values={{ etl: run.etl, run: run.run_name }}
      components={{
        etl: <a className={link.inlineLink} href={href(inSection({ kind: "etl-deployment", name: run.etl }))} />,
        run: <a className={link.inlineLink} href={href(inSection({ kind: "etl-run", id: run.run_id }))} />,
      }}
    />
  );
}
