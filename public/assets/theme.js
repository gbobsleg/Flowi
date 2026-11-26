tailwind.config = {
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eff6ff',
          100: '#e4f0ff',
          500: '#3f75b9',
          600: '#275d9f',
          700: '#0e4786',
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
