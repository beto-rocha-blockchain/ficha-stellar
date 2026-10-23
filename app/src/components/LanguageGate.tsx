/** First-run bilingual language chooser. */
import { useUi } from "@/store/ui";
import { useT } from "@/i18n";
import { Brand } from "./Brand";

export function LanguageGate() {
  const langChosen = useUi((s) => s.langChosen);
  const setLang = useUi((s) => s.setLang);
  const t = useT("common");
  if (langChosen) return null;

  const choice =
    "w-full rounded-md border border-border bg-background/40 px-4 py-3 text-sm font-medium transition hover:border-primary/60 hover:bg-primary/10";

  return (
    <div className="fixed inset-0 z-[200] grid place-items-center bg-background/95 px-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border bg-card p-6 text-center shadow-2xl">
        <div className="flex items-center justify-center">
          <Brand className="h-10 w-[125px]" />
        </div>
        <h2 className="mt-5 font-display text-lg font-semibold">{t("lang.title")}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("lang.subtitle")}</p>
        <div className="mt-6 grid gap-2.5">
          <button type="button" onClick={() => setLang("pt-BR")} className={choice}>
            Português (Brasil)
          </button>
          <button type="button" onClick={() => setLang("en")} className={choice}>
            English
          </button>
        </div>
        <p className="mt-4 text-[11px] text-muted-foreground">{t("lang.note")}</p>
      </div>
    </div>
  );
}
