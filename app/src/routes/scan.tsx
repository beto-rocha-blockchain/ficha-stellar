/**
 * Ler QR: camera scanner (qr-scanner) with paste and photo fallbacks.
 * Routes web+stellar:pay -> /pay, a custody pay link (<APP_URL>/p?... or ficha:/p?...) -> /p,
 * the receipt QR (<APP_URL>/r?... or ficha:/r?...) -> /r, and explains the station's WIFI: QR.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import QrScanner from "qr-scanner";
import { toast } from "sonner";
import { CameraOff, ClipboardPaste, Image as ImageIcon, ScanLine, Wifi } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "@/components/CopyButton";
import { PageHeader } from "@/components/PageHeader";
import { useT } from "@/i18n";
import { forgetLastPayment } from "@/pay/last-payment";
import { classifyQr, routeFor, type ScanTarget } from "@/pay/qr";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/scan")({ component: ScanScreen });

function ScanScreen() {
  const t = useT("pay");
  const navigate = useNavigate();
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const [camera, setCamera] = useState<"starting" | "on" | "none" | "denied">("starting");
  const [wifi, setWifi] = useState<Extract<ScanTarget, { kind: "wifi" }> | null>(null);
  const [text, setText] = useState("");
  const lastUnknown = useRef(0);

  const handle = useCallback(
    (raw: string, fromCamera: boolean) => {
      const target = classifyQr(raw);
      // Pay QR -> /pay, receipt -> /r: the same routes the Android deep links take.
      const to = routeFor(target);
      if (to) {
        scannerRef.current?.stop();
        // A station QR scanned again is a new request (more fichas while the
        // session runs): show its Pay form, not the payment already sent.
        if (target.kind === "pay" || target.kind === "custody") forgetLastPayment();
        void navigate({ href: to });
      } else if (target.kind === "wifi") {
        scannerRef.current?.stop();
        setWifi(target);
      } else if (!fromCamera || Date.now() - lastUnknown.current > 4000) {
        // The camera sees the same foreign QR many times a second: toast at most every 4 s.
        lastUnknown.current = Date.now();
        toast.error(t("scan.unknown"));
      }
    },
    [navigate, t],
  );

  useEffect(() => {
    if (wifi) return;
    const video = videoRef.current;
    if (!video) return;
    let alive = true;
    const scanner = new QrScanner(video, (r) => alive && handle(r.data, true), {
      returnDetailedScanResult: true,
      highlightScanRegion: true,
      highlightCodeOutline: true,
      preferredCamera: "environment",
      maxScansPerSecond: 8,
    });
    scannerRef.current = scanner;
    QrScanner.hasCamera()
      .then((has) => {
        if (!alive) return;
        if (!has) {
          setCamera("none");
          return;
        }
        return scanner.start().then(
          () => alive && setCamera("on"),
          (e: unknown) => alive && setCamera(/denied|permission|notallowed/i.test(String(e)) ? "denied" : "none"),
        );
      })
      .catch(() => alive && setCamera("none"));
    return () => {
      alive = false;
      scanner.destroy();
      scannerRef.current = null;
    };
  }, [handle, wifi]);

  const fromImage = async (file: File | undefined) => {
    if (!file) return;
    try {
      const r = await QrScanner.scanImage(file, { returnDetailedScanResult: true });
      handle(r.data, false);
    } catch {
      toast.error(t("scan.noQrInImage"));
    }
  };

  if (wifi) {
    return (
      <div className="space-y-4">
        <PageHeader title={t("scan.wifiTitle")} />
        <div className="rounded-xl border border-border bg-card p-5">
          <Wifi className="h-8 w-8 text-primary" />
          <p className="mt-3 text-sm text-muted-foreground">{t("scan.wifiBody", { ssid: wifi.ssid })}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {wifi.password && <CopyButton value={wifi.password} label={t("scan.wifiPassword")} />}
            <Button onClick={() => setWifi(null)}>
              <ScanLine /> {t("scan.again")}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader title={t("scan.title")} />
      <div className={cn("relative overflow-hidden rounded-xl border border-border bg-black", camera === "none" || camera === "denied" ? "h-40" : "")}>
        <video ref={videoRef} className="aspect-square w-full object-cover md:aspect-video" muted playsInline />
        {camera !== "on" && camera !== "starting" && (
          <div className="absolute inset-0 grid place-items-center bg-card p-6 text-center">
            <div>
              <CameraOff className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">{camera === "denied" ? t("scan.cameraDenied") : t("scan.noCamera")}</p>
            </div>
          </div>
        )}
      </div>
      {camera === "on" && <p className="text-center text-[12px] text-muted-foreground">{t("scan.hint")}</p>}

      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <label htmlFor="qr-text" className="label-op flex items-center gap-1.5">
          <ClipboardPaste className="h-3.5 w-3.5" /> {t("scan.paste")}
        </label>
        <Textarea
          id="qr-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("scan.pastePlaceholder")}
          className="min-h-20 font-mono text-[12px]"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => handle(text, false)} disabled={!text.trim()}>
            {t("scan.open")}
          </Button>
          <Button asChild variant="outline">
            <label className="cursor-pointer">
              <ImageIcon /> {t("scan.fromImage")}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => void fromImage(e.target.files?.[0])} />
            </label>
          </Button>
        </div>
      </div>
    </div>
  );
}
