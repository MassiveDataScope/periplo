import { Fragment } from "react";

/** A CamelCase or snake_case name with a line-break opportunity (`<wbr>`) at each word boundary, so a long
 * process or step name wraps as "ModelFactsSnapshot / Step" rather than mid-word; copying it yields the plain name. */
export function WordBreaks({ text }: { readonly text: string }) {
  const parts = text.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=_)/);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}
