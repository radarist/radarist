/**
 * Shared type augmentations for the super-graph render harness.
 *
 * The host HTML page sets `window.__SUPER_GRAPH_READY__ = true` once the
 * library has finished rendering into `#target`. The Playwright driver in
 * `render.ts` polls that flag via `page.waitForFunction`. This declaration
 * gives both sides a typed view of the same global without inline casts.
 */
declare global {
  interface Window {
    __SUPER_GRAPH_READY__?: boolean;
  }
}

export {};
