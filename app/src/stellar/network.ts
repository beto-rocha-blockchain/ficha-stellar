/** The active network, from the UI store (Ajustes → Rede). */
import { NETWORKS, type NetworkConfig } from "@/config";
import { useUi } from "@/store/ui";

/** Plain code (outside React). */
export function getNetworkConfig(): NetworkConfig {
  return NETWORKS[useUi.getState().network];
}

/** React: re-renders when the user switches network. */
export function useNetwork(): NetworkConfig {
  return NETWORKS[useUi((s) => s.network)];
}
