import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['Space Mono', 'monospace'],
        display: ['Inter', 'sans-serif'],
      },
      colors: {
        accent: {
          green: '#4ade80',
          orange: '#fb923c',
          blue: '#60a5fa',
          purple: '#c084fc',
          yellow: '#fbbf24',
          red: '#f87171',
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
