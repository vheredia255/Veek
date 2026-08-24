/**
 * generar-seo.js
 * =================================================================
 * Genera, para cada producto del catálogo, una página HTML estática
 * real en /producto/<CODIGO>-<slug>/index.html con sus propios meta
 * tags (title, description, Open Graph, Twitter Card) y JSON-LD de
 * tipo Product — todo ya "cocinado" en el HTML, sin depender de que
 * el crawler ejecute JavaScript.
 *
 * El sitemap.xml y robots.txt los genera otro Action del repo, así
 * que ESTE script no los toca — solo se ocupa de las páginas
 * estáticas por producto en /producto/. Importante: para que ese
 * otro Action incluya las URLs de /producto/CODIGO-slug/, tiene que
 * correr DESPUÉS de este (o leer los mismos productos con la misma
 * lógica de slug: ver generarSlug() acá abajo).
 *
 * Por qué hace falta esto y no alcanza con app.js:
 * El sitio es un SPA estático (GitHub Pages no tiene servidor), así
 * que todo el contenido se arma con JS después de un fetch a la API.
 * Eso funciona para Googlebot (que sí renderiza JS) siempre y cuando
 * ya conozca la URL — pero:
 *   1) No hay forma de que la "descubra" sin un sitemap.
 *   2) WhatsApp/Facebook/Twitter NO ejecutan JS al armar la vista
 *      previa de un link, así que sin HTML estático con OG tags,
 *      todos los productos compartidos muestran la miniatura genérica
 *      del catálogo en vez de la del producto.
 *
 * Este script corre en un workflow de GitHub Actions (ver
 * .github/workflows/generar-seo.yml) cada vez que hay push a main y
 * además por cron, para que las páginas se mantengan al día con la
 * planilla de Sheets sin que nadie tenga que acordarse de correrlo
 * a mano.
 *
 * Variables de entorno esperadas:
 *   SITE_URL   → ej: https://tuusuario.github.io/tu-repo   (sin / al final)
 *   API_URL    → si no se pasa, se intenta leer de config.js
 * =================================================================
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");

// ---------------------------------------------------------------
// 1) Resolver SITE_URL y API_URL
// ---------------------------------------------------------------

let SITE_URL = process.env.SITE_URL || "";
let API_URL = process.env.API_URL || "";

if (!API_URL) {
    const configPath = path.join(ROOT, "config.js");
    if (fs.existsSync(configPath)) {
        const contenido = fs.readFileSync(configPath, "utf8");
        const match = contenido.match(/API_URL\s*:\s*["'`]([^"'`]+)["'`]/);
        if (match) API_URL = match[1];
    }
}

if (!SITE_URL) {
    console.error("❌ Falta la variable de entorno SITE_URL (ej: https://tuusuario.github.io/tu-repo). Abortando.");
    process.exit(1);
}
if (!API_URL) {
    console.error("❌ No se encontró API_URL (ni en env ni en config.js). Abortando.");
    process.exit(1);
}

SITE_URL = SITE_URL.replace(/\/+$/, "");

// ---------------------------------------------------------------
// 2) Helpers
// ---------------------------------------------------------------

function generarSlug(texto) {
    return String(texto || "")
        .trim()
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function escaparHtml(texto) {
    return String(texto || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function formatearPrecio(precio) {
    const n = Number(String(precio || "").replace(/[^\d.,-]/g, "").replace(",", "."));
    if (!isFinite(n) || n <= 0) return null;
    return n;
}

// ---------------------------------------------------------------
// 3) Traer productos de la API
// ---------------------------------------------------------------

async function obtenerProductos() {
    const res = await fetch(API_URL + "?action=productos");
    if (!res.ok) throw new Error("La API respondió " + res.status);
    const data = await res.json();
    const productos = data.productos || [];
    return productos.filter(p => Number(String(p.STOCK).trim()) > 0);
}

// ---------------------------------------------------------------
// 4) Armar el HTML estático de una página de producto
// ---------------------------------------------------------------

function generarHtmlProducto(producto, nombreNegocio) {
    const slug = generarSlug(producto.PRODUCTO);
    const codigo = encodeURIComponent(producto.CODIGO);
    const rutaRelativa = "producto/" + codigo + (slug ? "-" + slug : "") + "/";
    const urlCanonica = SITE_URL + "/" + rutaRelativa;
    const urlAppConDeepLink = SITE_URL + "/?producto=" + codigo + (slug ? "-" + slug : "");

    const titulo = producto.PRODUCTO + (nombreNegocio ? " | " + nombreNegocio : "");
    const descripcion = String(producto.DESCRIPCION || producto.PRODUCTO || "").slice(0, 160);
    const imagen = producto.IMAGEN || (SITE_URL + "/icon-512.png");
    const precio = formatearPrecio(producto.PRECIO);
    const categoria = producto.CATEGORIA || "";

    const jsonLd = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": producto.PRODUCTO,
        "description": descripcion,
        "image": imagen,
        "sku": String(producto.CODIGO),
        "category": categoria || undefined,
        "offers": {
            "@type": "Offer",
            "url": urlCanonica,
            "priceCurrency": "ARS",
            "price": precio !== null ? precio : undefined,
            "availability": "https://schema.org/InStock"
        }
    };

    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaparHtml(titulo)}</title>
<meta name="description" content="${escaparHtml(descripcion)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${urlCanonica}">

<meta property="og:type" content="product">
<meta property="og:url" content="${urlCanonica}">
<meta property="og:title" content="${escaparHtml(producto.PRODUCTO)}">
<meta property="og:description" content="${escaparHtml(descripcion)}">
<meta property="og:image" content="${escaparHtml(imagen)}">
<meta property="og:locale" content="es_AR">
${nombreNegocio ? `<meta property="og:site_name" content="${escaparHtml(nombreNegocio)}">` : ""}
${precio !== null ? `<meta property="product:price:amount" content="${precio}">
<meta property="product:price:currency" content="ARS">` : ""}

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escaparHtml(producto.PRODUCTO)}">
<meta name="twitter:description" content="${escaparHtml(descripcion)}">
<meta name="twitter:image" content="${escaparHtml(imagen)}">

<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>

<!-- Redirige al usuario real (con JS) al catálogo interactivo,
     manteniendo el deep link para que el Quick View se abra solo.
     Los crawlers que no ejecutan JS (WhatsApp, Facebook, Twitter,
     y Google en su primera pasada) ya se quedan con todo el HTML
     de arriba, que es lo que necesitan. -->
<meta http-equiv="refresh" content="0; url=${urlAppConDeepLink}">
<script>window.location.replace(${JSON.stringify(urlAppConDeepLink)});</script>
</head>
<body>
<h1>${escaparHtml(producto.PRODUCTO)}</h1>
${categoria ? `<p>Categoría: ${escaparHtml(categoria)}</p>` : ""}
<p>${escaparHtml(descripcion)}</p>
${precio !== null ? `<p>Precio: $${precio}</p>` : ""}
<img src="${escaparHtml(imagen)}" alt="${escaparHtml(producto.PRODUCTO)}" width="600">
<p><a href="${urlAppConDeepLink}">Ver este producto en el catálogo</a></p>
</body>
</html>
`;
}

// ---------------------------------------------------------------
// 5) Main
// ---------------------------------------------------------------

async function main() {
    console.log("→ Pidiendo productos a la API...");
    const productos = await obtenerProductos();
    console.log(`→ ${productos.length} productos con stock.`);

    let nombreNegocio = "";
    const configPath = path.join(ROOT, "config.js");
    if (fs.existsSync(configPath)) {
        const contenido = fs.readFileSync(configPath, "utf8");
        const match = contenido.match(/NOMBRE_NEGOCIO\s*:\s*["'`]([^"'`]+)["'`]/);
        if (match) nombreNegocio = match[1];
    }

    // Limpiar carpeta /producto/ previa para no dejar páginas viejas
    // de productos que ya no existen o se quedaron sin stock.
    const dirProductos = path.join(ROOT, "producto");
    fs.rmSync(dirProductos, { recursive: true, force: true });
    fs.mkdirSync(dirProductos, { recursive: true });

    for (const producto of productos) {
        if (!producto.CODIGO || !producto.PRODUCTO) continue;

        const slug = generarSlug(producto.PRODUCTO);
        const codigo = encodeURIComponent(producto.CODIGO);
        const carpeta = path.join(dirProductos, codigo + (slug ? "-" + slug : ""));
        fs.mkdirSync(carpeta, { recursive: true });

        const html = generarHtmlProducto(producto, nombreNegocio);
        fs.writeFileSync(path.join(carpeta, "index.html"), html, "utf8");
    }

    console.log(`✔ Generadas ${productos.length} páginas en /producto/`);
    console.log("  (sitemap.xml y robots.txt los genera el otro Action del repo)");
}

main().catch(err => {
    console.error("❌ Error generando SEO:", err);
    process.exit(1);
});
