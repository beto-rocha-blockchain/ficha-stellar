/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  /** Optional Horizon override for testnet. */
  readonly VITE_HORIZON_TESTNET?: string;
  /** Optional Horizon override for the public network. */
  readonly VITE_HORIZON_PUBLIC?: string;
  /** Optional Soroban RPC override for testnet (custody mode). */
  readonly VITE_RPC_TESTNET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.svg?raw" {
  const content: string;
  export default content;
}

/** package.json version, injected by vite.config.ts. */
declare const __APP_VERSION__: string;
