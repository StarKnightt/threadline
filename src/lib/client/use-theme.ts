"use client";

import { useSyncExternalStore } from "react";
import { THEME_KEY, type Theme } from "@/lib/theme";

const EVENT = "tl-theme";

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

const read = (): Theme => (document.documentElement.dataset.theme === "light" ? "light" : "dark");

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "dark");
}

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t === "light" ? "#fbfbfd" : "#05060a");
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {}
  window.dispatchEvent(new Event(EVENT));
}
