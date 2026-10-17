// Prepare le contenu web embarque dans l'app iOS (dossier dist/, lu par Capacitor).
// La version web est publiee telle quelle par Vercel depuis web/ ; l'app embarque les memes
// fichiers, plus le runtime JavaScript de Capacitor qui donne acces aux modules natifs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "web");
const OUT = path.join(ROOT, "dist");
// Propre au deploiement Vercel, inutile dans l'app.
const SKIP = new Set([".vercel", ".vercelignore", ".gitignore", "vercel.json", "README.md"]);

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(SRC, OUT, { recursive: true, filter: (src) => !SKIP.has(path.basename(src)) });

const CORE = path.join(ROOT, "node_modules", "@capacitor", "core", "dist", "capacitor.js");
if (!fs.existsSync(CORE)) throw new Error("@capacitor/core absent : lancer npm ci");
fs.copyFileSync(CORE, path.join(OUT, "vendor", "capacitor.js"));

// Le runtime se charge avant tout le reste : l'interface sait ainsi des son demarrage
// qu'elle tourne dans l'app.
const index = path.join(OUT, "index.html");
const html = fs.readFileSync(index, "utf8");
const tag = '<script src="vendor/capacitor.js"></script>\n';
if (!html.includes("</head>")) throw new Error("index.html sans </head>");
fs.writeFileSync(index, html.replace("</head>", tag + "</head>"));

const size = (dir) => fs.readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? size(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size), 0);
console.log(`dist/ pret (${(size(OUT) / 1e6).toFixed(1)} Mo)`);
