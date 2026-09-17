tailwind.config = {
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef6f7',
          100: '#e8f4f5',
          500: '#318f9b',
          600: '#27757f',
          700: '#1f5f68',
        },
        shell: {
          bg: '#f4f6f7',
          text: '#1f2a30',
          muted: '#6b7a82',
          border: '#e2e8ea',
        },
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.25' },
        },
      },
      animation: {
        blink: 'blink 1s ease-in-out infinite',
      },
    },
  },
};
