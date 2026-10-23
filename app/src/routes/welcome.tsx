/** Onboarding: create (show 24 words, confirm 3) or import (words or S... secret), then set a PIN. */
import { useMemo, useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { ArrowLeft, Download, Loader2, PlusCircle, ShieldCheck } from "lucide-react";
import { Brand } from "@/components/Brand";
import { NetworkBadge } from "@/components/NetworkBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { WALLET } from "@/config";
import { useT } from "@/i18n";
import { useSecureScreen } from "@/native/secure-screen";
import { activateNewAccount, useNetwork } from "@/stellar";
import { checkPin, generateWords, isValidSecret, isValidWords, normalizeWords, useWallet } from "@/wallet";

export const Route = createFileRoute("/welcome")({ component: Welcome });

type Step = "intro" | "words" | "check" | "import" | "pin";

function pickThree(): number[] {
  const out = new Set<number>();
  const rnd = new Uint32Array(8);
  while (out.size < 3) {
    crypto.getRandomValues(rnd);
    for (const r of rnd) if (out.size < 3) out.add(r % 24);
  }
  return [...out].sort((a, b) => a - b);
}

function Welcome() {
  const t = useT("wallet");
  const tc = useT("common");
  const [step, setStep] = useState<Step>("intro");
  const [mode, setMode] = useState<"create" | "import">("create");
  const [words, setWords] = useState("");
  const [ack, setAck] = useState(false);
  const [checkIdx, setCheckIdx] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [checkError, setCheckError] = useState(false);
  const [importInput, setImportInput] = useState("");
  const [importError, setImportError] = useState(false);
  // Every step after the intro shows or takes the words or the S... secret.
  useSecureScreen(step !== "intro");

  const list = useMemo(() => (words ? words.split(" ") : []), [words]);

  const startCreate = () => {
    setMode("create");
    setWords(generateWords());
    setAck(false);
    setStep("words");
  };

  const startCheck = () => {
    setCheckIdx(pickThree());
    setAnswers(["", "", ""]);
    setCheckError(false);
    setStep("check");
  };

  const submitCheck = (e: FormEvent) => {
    e.preventDefault();
    const ok = checkIdx.every((i, k) => answers[k].trim().toLowerCase() === list[i]);
    if (ok) setStep("pin");
    else setCheckError(true);
  };

  const submitImport = (e: FormEvent) => {
    e.preventDefault();
    const v = importInput.trim();
    if (isValidWords(v) || isValidSecret(v)) {
      setImportError(false);
      setMode("import");
      setStep("pin");
    } else setImportError(true);
  };

  const back = () => {
    if (step === "check") setStep("words");
    else if (step === "pin") setStep(mode === "create" ? "check" : "import");
    else {
      setWords("");
      setStep("intro");
    }
  };

  return (
    <div className="ep-page-in-fade flex min-h-dvh flex-col bg-background">
      <header className="pt-safe border-b border-border">
        <div className="mx-auto flex h-12 max-w-md items-center gap-3 px-4">
          {step !== "intro" && (
            <button type="button" onClick={back} aria-label={tc("back")} className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <Brand className="h-7 w-[88px]" />
          <NetworkBadge className="ml-auto" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-md flex-1 px-4 py-6">
        {step === "intro" && (
          <div className="flex flex-col items-center pt-8 text-center">
            <Brand variant="mark" className="h-20 w-20" />
            <h1 className="mt-6 font-display text-2xl font-semibold tracking-tight">{t("welcome.title")}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{t("welcome.body")}</p>
            <div className="mt-8 grid w-full gap-2.5">
              <Button className="h-11" onClick={startCreate}>
                <PlusCircle /> {t("welcome.create")}
              </Button>
              <Button variant="outline" className="h-11" onClick={() => setStep("import")}>
                <Download /> {t("welcome.import")}
              </Button>
            </div>
          </div>
        )}

        {step === "words" && (
          <div className="space-y-4">
            <h1 className="font-display text-xl font-semibold">{t("create.wordsTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("create.wordsBody")}</p>
            <ol className="grid grid-cols-3 gap-1.5">
              {list.map((w, i) => (
                <li key={i} className="flex items-baseline gap-1.5 rounded-md border border-border bg-card px-2 py-1.5">
                  <span className="w-4 text-right font-mono text-[9px] text-muted-foreground">{i + 1}</span>
                  <span className="font-mono text-[12px]">{w}</span>
                </li>
              ))}
            </ol>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1 accent-[var(--primary)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              {t("create.wordsAck")}
            </label>
            <Button className="h-11 w-full" disabled={!ack} onClick={startCheck}>
              {tc("continue")}
            </Button>
          </div>
        )}

        {step === "check" && (
          <form onSubmit={submitCheck} className="space-y-4">
            <h1 className="font-display text-xl font-semibold">{t("create.checkTitle")}</h1>
            <p className="text-sm text-muted-foreground">{t("create.checkBody")}</p>
            {checkIdx.map((idx, k) => (
              <div key={idx} className="space-y-1.5">
                <Label htmlFor={`w${idx}`}>{t("create.wordN", { n: idx + 1 })}</Label>
                <Input
                  id={`w${idx}`}
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="h-11 font-mono"
                  value={answers[k]}
                  onChange={(e) => setAnswers((a) => a.map((x, j) => (j === k ? e.target.value : x)))}
                />
              </div>
            ))}
            {checkError && <p className="text-[12px] text-destructive">{t("create.checkWrong")}</p>}
            <Button type="submit" className="h-11 w-full" disabled={answers.some((a) => !a.trim())}>
              {tc("continue")}
            </Button>
          </form>
        )}

        {step === "import" && (
          <form onSubmit={submitImport} className="space-y-4">
            <h1 className="font-display text-xl font-semibold">{t("import.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("import.body")}</p>
            <Textarea
              rows={5}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="font-mono text-sm"
              placeholder={t("import.placeholder")}
              value={importInput}
              onChange={(e) => setImportInput(e.target.value)}
            />
            {importError && <p className="text-[12px] text-destructive">{t("import.invalid")}</p>}
            <Button type="submit" className="h-11 w-full" disabled={!importInput.trim()}>
              {tc("continue")}
            </Button>
          </form>
        )}

        {step === "pin" && <PinStep mode={mode} words={words} importInput={importInput} />}
      </main>
    </div>
  );
}

function PinStep({ mode, words, importInput }: { mode: "create" | "import"; words: string; importInput: string }) {
  const t = useT("wallet");
  const th = useT("home");
  const net = useNetwork();
  const createFromWords = useWallet((s) => s.createFromWords);
  const importSecret = useWallet((s) => s.importSecret);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!checkPin(pin)) return setError(pin.length < WALLET.pinMinLength ? t("pin.tooShort", { n: WALLET.pinMinLength }) : t("pin.tooSimple"));
    if (pin !== pin2) return setError(t("pin.mismatch"));
    setError(null);
    setBusy(true);
    try {
      if (mode === "create") {
        await createFromWords(words, pin);
        // Testnet: activate the new account with test XLM now, in the background (Home still offers it on failure).
        const created = useWallet.getState().publicKey;
        if (created && net.friendbotUrl) void activateNewAccount(net, created).then((ok) => ok && toast.success(th("friendbotOk")));
      } else {
        const v = importInput.trim();
        if (isValidWords(v)) await createFromWords(normalizeWords(v), pin);
        else await importSecret(v, pin);
      }
      toast.success(t("created"));
      // The root layout redirects once the wallet exists: to a pay link kept from before, else "/".
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <h1 className="inline-flex items-center gap-2 font-display text-xl font-semibold">
        <ShieldCheck className="h-5 w-5 text-primary" /> {t("pin.createTitle")}
      </h1>
      <p className="text-sm text-muted-foreground">{t("pin.createBody", { n: WALLET.pinMinLength })}</p>
      <div className="space-y-1.5">
        <Label htmlFor="pin1">{t("pin.label")}</Label>
        <Input id="pin1" type="password" autoComplete="new-password" className="h-11 font-mono tracking-[0.3em]" value={pin} onChange={(e) => setPin(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="pin2">{t("pin.confirm")}</Label>
        <Input id="pin2" type="password" autoComplete="new-password" className="h-11 font-mono tracking-[0.3em]" value={pin2} onChange={(e) => setPin2(e.target.value)} />
      </div>
      {error && <p className="text-[12px] text-destructive">{error}</p>}
      <Button type="submit" className="h-11 w-full" disabled={busy || !pin || !pin2}>
        {busy && <Loader2 className="animate-spin" />}
        {busy ? t("pin.saving") : t("pin.save")}
      </Button>
    </form>
  );
}
