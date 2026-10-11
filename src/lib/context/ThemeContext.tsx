"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type AppTheme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  theme: AppTheme;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: AppTheme) => void;
  toggleTheme: () => void;
}

const STORAGE_KEY = "sppg_theme";

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<AppTheme>("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>("dark");

  const applyTheme = useCallback(
    (newTheme: AppTheme, sysTheme: ResolvedTheme) => {
      const resolved = newTheme === "system" ? sysTheme : newTheme;
      setResolvedTheme(resolved);

      if (typeof document !== "undefined") {
        const root = document.documentElement;
        root.setAttribute("data-theme", resolved);
        if (resolved === "dark") {
          root.classList.add("dark");
          root.classList.remove("light");
        } else {
          root.classList.add("light");
          root.classList.remove("dark");
        }
      }
    },
    [],
  );

  useEffect(() => {
    try {
      const savedTheme = localStorage.getItem(STORAGE_KEY) as AppTheme | null;
      const initialTheme: AppTheme =
        savedTheme === "light" ||
        savedTheme === "dark" ||
        savedTheme === "system"
          ? savedTheme
          : "system";

      setThemeState(initialTheme);
      applyTheme(initialTheme, getSystemTheme());
    } catch {
      applyTheme("system", getSystemTheme());
    }

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const handleMediaChange = () => {
      setThemeState((currentTheme) => {
        if (currentTheme === "system") {
          applyTheme("system", mediaQuery.matches ? "dark" : "light");
        }
        return currentTheme;
      });
    };

    mediaQuery.addEventListener("change", handleMediaChange);
    return () => mediaQuery.removeEventListener("change", handleMediaChange);
  }, [applyTheme]);

  const setTheme = useCallback(
    (newTheme: AppTheme) => {
      setThemeState(newTheme);
      try {
        localStorage.setItem(STORAGE_KEY, newTheme);
      } catch {
        // Silently ignore storage quota or private mode issues
      }
      applyTheme(newTheme, getSystemTheme());
    },
    [applyTheme],
  );

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  const value = useMemo(
    () => ({
      theme,
      resolvedTheme,
      setTheme,
      toggleTheme,
    }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    return {
      theme: "system",
      resolvedTheme: "dark",
      setTheme: () => undefined,
      toggleTheme: () => undefined,
    };
  }
  return context;
}
