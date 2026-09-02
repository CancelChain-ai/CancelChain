/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Колір несе рівно одне значення — стан згоди. Активні картки кольору не
        // мають узагалі; бурштин — пауза, іржа — скасування й відхилені спроби.
        ground: '#F7F5F1',
        ink: '#16150F',
        hairline: '#DEDAD1',
        rail: '#E6E1D8',
        amber: '#B07A1E',
        rust: '#A33A28',
      },
    },
  },
  plugins: [],
}
