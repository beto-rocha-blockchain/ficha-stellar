/**
 * Battery Status API (not in lib.dom). Chrome on Android supports it;
 * Firefox and Safari do not, so always feature-detect `navigator.getBattery`.
 */
interface BatteryManager extends EventTarget {
  readonly charging: boolean;
  readonly chargingTime: number;
  readonly dischargingTime: number;
  /** 0..1 */
  readonly level: number;
  onchargingchange: ((this: BatteryManager, ev: Event) => unknown) | null;
  onchargingtimechange: ((this: BatteryManager, ev: Event) => unknown) | null;
  ondischargingtimechange: ((this: BatteryManager, ev: Event) => unknown) | null;
  onlevelchange: ((this: BatteryManager, ev: Event) => unknown) | null;
}

interface Navigator {
  getBattery?: () => Promise<BatteryManager>;
}
