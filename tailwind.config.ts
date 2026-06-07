import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // XP Client Academy brand system
        primary: {
          DEFAULT: '#4a6de5',
          dark:    '#3557c7',
          light:   'rgba(74,109,229,0.1)',
        },
        secondary: {
          DEFAULT: '#ff7b54',
          dark:    '#e5643a',
        },
        dark:    '#1e2235',
        light:   '#f4f6fb',
        'cx-gray': '#6c757d',
        success: '#22c55e',
        error:   '#ef4444',
        warning: '#f59e0b',
        // Payment brand colors
        orange:  '#ff6600', // Orange Money
        wave:    '#1a56db', // Wave
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'Tahoma', 'Geneva', 'Verdana', 'sans-serif'],
      },
      borderRadius: {
        cx: '10px',
      },
      boxShadow: {
        sm:  '0 2px 8px rgba(0,0,0,0.07)',
        md:  '0 6px 24px rgba(0,0,0,0.10)',
        lg:  '0 12px 40px rgba(0,0,0,0.14)',
        btn: '0 6px 20px rgba(255,123,84,0.35)',
      },
      backgroundImage: {
        hero: 'linear-gradient(135deg, #3d5fd6 0%, #5a7ef5 50%, #7c9bff 100%)',
        'hero-dark': 'linear-gradient(135deg, #1e2235 0%, #2d3561 100%)',
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
          '0%,100%': { boxShadow: '0 0 0 0 rgba(74,109,229,0.3)' },
          '60%':     { boxShadow: '0 0 0 10px rgba(74,109,229,0)' },
        },
      },
    },
  },
  plugins: [],
}

export default config
