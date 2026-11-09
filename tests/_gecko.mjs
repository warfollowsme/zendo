// Module hooks for the tests: let node import the assistant's browser modules.
// Registered by a test with node:module register() before it imports them.
//   chrome://userchrome/content/…  → profile/chrome/resources/…
//   resource://gre/modules/…       → small stand-ins (timers, Subprocess)
// Browser globals (Services…) are set by the test itself on globalThis.

const resources = new URL("../profile/chrome/resources/", import.meta.url);

const STUBS = {
  "resource://gre/modules/Timer.sys.mjs":
    "export const setTimeout = globalThis.setTimeout; export const clearTimeout = globalThis.clearTimeout; export const setInterval = globalThis.setInterval; export const clearInterval = globalThis.clearInterval;",
  "resource://gre/modules/Subprocess.sys.mjs": "export const Subprocess = globalThis.Subprocess ?? {};",
};

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("chrome://userchrome/content/")) {
    return { url: new URL(specifier.slice("chrome://userchrome/content/".length), resources).href, shortCircuit: true };
  }
  if (Object.hasOwn(STUBS, specifier)) {
    return { url: "data:text/javascript," + encodeURIComponent(STUBS[specifier]), shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
