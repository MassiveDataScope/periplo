// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

afterEach(cleanup);

// jsdom does not implement the modal machinery of `<dialog>`: `showModal`/`close` simply do not
// exist. A real browser promotes the element to the top layer and traps focus by itself; here we
// only need the `open` content attribute (which jsdom does reflect) to move in step with them.
beforeAll(() => {
  if (typeof HTMLDialogElement.prototype.showModal !== "function") {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
  }
  if (typeof HTMLDialogElement.prototype.close !== "function") {
    HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
  }
});

function Fixture({ onClose }: { onClose(): void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        titleId="fixture-title"
        onClose={() => {
          setOpen(false);
          onClose();
        }}
      >
        <h2 id="fixture-title">A dialog</h2>
        <button type="button">Inside</button>
      </Dialog>
    </>
  );
}

describe("Dialog", () => {
  it("opens modally, names itself and closes on Esc, returning focus to the opener", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "A dialog" });
    expect(dialog.hasAttribute("open")).toBe(true);

    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog.hasAttribute("open")).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("closes on a click outside its box, but not on a click inside it", () => {
    const onClose = vi.fn();
    render(<Fixture onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog", { name: "A dialog" });
    dialog.getBoundingClientRect = () => ({ top: 100, left: 100, right: 300, bottom: 300, width: 200, height: 200 }) as DOMRect;

    fireEvent.click(screen.getByRole("button", { name: "Inside" }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog, { clientX: 10, clientY: 10 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("anchors to the bottom-left corner and sizes itself when asked", () => {
    render(
      <Dialog open titleId="t" anchor="corner" size={{ width: "40rem", height: "30rem" }} onClose={() => undefined}>
        <h2 id="t">Peek</h2>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Peek" });
    expect(dialog.getAttribute("data-anchor")).toBe("corner");
    expect(dialog.style.width).toBe("40rem");
    expect(dialog.style.height).toBe("30rem");
  });

  it("anchors to the bottom-right corner, the mirror of `corner`", () => {
    render(
      <Dialog open titleId="t2" anchor="corner-end" size={{ width: "35rem", height: "22rem" }} onClose={() => undefined}>
        <h2 id="t2">Step peek</h2>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Step peek" });
    expect(dialog.getAttribute("data-anchor")).toBe("corner-end");
    expect(dialog.style.width).toBe("35rem");
    expect(dialog.style.height).toBe("22rem");
  });
});
