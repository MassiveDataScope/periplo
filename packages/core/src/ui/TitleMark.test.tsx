// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TitleMark } from ".";

afterEach(cleanup);

describe("TitleMark", () => {
  it("closes a heading without becoming part of its accessible name", () => {
    render(
      <h2>
        orders
        <TitleMark />
      </h2>,
    );
    expect(screen.getByRole("heading", { name: "orders" })).toBeTruthy();
  });
});
