import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WordBreaks } from "./WordBreaks";

describe("WordBreaks", () => {
  it("offers a break at each CamelCase and snake_case boundary, keeping the text intact", () => {
    const { container } = render(<WordBreaks text="ModelFactsSnapshotStep_v2" />);
    expect(container.textContent).toBe("ModelFactsSnapshotStep_v2");
    expect(container.querySelectorAll("wbr")).toHaveLength(4);
  });

  it("leaves a single word alone", () => {
    const { container } = render(<WordBreaks text="staging" />);
    expect(container.querySelectorAll("wbr")).toHaveLength(0);
  });
});
