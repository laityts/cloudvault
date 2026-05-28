/// <reference types="vite/client" />
/// <reference types="solid-js" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
