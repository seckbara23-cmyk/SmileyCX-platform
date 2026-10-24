import type { Config } from 'tailwindcss'

/**
 * XP Client Academy design tokens (XP-BRAND-01).
 *
 * The official charte graphique replaces the inherited Smiley palette — a bright
 * blue (#4a6de5) and coral (#ff7b54) — with XP navy and orange. Changing the
 * tokens here, rather than editing colours file by file, is what rebrands the
 * whole product: every surface already consumes `primary`, `secondary`, `dark`,
 * `light` and `cx-gray`, so the learner LMS, the admin console and the public
 * site all move together and no page can be left behind.
 *
 * Semantic status colours keep their meaning and only take the brief's exact
 * values; the two payment brand colours below are third-party marks and are
 * deliberately untouched.
 */
const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // ── XP Client Academy official palette ──
        primary: {
          DEFAULT: '#1B2A4A',               // --xp-primary, navy
          dark:    '#121D34',               // hover / pressed
          light:   'rgba(27,42,74,0.1)',    // tints
        },
        secondary: {
          DEFAULT: '#E8741E',               // --xp-accent, XP orange
          // Hover. Measured, not guessed: #C75F14 scored 4.29:1 against the
          // dark button text and 4.14:1 against white — it failed AA either
          // way. #D96A18 is still a darkening and holds 5.09:1 with #111827.
          dark:    '#D96A18',
        },
        dark:       '#1B2A4A',              // --xp-text
        light:      '#F5F6F8',              // --xp-surface
        'cx-gray':  '#64748B',              // --xp-text-muted
        'cx-border': '#E2E8F0',             // --xp-border
        footer:     '#111827',              // --xp-footer
        success:    '#16A34A',
        error:      '#DC2626',
        warning:    '#D97706',
        // Présentiel "Bientôt disponible" badge (brief §10)
        'soon-bg':  '#FFF1E6',
        'soon-fg':  '#9A4100',
        // Payment brand colours — third-party marks, never rebranded.
        orange:  '#ff6600', // Orange Money
        wave:    '#1a56db', // Wave
      },
      fontFamily: {
        sans: ['Montserrat', 'Segoe UI', 'Tahoma', 'Geneva', 'Verdana', 'sans-serif'],
      },
      borderRadius: {
        cx: '10px',
      },
      boxShadow: {
        sm:  '0 2px 8px rgba(0,0,0,0.07)',
        md:  '0 6px 24px rgba(0,0,0,0.10)',
        lg:  '0 12px 40px rgba(0,0,0,0.14)',
        btn: '0 6px 20px rgba(232,116,30,0.35)',
      },
      backgroundImage: {
        // The brief replaces the bright blue gradient with a flat navy ground.
        hero:        'linear-gradient(135deg, #1B2A4A 0%, #1B2A4A 100%)',
        'hero-dark': 'linear-gradient(135deg, #111827 0%, #1B2A4A 100%)',
      },
      animation: {
        'fade-up':  'fadeUp 0.55s ease forwards',
        'spin-slow': 'spin 2s linear infinite',
        'pulse-glow': 'pulseGlow 3.5s ease-in-out infinite',
      },
      keyframes: {
        fadeUp: {
          '0%':   { opacity: '0', transform: 'translateY(24px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%,100%': { boxShadow: '0 0 0 0 rgba(27,42,74,0.3)' },
          '60%':     { boxShadow: '0 0 0 10px rgba(27,42,74,0)' },
        },
      },
    },
  },
  plugins: [],
}

export default config
