import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ on: true, setSecure: vi.fn(async (_o: { secure: boolean }) => {}) }));
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => native.on, isPluginAvailable: (n: string) => native.on && n === "FichaSecureScreen" },
  registerPlugin: () => ({ setSecure: native.setSecure }),
}));

import { holdSecureScreen } from "./secure-screen";

const calls = () => native.setSecure.mock.calls.map(([o]) => o.secure);

beforeEach(() => {
  native.on = true;
  native.setSecure.mockClear();
});

describe("secure screen", () => {
  it("is on while any screen holds it and off after the last one", () => {
    const words = holdSecureScreen();
    expect(calls()).toEqual([true]);
    const dialog = holdSecureScreen();
    words();
    expect(calls()).toEqual([true]);
    dialog();
    expect(calls()).toEqual([true, false]);
  });

  it("counts a double release once", () => {
    const a = holdSecureScreen();
    const b = holdSecureScreen();
    a();
    a();
    expect(calls()).toEqual([true]);
    b();
    expect(calls()).toEqual([true, false]);
  });

  it("does nothing on the web", () => {
    native.on = false;
    holdSecureScreen()();
    expect(native.setSecure).not.toHaveBeenCalled();
  });
});

// The flag only works if the plugin is registered under the name JS calls,
// and only helps if the screens that show the words use it.
describe("secure screen wiring", () => {
  const read = (p: string) => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
  const java = "../../android/app/src/main/java/app/ficha/wallet/";

  it("registers the Android plugin that sets FLAG_SECURE", () => {
    expect(read(`${java}MainActivity.java`)).toMatch(/registerPlugin\(FichaSecureScreenPlugin\.class\)/);
    const plugin = read(`${java}secure/FichaSecureScreenPlugin.kt`);
    expect(plugin).toMatch(/@CapacitorPlugin\(name = "FichaSecureScreen"\)/);
    expect(plugin).toMatch(/addFlags\(WindowManager\.LayoutParams\.FLAG_SECURE\)/);
  });

  it("is used by onboarding and by the reveal dialog in Ajustes", () => {
    expect(read("../routes/welcome.tsx")).toMatch(/useSecureScreen\(step !== "intro"\)/);
    expect(read("../routes/settings.tsx")).toMatch(/function RevealDialog[\s\S]*useSecureScreen\(open\)/);
  });
});
