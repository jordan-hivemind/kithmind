// Tailwind v4 is a single PostCSS plugin and no config file: the theme lives
// in `src/app/globals.css` under `@theme`, which is why there is no
// `tailwind.config.js` beside this one.
export default {
  plugins: { "@tailwindcss/postcss": {} },
};
