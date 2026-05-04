/// <reference types="vite/client" />

declare module "virtual:docs-index" {
  import type { CompiledDoc } from "./markdown/types";
  export const docs: Record<string, CompiledDoc>;
}
