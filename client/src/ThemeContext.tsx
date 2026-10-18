import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

interface ThemeValue { dark: boolean; toggle: () => void; }
const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [dark, setDark] = useState(() => localStorage.getItem('catalysthub_theme') === 'dark');
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    localStorage.setItem('catalysthub_theme', dark ? 'dark' : 'light');
  }, [dark]);
  const value = useMemo(() => ({ dark, toggle: () => setDark(current => !current) }), [dark]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider.');
  return value;
}
