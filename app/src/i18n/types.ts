export type Lang = "pt-BR" | "en";
export const LANGS: readonly Lang[] = ["pt-BR", "en"];

/** Flat key → text map. Text may carry `{name}` placeholders. */
export type Dict = Record<string, string>;

/** What every src/i18n/<feature>.ts file default-exports. pt-BR is the source. */
export type Namespace = Record<Lang, Dict>;

/** Helper for feature files: `export default defineMessages({ "pt-BR": {...}, en: {...} })`. */
export function defineMessages<T extends Namespace>(ns: T): T {
  return ns;
}
