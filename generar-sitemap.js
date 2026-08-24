/**
 * Genera sitemap.xml con la home + una URL por cada producto del catálogo.
 *
 * IMPORTANTE: las URLs de producto apuntan a las páginas HTML estáticas
 * generadas por scripts/generar-seo.js en /producto/CODIGO-slug/ (NO al
 * formato ?producto=CODIGO-slug de la SPA). Esas páginas estáticas son
 * las que de verdad conviene que Google rastree: tienen el contenido
 * pre-renderizado (title, description, OG, JSON-LD) sin depender de que
 * el crawler ejecute JavaScript. La SPA (/?producto=...) sigue existiendo
 * para la navegación normal del usuario, pero no es la URL "canónica" a
 * indexar — por eso su <link rel="canonical"> (ver app.js) también
 * apunta a la página estática, para no generar contenido duplicado.
 *
 * Este script debe correr DESPUÉS de scripts/generar-seo.js dentro del
 * mismo workflow (mismo orden de productos = mismos slugs, así que en
 * la práctica no hace falta que las carpetas ya existan para calcular
 * las URLs, pero sí conviene mantenerlos como pasos consecutivos del
 * mismo job para que ambos commiteen juntos).
 *
 * USO:
 *   node generar-sitemap.js
 *
 * Necesita dos variables de entorno (o los valores por defecto de abajo):
 *   BASE_URL  -> la URL pública del catálogo (con barra final)
 *   API_URL   -> la URL del backend (la misma que usa config.js / CONFIG_NEGOCIO.API_URL)
 *
 * Ejemplo:
 *   BASE_URL="https://horus254-svg.github.io/Jireh-Mayorista/" API_URL="https://script.google.com/macros/s/XXXX/exec" node generar-sitemap.js
 *
 * Requiere Node 18+ (trae fetch nativo). Pensado para correrse a mano antes
 * de cada deploy, o automático con GitHub Actions (ver workflow sugerido
 * más abajo en el mensaje del chat).
 */

const fs = require("fs");

const BASE_URL = (process.env.BASE_URL || "https://horus254-svg.github.io/Jireh-Mayorista/").trim();
const API_URL = (process.env.API_URL || "").trim();

function generarSlug(texto) {
  return String(texto || "")
    .trim()
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function escapeXml(str) {
  return String(str ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  }[c]));
}

async function main() {
  if (!API_URL) {
    console.error("Falta API_URL. Pasala como variable de entorno, ej:\n  API_URL=\"https://script.google.com/macros/s/XXXX/exec\" node generar-sitemap.js");
    process.exit(1);
  }

  console.log("Descargando catálogo desde:", API_URL);

  const res = await fetch(API_URL + "?action=productos");
  if (!res.ok) {
    console.error("La API respondió con error:", res.status, res.statusText);
    process.exit(1);
  }

  const data = await res.json();
  const productos = (data.productos || []).filter(p => Number(String(p.STOCK ?? "").trim()) > 0);

  console.log("Productos con stock encontrados:", productos.length);

  const hoy = new Date().toISOString().slice(0, 10);
  const baseSinBarra = BASE_URL.replace(/\/+$/, "");

  const urls = [
    `  <url>\n    <loc>${escapeXml(BASE_URL)}</loc>\n    <lastmod>${hoy}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>`
  ];

  const codigosVistos = new Set();

  for (const p of productos) {
    const codigo = String(p.CODIGO ?? "").trim();
    if (!codigo || codigosVistos.has(codigo)) continue; // evita duplicados si el código se repite
    codigosVistos.add(codigo);

    const slug = generarSlug(p.PRODUCTO);
    const loc = `${baseSinBarra}/producto/${encodeURIComponent(codigo)}${slug ? "-" + slug : ""}/`;

    urls.push(
      `  <url>\n    <loc>${escapeXml(loc)}</loc>\n    <lastmod>${hoy}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.8</priority>\n  </url>`
    );
  }

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;

  fs.writeFileSync("sitemap.xml", xml, "utf8");
  console.log(`Listo: sitemap.xml generado con ${urls.length} URLs.`);
}

main().catch(err => {
  console.error("Error generando el sitemap:", err);
  process.exit(1);
});
