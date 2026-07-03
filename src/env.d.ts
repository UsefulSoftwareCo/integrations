/// <reference types="astro/client" />

declare module "*.wasm?module" {
  const module: WebAssembly.Module;
  export default module;
}

declare module "satori/wasm" {
  export { default, init } from "satori";
  export type { Font } from "satori";
}

// Worker bindings surfaced to on-demand pages by worker/entry.ts (via the
// adapter handler's locals). Partial: prerendered pages build with no runtime.
declare namespace App {
  interface Locals {
    runtime?: {
      env: import("../worker/env.ts").Env;
      ctx: import("../worker/env.ts").ExecutionContext;
    };
  }
}
