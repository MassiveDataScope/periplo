import { configure } from "@testing-library/react";

// findBy* and waitFor give up after this many milliseconds.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no modal machinery for `<dialog>`: a real browser promotes it to the top layer and traps focus by itself;
// the console's dialogs only need the `open` attribute here, which jsdom does reflect.
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
