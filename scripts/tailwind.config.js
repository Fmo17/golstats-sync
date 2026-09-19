/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        campo: {
          DEFAULT: '#0d3b26',   // verde-campo (base)
          escuro: '#071f14',    // verde profundo (fundo geral)
          claro: '#155234',     // verde mais claro (hover/cards)
        },
        ouro: {
          DEFAULT: '#c9a227',   // dourado-troféu (destaque principal)
          claro: '#e0bf52',
        },
        led: {
          ambar: '#ffb92e',     // placar eletrônico (números)
        },
        giz: '#f2ede1',         // branco-giz (texto principal sobre verde)
        tinta: '#1c1c1a',       // tinta-jornal (texto sobre claro)
        alerta: '#b8514f',      // vermelho-cartão (erros/avisos)
        sucesso: '#4f9d6e',     // verde-vitória (positivo)
      },
      fontFamily: {
        display: ['var(--font-fraunces)', 'Georgia', 'serif'],
        sans: ['var(--font-plex-sans)', 'Helvetica', 'Arial', 'sans-serif'],
        mono: ['var(--font-plex-mono)', 'Courier New', 'monospace'],
      },
    },
  },
  plugins: [],
};
