const plugin = require('tailwindcss/plugin')

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './src/pages/**/*.{js,ts,jsx,tsx,mdx}',
    './src/components/**/*.{js,ts,jsx,tsx,mdx}',
    './src/app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      transitionTimingFunction: {
        /* emil-design-eng --ease-out */
        'out-ui': 'cubic-bezier(0.23, 1, 0.32, 1)',
        /* better-ui exact press/icon curve */
        'out-strong': 'cubic-bezier(0.2, 0, 0, 1)',
      },
      boxShadow: {
        elev: '0 0 0 1px oklch(1 0 0 / 0.08)',
        'elev-hover': '0 0 0 1px oklch(1 0 0 / 0.13)',
      },
      colors: {
        primary: {
          50: '#f0f9ff',
          500: '#3b82f6',
          600: '#2563eb',
          700: '#1d4ed8',
        },
        success: {
          50: '#f0fdf4',
          500: '#22c55e',
          600: '#16a34a',
        },
        error: {
          50: '#fef2f2',
          500: '#ef4444',
          600: '#dc2626',
        },
      },
    },
  },
  plugins: [
    plugin(function ({ addVariant }) {
      // Touch devices synthesize :hover on tap; gate lift/hover motion.
      addVariant('fine-hover', '@media (hover: hover) and (pointer: fine)')
    }),
  ],
} 