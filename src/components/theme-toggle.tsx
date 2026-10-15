"use client";

import { setTheme, useTheme } from "@/lib/client/use-theme";

export function ThemeToggle({ className = "" }: { className?: string }) {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={`tl-press grid h-7 w-7 place-items-center rounded-md border border-white/10 text-slate-300 hover:border-white/25 hover:text-white ${className}`}
    >
      {/* Both icons render; CSS picks one from data-theme, so the server markup is already correct. */}
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden className="light:hidden">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="hidden light:block">
        <path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z" />
      </svg>
    </button>
  );
}
