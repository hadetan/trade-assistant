import { useState } from "react";
import "./ThemeToggle.css";

const THEME_KEY = "chatTheme";
export type ChatTheme = "dark" | "light";

export function useChatTheme(): [ChatTheme, () => void] {
  const [theme, setTheme] = useState<ChatTheme>(() => {
    const saved = globalThis.localStorage?.getItem(THEME_KEY);
    return saved === "light" || saved === "dark" ? saved : "dark";
  });
  const toggle = (): void =>
    setTheme((prev) => {
      const next = prev === "dark" ? "light" : "dark";
      globalThis.localStorage?.setItem(THEME_KEY, next);
      return next;
    });
  return [theme, toggle];
}

export function ThemeToggle({ theme, onToggle }: { theme: ChatTheme; onToggle: () => void }): JSX.Element {
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      aria-label={`switch to ${theme === "dark" ? "light" : "dark"} theme`}
    >
      {theme === "dark" ? "☀" : "☾"}
    </button>
  );
}
