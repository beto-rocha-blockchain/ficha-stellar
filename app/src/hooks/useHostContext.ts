/**
 * What host mode's calls need (src/custody/host-store.ts HostContext): the
 * active network, its Soroban RPC, the wallet's address as the host, and the
 * verified registry. null where custody does not exist or with no wallet.
 */
import { useMemo } from "react";
import { getRpc } from "@/custody/escrow";
import type { HostContext } from "@/custody/host-store";
import { useRegistry } from "@/registry";
import { useNetwork } from "@/stellar";
import { useWallet } from "@/wallet";

export function useHostContext(): HostContext | null {
  const net = useNetwork();
  const host = useWallet((s) => s.publicKey);
  const { registry } = useRegistry();
  return useMemo(() => (net.custody && host ? { server: getRpc(net.custody), net, host, registry } : null), [net, host, registry]);
}
