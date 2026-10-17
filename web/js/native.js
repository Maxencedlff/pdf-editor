/* Pont vers les modules natifs de l'app iOS (Capacitor). Le runtime Capacitor n'est
   embarque que dans l'app (scripts/build-web.mjs) : dans le navigateur, `isNative` vaut
   faux et rien ici n'est appele. */

const cap = window.Capacitor;
export const isNative = !!cap?.isNativePlatform?.() && typeof cap.registerPlugin === "function";
const plugin = (name) => (isNative ? cap.registerPlugin(name) : null);
const Filesystem = plugin("Filesystem");
const Share = plugin("Share");
const App = plugin("App");

/** Feuille de partage d'iOS (Enregistrer dans Fichiers, Mail, AirDrop…). Le module Share
    n'accepte que des fichiers sur disque : le PDF passe par le cache de l'app.
    Resout `false` si l'utilisateur ferme la feuille sans rien choisir. */
export async function shareFile(file) {
  const { uri } = await Filesystem.writeFile({ path: file.name, data: await toBase64(file), directory: "CACHE" });
  try {
    await Share.share({ files: [uri], title: file.name });
    return true;
  } catch (e) {
    if (/cancel/i.test(e?.message || "")) return false;
    throw e;
  }
}

/** PDF confie a l'app depuis une autre (« Ouvrir avec », menu Partager) : iOS en depose
    une copie dans la boite de reception de l'app et transmet son adresse, au lancement
    ou pendant que l'app tourne. */
export function onOpenDocument(callback) {
  if (!isNative) return;
  const open = async (url) => {
    if (!url || !/^file:/i.test(url)) return;
    try { callback(await readFile(url)); } catch (e) { console.error(e); }
  };
  App.addListener("appUrlOpen", ({ url }) => open(url));
  App.getLaunchUrl().then((r) => open(r?.url)).catch(() => {});
}

async function readFile(url) {
  const { data } = await Filesystem.readFile({ path: url });
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const name = decodeURIComponent(url.split("/").pop() || "document.pdf");
  return new File([bytes], name, { type: "application/pdf" });
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
