// Analyse statique du code web (navigateur) et des scripts Node. Regles recommandees
// seulement : on cherche les vraies erreurs, pas le style.
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["dist/**", "ios/**", "node_modules/**", "web/vendor/**", "web/fonts/**"] },
  js.configs.recommended,
  {
    files: ["web/**/*.js", "static/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023, sourceType: "module",
      // Bibliotheques chargees par <script> depuis web/vendor.
      globals: { ...globals.browser, pdfjsLib: "readonly", PDFLib: "readonly", Tesseract: "readonly" },
    },
  },
  {
    files: ["scripts/**/*.mjs", "tests/**/*.mjs", "eslint.config.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
  },
  { rules: { "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }] } },
];
