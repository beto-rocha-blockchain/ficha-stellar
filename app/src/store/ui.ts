/**
 * UI preferences: language and active network. Persisted in localStorage
 * (keys `ficha.lang`, `ficha.lang.chosen`, `ficha.network`), never secrets.
 */
import { create } from "zustand";
import { DEFAULT_NETWORK, isNetworkId, type NetworkId } from "@/config";
import { readPref, writePref } from "@/lib/storage";
import type { Lang } from "@/i18n/types";

function initialLang(): Lang {
  const stored = readPref("ficha.lang");
  if (stored === "pt-BR" || stored === "en") return stored;
  const nav = typeof navigator !== "undefined" ? navigator.language : "pt-BR";
  // pt-BR is the default; only an explicitly non-Portuguese device starts in English.
  return nav && !nav.toLowerCase().startsWith("pt") && nav.toLowerCase().startsWith("en") ? "en" : "pt-BR";
}

function initialNetwork(): NetworkId {
  const stored = readPref("ficha.network");
  return isNetworkId(stored) ? stored : DEFAULT_NETWORK;
}

interface UiState {
  lang: Lang;
  /** false until the user picks a language in the first-run chooser. */
  langChosen: boolean;
  network: NetworkId;
  setLang: (lang: Lang) => void;
  setNetwork: (network: NetworkId) => void;
}

export const useUi = create<UiState>()((set) => ({
  lang: initialLang(),
  langChosen: readPref("ficha.lang.chosen") === "1",
  network: initialNetwork(),
  setLang: (lang) => {
    writePref("ficha.lang", lang);
    writePref("ficha.lang.chosen", "1");
    if (typeof document !== "undefined") document.documentElement.lang = lang;
    set({ lang, langChosen: true });
  },
  setNetwork: (network) => {
    writePref("ficha.network", network);
    set({ network });
  },
}));
