export type Theme = "dark" | "light";
export const THEME_KEY = "tl_theme";

/** Node colours per theme. Light values are darker and more saturated so they read on a pale stage. */
export const NODE_COLORS: Record<Theme, Record<string, string>> = {
  dark: {
    Repo: "#f8fafc",
    Person: "#fbbf24",
    PullRequest: "#a78bfa",
    Issue: "#fb7185",
    File: "#2dd4bf",
    Directory: "#14b8a6",
    Release: "#4ade80",
    Concept: "#60a5fa",
    Doc: "#cbd5e1",
    Label: "#94a3b8",
    Org: "#f8fafc",
    Chunk: "#f472b6",
    Entity: "#94a3b8",
  },
  light: {
    Repo: "#1e293b",
    Person: "#d97706",
    PullRequest: "#7c3aed",
    Issue: "#e11d48",
    File: "#0d9488",
    Directory: "#0f766e",
    Release: "#16a34a",
    Concept: "#2563eb",
    Doc: "#64748b",
    Label: "#64748b",
    Org: "#1e293b",
    Chunk: "#db2777",
    Entity: "#64748b",
  },
};

/** Inline script for <head>: applies the saved theme before first paint, so there is no flash. */
export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("${THEME_KEY}");if(t!=="light")t="dark";var d=document.documentElement;d.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="light"?"#fbfbfd":"#05060a")}catch(e){}})()`;

/** CSS variables --n-<Label> for DOM swatches (legend, chips, label borders), generated from NODE_COLORS. */
export const NODE_CSS = (["dark", "light"] as const)
  .map((t) => `${t === "dark" ? ":root" : '[data-theme="light"]'}{${Object.entries(NODE_COLORS[t]).map(([k, v]) => `--n-${k}:${v}`).join(";")}}`)
  .join("");

export const nodeVar = (label: string) => `var(--n-${label}, var(--n-Entity))`;
