export type Theme = 'dark' | 'light';

function systemTheme(): Theme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Explicit user choice wins if they've ever toggled; otherwise follow the OS. */
export function getTheme(): Theme {
  const saved = localStorage.getItem('theme');
  return saved === 'dark' || saved === 'light' ? saved : systemTheme();
}

/** Paints the theme only — does not persist. Used for the initial render and
 * for live OS theme changes while the user hasn't overridden anything. */
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  window.dispatchEvent(new CustomEvent('themechange'));
}

/** An explicit user choice (the toggle button) — persists so it sticks across reloads. */
export function setUserTheme(theme: Theme) {
  localStorage.setItem('theme', theme);
  applyTheme(theme);
}

/** Call once on boot: re-applies the OS theme live if the user hasn't overridden it. */
export function watchSystemTheme(onChange: (theme: Theme) => void) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => {
    if (!localStorage.getItem('theme')) onChange(systemTheme());
  };
  mq.addEventListener('change', handler);
  return () => mq.removeEventListener('change', handler);
}
