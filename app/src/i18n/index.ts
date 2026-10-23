/**
 * i18n: one file per feature, merged here automatically.
 *
 * To add strings for your feature, create `src/i18n/<feature>.ts`:
 *
 *   import { defineMessages } from "./types";
 *   export default defineMessages({
 *     "pt-BR": { title: "Pagar", fichas: "{n} fichas" },
 *     en:      { title: "Pay",   fichas: "{n} fichas" },
 *   });
 *
 * Keys become `<feature>.<key>` (the file name is the namespace). You never
 * edit this file. In a component: `const t = useT("pay"); t("fichas", { n: 3 })`.
 * A missing English key falls back to pt-BR, then to the key itself.
 * src/i18n/i18n.test.ts fails the build's tests if pt-BR and en keys differ.
 */
import { useCallback } from "react";
import { useUi } from "@/store/ui";
import { LANGS, type Dict, type Lang, type Namespace } from "./types";

export { LANGS, defineMessages, type Lang, type Namespace } from "./types";

const modules = import.meta.glob<{ default: Namespace }>(["./*.ts", "!./index.ts", "!./types.ts", "!./*.test.ts"], {
  eager: true,
});

function merge(): Record<Lang, Dict> {
  const out: Record<Lang, Dict> = { "pt-BR": {}, en: {} };
  for (const [path, mod] of Object.entries(modules)) {
    const ns = path.replace(/^\.\//, "").replace(/\.ts$/, "");
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(mod.default[lang] ?? {})) out[lang][`${ns}.${k}`] = v;
    }
  }
  return out;
}

export const DICTS: Record<Lang, Dict> = merge();

export type Vars = Record<string, string | number>;

export function translate(lang: Lang, key: string, vars?: Vars): string {
  const raw = DICTS[lang][key] ?? DICTS["pt-BR"][key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

/** Translate outside React (toasts from plain modules, errors). Uses the current language. */
export function tr(key: string, vars?: Vars): string {
  return translate(useUi.getState().lang, key, vars);
}

/**
 * `const t = useT("home")` → `t("title")` reads `home.title`.
 * `const t = useT()` → full keys, e.g. `t("common.copy")`.
 */
export function useT(ns?: string): (key: string, vars?: Vars) => string {
  const lang = useUi((s) => s.lang);
  return useCallback((key: string, vars?: Vars) => translate(lang, ns ? `${ns}.${key}` : key, vars), [lang, ns]);
}

export function useLang(): { lang: Lang; setLang: (l: Lang) => void } {
  const lang = useUi((s) => s.lang);
  const setLang = useUi((s) => s.setLang);
  return { lang, setLang };
}
