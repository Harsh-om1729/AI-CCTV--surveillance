/** @type {import('tailwindcss').Config} */
export default {
  // Ties Tailwind's `dark:` variant to our data-theme attribute (set by
  // ThemeProvider) instead of prefers-color-scheme, so it's an escape hatch
  // for one-off colors that don't go through the CSS-variable token system
  // above (e.g. a raw Tailwind palette color like `emerald-300`).
  darkMode: ['selector', '[data-theme="dark"]'],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Each token reads its RGB channels from a CSS custom property (see
        // styles/index.css) so `bg-bg-surface/40`-style opacity modifiers
        // keep working while the value itself flips with data-theme.
        'bg-primary': 'rgb(var(--bg-canvas) / <alpha-value>)',
        'bg-surface': 'rgb(var(--bg-surface) / <alpha-value>)',
        'bg-surface-raised': 'rgb(var(--bg-surface-raised) / <alpha-value>)',
        'bg-elevated': 'rgb(var(--bg-elevated) / <alpha-value>)',
        'border-subtle': 'rgb(var(--border-subtle) / <alpha-value>)',
        'text-muted': 'rgb(var(--text-muted) / <alpha-value>)',
        'text-dim': 'rgb(var(--text-dim) / <alpha-value>)',
        'text-primary': 'rgb(var(--text-primary) / <alpha-value>)',
        // The one theme-flipping utility: white-ish in dark mode, near-black
        // in light mode. Use it wherever the old design used a literal
        // `white`/`black` opacity wash for a divider, hover tint, or ring.
        ink: 'rgb(var(--ink) / <alpha-value>)',
        'accent-teal': 'rgb(var(--accent-teal) / <alpha-value>)',
        'accent-cyan': 'rgb(var(--accent-cyan) / <alpha-value>)',
        'accent-green': 'rgb(var(--accent-green) / <alpha-value>)',
        'accent-green-deep': 'rgb(var(--accent-green-deep) / <alpha-value>)',
        'accent-yellow': 'rgb(var(--accent-yellow) / <alpha-value>)',
        'accent-red': 'rgb(var(--accent-red) / <alpha-value>)',
        'accent-purple': 'rgb(var(--accent-purple) / <alpha-value>)',
      },
      boxShadow: {
        '3d-card': '0 16px 36px -10px rgba(0,0,0,0.95), inset 0 1px 0 rgba(255,255,255,0.15)',
        '3d-card-hover': '0 20px 42px -10px rgba(0,0,0,0.95), inset 0 1px 0 rgba(255,255,255,0.2)',
        '3d-btn': '0 6px 20px -4px rgba(0,240,255,0.4), inset 0 1px 0 rgba(255,255,255,0.4)',
        'neon-teal': '0 0 20px rgba(0, 240, 255, 0.35)',
        'neon-red': '0 0 20px rgba(255, 0, 85, 0.35)',
        'neon-green': '0 0 20px rgba(0, 255, 136, 0.35)',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}
