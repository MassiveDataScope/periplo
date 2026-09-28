import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const eslint = new ESLint({ cwd: ROOT });

async function restricted(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(ROOT, file) });
  return (result?.messages ?? []).filter((message) => message.ruleId === "@typescript-eslint/no-restricted-imports").map((message) => message.message);
}

describe("area boundaries", () => {
  it.each([
    ["src/arrow/x.ts", 'import { useState } from "react";\nexport const a = useState;'],
    ["src/arrow/x.ts", 'import { ApiError } from "../api";\nexport const a = ApiError;'],
    ["src/api/x.ts", 'import { openArrowStream } from "../arrow";\nexport const a = openArrowStream;'],
    ["src/api/x.ts", 'import { tableFromArrays } from "apache-arrow";\nexport const a = tableFromArrays;'],
    ["src/api/x.ts", 'import { useState } from "react";\nexport const a = useState;'],
    ["src/api/react/x.ts", 'import { ResultsGrid } from "../../grid";\nexport const a = ResultsGrid;'],
    ["src/api/react/x.ts", 'import { openArrowStream } from "../../arrow";\nexport const a = openArrowStream;'],
    ["src/grid/x.ts", 'import { ApiError } from "../api";\nexport const a = ApiError;'],
    ["src/grid/x.ts", 'import { ApiError } from "@periplo/core/api";\nexport const a = ApiError;'],
    ["src/ui/x.ts", 'import { formatCell } from "../arrow";\nexport const a = formatCell;'],
    ["src/ui/x.ts", 'import { App } from "../../../../apps/web/src/app/App";\nexport const a = App;'],
    ["playground/x.ts", 'import { App } from "../../../apps/web/src/app/App";\nexport const a = App;'],
    ["src/grid/x.test.ts", 'import { App } from "periplo-web/src/app/App";\nexport const a = App;'],
  ])("rejects a forbidden import in %s", async (file, code) => {
    expect(await restricted(file, code)).not.toEqual([]);
  });

  it.each([
    ["src/api/x.ts", 'import type { BatchSink } from "../arrow";\nexport type A = BatchSink;'],
    ["src/api/react/x.ts", 'import { createQueryController } from "../query-controller";\nexport const a = createQueryController;'],
    ["src/grid/x.ts", 'import { createResultBuffer } from "../arrow";\nimport { Button } from "../ui";\nexport const a = [createResultBuffer, Button];'],
  ])("allows the declared dependency in %s", async (file, code) => {
    expect(await restricted(file, code)).toEqual([]);
  });
});
