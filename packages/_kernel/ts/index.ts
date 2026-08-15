/**
 * The shared TypeScript kernel for Itsuki host adapters.
 *
 * Packages do not depend on this at runtime — they vendor it. Three shipped
 * packages already prove why: every one of them publishes with zero runtime
 * dependencies, and a shared npm package would put a version-resolution
 * problem between a host and its memory. So `scripts/sync-kernel.mjs` copies
 * these files into each package's src/kernel/, and test/kernel-parity.spec.js
 * fails the repo suite the moment a copy drifts from this original.
 */

export * from "./types.js";
export * from "./hash.js";
export * from "./errors.js";
export * from "./scrub.js";
export * from "./inject.js";
export * from "./batching.js";
export * from "./idempotency.js";
export * from "./events.js";
export * from "./transport.js";
