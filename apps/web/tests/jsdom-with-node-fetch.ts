import type { Environment } from "vitest/environments";
import { builtinEnvironments } from "vitest/environments";

/**
 * jsdom replaces AbortController/AbortSignal with its own classes, which
 * Node's `Request` refuses. Browsers have a single implementation, so tests
 * that go through fetch keep Node's pair while still getting a DOM.
 */
export default <Environment>{
  name: "jsdom-with-node-fetch",
  transformMode: "web",
  async setup(global, options) {
    const { AbortController, AbortSignal } = global;
    const environment = await builtinEnvironments.jsdom.setup(global, options);
    // React only honours act() when the environment says it is a test environment.
    Object.assign(global, { AbortController, AbortSignal, IS_REACT_ACT_ENVIRONMENT: true });
    return environment;
  },
};
