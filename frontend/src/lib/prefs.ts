import { createStore, useStore } from "./store";
import { readString, writeString } from "./storage";
import type { UnitSystem } from "./units";

const unitStore = createStore<UnitSystem>(readString("units") === "oz" ? "oz" : "ml");

export function useUnitSystem(): [UnitSystem, (u: UnitSystem) => void] {
  const value = useStore(unitStore);
  return [
    value,
    (u) => {
      writeString("units", u);
      unitStore.set(u);
    },
  ];
}

export function getGuestName(): string {
  return readString("guestName") ?? "";
}

export function setGuestName(name: string): void {
  writeString("guestName", name.trim() || null);
}
