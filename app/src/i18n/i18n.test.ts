import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatMmss } from "@/pay/format";
import { PIN_EVERY_MS } from "@/wallet/biometric";
import { DICTS, translate } from "./index";

describe("i18n", () => {
  it("has the same keys in pt-BR and en", () => {
    const pt = Object.keys(DICTS["pt-BR"]).sort();
    const en = Object.keys(DICTS.en).sort();
    expect(en.filter((k) => !pt.includes(k))).toEqual([]);
    expect(pt.filter((k) => !en.includes(k))).toEqual([]);
  });

  it("never calls saldo a token", () => {
    for (const lang of ["pt-BR", "en"] as const) {
      for (const [k, v] of Object.entries(DICTS[lang])) {
        expect(`${k}: ${v}`).not.toMatch(/\btokens?\b/i);
      }
    }
  });

  it("names the header lock button by what it does (it shows only while the wallet is unlocked)", () => {
    expect(translate("pt-BR", "common.lock")).toBe("Bloquear carteira");
    expect(translate("en", "common.lock")).toBe("Lock wallet");
    const shell = readFileSync(fileURLToPath(new URL("../components/AppShell.tsx", import.meta.url)), "utf8");
    expect(shell).toContain('aria-label={t("lock")}');
    expect(shell).not.toContain('t("locked")');
  });

  it("tells the payer the session ends if the phone is not plugged in soon, or pauses too long (contract §5)", () => {
    const rule = { "pt-BR": /poucos minutos[^.]*sessão termina.*pausa longa também termina a sessão/, en: /few minutes[^.]*session ends.*long pause also ends the session/ };
    for (const lang of ["pt-BR", "en"] as const) {
      const text = translate(lang, "pay.pay.timeRule");
      expect(text).toMatch(rule[lang]);
      // PLUG_TIMEOUT_SECONDS and PAUSE_TIMEOUT_SECONDS are each station's config, not in the registry.
      expect(text).not.toMatch(/\d/);
    }
  });

  it("gives the History's unused paid time as m:ss with no unit after it, like the receipt (not '0:32 min')", () => {
    for (const lang of ["pt-BR", "en"] as const) {
      for (const key of ["pay.h.unused", "pay.h.unusedShare", "pay.r.unused"]) {
        const text = translate(lang, key, { min: formatMmss(32) });
        expect(text, `${lang} ${key}`).toContain("0:32");
        expect(text, `${lang} ${key}`).not.toMatch(/\d:\d\d\s*min/i);
      }
    }
    const list = readFileSync(fileURLToPath(new URL("../components/SessionList.tsx", import.meta.url)), "utf8");
    expect(list).toContain('t(part < 1 ? "h.unusedShare" : "h.unused", { min: formatMmss(unused) })');
  });

  it("gives the PIN interval as once a week, as PIN_EVERY_MS, never 'every 168 hours'", () => {
    // Change these texts with the constant.
    expect(PIN_EVERY_MS).toBe(7 * 24 * 3600_000);
    const week = { "pt-BR": "uma vez por semana", en: "once a week" };
    for (const lang of ["pt-BR", "en"] as const) {
      for (const key of ["biometric.lock.pinDue", "biometric.offer.note", "biometric.settings.body", "settings.autoLock"]) {
        const text = translate(lang, key, { n: 3 });
        expect(text, `${lang} ${key}`).toContain(week[lang]);
        expect(text, `${lang} ${key}`).not.toMatch(/\{|hours|horas/);
      }
    }
    // The PIN is the PIN: not "senha" in one line and "PIN" in the next.
    expect(translate("pt-BR", "settings.autoLock")).not.toMatch(/senha/i);
  });

  it("says in Ajustes that the app asks for the PIN on each open when biometric unlock is off", () => {
    expect(translate("pt-BR", "settings.autoLockPin")).toMatch(/pede o PIN sempre que você o abre/);
    expect(translate("en", "settings.autoLockPin")).toMatch(/asks for the PIN each time you open it/);
    for (const lang of ["pt-BR", "en"] as const) expect(translate(lang, "settings.autoLockPin")).not.toMatch(/biometri/i);
    const settings = readFileSync(fileURLToPath(new URL("../routes/settings.tsx", import.meta.url)), "utf8");
    expect(settings).toContain('t(biometricOn ? "autoLock" : "autoLockPin")');
    expect(settings).toContain("<BiometricSetting onEnabledChange={setBiometricOn} />");
  });

  it("interpolates and falls back", () => {
    expect(translate("en", "common.fichas", { n: 3 })).toContain("3");
    expect(translate("en", "does.not.exist")).toBe("does.not.exist");
  });

  it("leaves the ficha count of a payment to common.ficha / common.fichas (1 ficha, not 1 fichas)", () => {
    for (const lang of ["pt-BR", "en"] as const) {
      expect(translate(lang, "common.ficha")).toBe("1 ficha");
      // 1 ficha is the default purchase, and a session may allow only one
      // (ficha_minutes = max_session_minutes): these strings must not say "{n} fichas".
      for (const k of ["pay.pay.doneBody", "pay.pay.notEnough", "pay.pay.maxFichas", "pay.pay.sessionFull", "pay.st.maxSession"]) {
        expect(DICTS[lang][k], k).toBeDefined();
        expect(DICTS[lang][k], k).not.toMatch(/\{n\} fichas/);
      }
      expect(translate(lang, "pay.pay.notEnough", { fichas: translate(lang, "common.ficha") })).toContain("1 ficha.");
      expect(translate(lang, "pay.pay.maxFichas", { fichas: translate(lang, "common.ficha"), min: 30 })).toContain("1 ficha (30 min)");
      expect(translate(lang, "pay.st.maxSession", { fichas: translate(lang, "common.ficha"), min: 30, amount: "1", code: "XLM" })).toContain("(1 ficha, 1 XLM)");
    }
  });

  it("never says a payment goes to the station: it goes to the venue (direct) or the Ficha contract (custody)", () => {
    // The station holds no Stellar account (a product rule); Ajustes > Sobre and the venues page say so.
    for (const lang of ["pt-BR", "en"] as const) {
      const about = translate(lang, "settings.aboutBody3");
      expect(about).not.toMatch(/(direto da sua carteira para a estação|straight from your wallet to the station)/);
      expect(about).toMatch(lang === "pt-BR" ? /contrato Ficha.*A estação não tem conta Stellar/ : /Ficha contract.*The station has no Stellar account/);
      // /estabelecimentos: no "100% of each payment" (custody gives the unused time back), both modes named.
      expect(translate(lang, "venues.money.title")).not.toMatch(/100%/);
      expect(translate(lang, "venues.money.body")).toMatch(lang === "pt-BR" ? /custódia.*contrato Ficha sem administrador/ : /custody stations.*Ficha contract that has no administrator/);
      expect(translate(lang, "venues.how.2")).toMatch(lang === "pt-BR" ? /contrato Ficha \(custódia\)/ : /Ficha contract \(custody\)/);
      // The unused time comes back only to a customer who claims it in time (review R2A6): not "the time they did not use", unconditionally.
      const money = translate(lang, "venues.money.body");
      expect(money).toMatch(lang === "pt-BR" ? /se ele ler o comprovante antes do prazo.*inclusive o tempo não reclamado no prazo, vai para o estabelecimento/ : /if they scan the receipt before the deadline.*including unused time not claimed by then, goes to the venue/);
      expect(money).not.toMatch(/o tempo que ele não usou\)|the time they did not use\)/);
      expect(money).toMatch(lang === "pt-BR" ? /guardada no contrato, só para ele/ : /held in the contract, for the venue only/);
    }
    // A custody station's page does not call the host key the receiving address: the escrow receives first.
    const page = readFileSync(fileURLToPath(new URL("../routes/stations/$id.tsx", import.meta.url)), "utf8");
    expect(page).toContain('t(isCustody(s) ? "st.hostKeyCustody" : "st.hostKey")');
  });

  it("gives link previews and the installed app an English description (an international jury)", () => {
    const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
    expect(html).toContain('<html lang="en"');
    expect(html).toMatch(/<meta name="description" content="Ficha: pay-per-minute phone charging on Stellar/);
    for (const tag of ["og:title", "og:description", "og:url", "og:image", "og:type"]) expect(html).toContain(`property="${tag}"`);
    const vite = readFileSync(fileURLToPath(new URL("../../vite.config.ts", import.meta.url)), "utf8");
    expect(vite).toContain('description: "Ficha: pay-per-minute phone charging on Stellar.');
    expect(vite).not.toContain("Carteira Ficha: pague");
  });

  it("says before Mainnet: real money, another balance at the same address, keep the words or key safe", () => {
    const say = {
      "pt-BR": [/dinheiro de verdade/, /endereço é o mesmo.*saldo é outro/, /palavras de recuperação/, /chave secreta/, /^Mainnet: dinheiro de verdade/],
      en: [/real money/, /address is the same.*balance is different/, /recovery words/, /secret key/, /^Mainnet: real money/],
    };
    for (const lang of ["pt-BR", "en"] as const) {
      const keys = ["settings.mainnetMoney", "settings.mainnetBalance", "settings.mainnetWords", "settings.mainnetSecret", "pay.pay.mainnet"];
      keys.forEach((key, i) => expect(translate(lang, key), `${lang} ${key}`).toMatch(say[lang][i]));
    }
    // Switching to Mainnet goes through the dialog; back to the testnet does not.
    const settings = readFileSync(fileURLToPath(new URL("../routes/settings.tsx", import.meta.url)), "utf8");
    expect(settings).toContain('if (id === "public") setMainnetOpen(true);');
  });
});
