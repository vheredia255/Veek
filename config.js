/**
 * CONFIGURACIÓN DEL NEGOCIO
 * ---------------------------------------------------------
 * Ya NO hay que editar valores acá. Todos los datos del negocio
 * (nombre, WhatsApp, SEO, footer, etc.) se editan desde el panel
 * admin → Configuración → Apariencia, y se guardan en la hoja
 * "CONFIGURACION" de Sheets. Este archivo solo los trae.
 *
 * La única excepción es API_URL: como es la dirección de la API
 * que hay que llamar para traer el resto de la configuración,
 * no puede a su vez guardarse en esa misma API. En vez de tenerla
 * escrita a mano acá (lo que la dejaba fija a un solo cliente),
 * se lee de config.json — el mismo archivo por-instalación que ya
 * usan login.html y admin.js — así este archivo queda igual para
 * todos los clientes y lo único que cambia por instalación es
 * config.json.
 * ---------------------------------------------------------
 */

let API_URL_BASE = "";

// Valores de respaldo, usados únicamente si falla la conexión con
// Sheets (sin internet, la API caída, etc.) — así ninguna página
// se queda en blanco o rota. Genéricos a propósito: no deben tener
// el nombre ni la URL de ningún cliente en particular.
const CONFIG_NEGOCIO_RESPALDO = {
  API_URL: API_URL_BASE,
  NOMBRE_NEGOCIO: "Catálogo",
  NOMBRE_CORTO: "Panel",
  TEMA: "navy",

  URL_SITIO: "",
  WHATSAPP_NUMERO: "",
  WHATSAPP_ICONO_URL: "",
  ICONO_URL: "icon-512.png",

  SEO_TITULO: "Catálogo",
  SEO_DESCRIPCION: "",
  SEO_KEYWORDS: "",

  HERO_TITULO: "Catálogo Online",
  HERO_SUBTITULO: "",

  FOOTER_TITULO_1: "",
  FOOTER_TEXTO_1: "",
  FOOTER_TEXTO_2: "",
  FOOTER_TEXTO_3: "",
  FOOTER_COPYRIGHT: ""
};

// Se completa apenas termina de cargar (ver cargarConfigNegocio()).
// Arranca con los valores de respaldo para que nada quede undefined
// mientras se espera la respuesta del servidor.
let CONFIG_NEGOCIO = { ...CONFIG_NEGOCIO_RESPALDO };

/**
 * Lee la API URL de esta instalación desde config.json (una sola vez,
 * cacheada en API_URL_BASE). Es el mismo archivo que ya genera el
 * Instalador del panel admin y que usa login.html — evita tener que
 * pegar la URL a mano en este archivo para cada cliente nuevo.
 */
async function resolverApiUrlBase(){
  if(API_URL_BASE) return API_URL_BASE;
  try{
    const res = await fetch("config.json?_=" + Date.now(), { cache: "no-store" });
    if(res.ok){
      const cfg = await res.json();
      if(cfg.apiUrl) API_URL_BASE = cfg.apiUrl;
    }
  }catch(error){
    console.error("No se pudo leer config.json para obtener la API URL:", error);
  }
  return API_URL_BASE;
}

/**
 * Trae la configuración real desde Sheets (a través de la API) y
 * actualiza CONFIG_NEGOCIO. Devuelve una Promise — cada página debe
 * esperarla (await cargarConfigNegocio()) antes de usar los datos
 * del negocio, para no mostrar por un instante los valores de
 * respaldo genéricos.
 */
async function cargarConfigNegocio(){
  const apiUrl = await resolverApiUrlBase();
  CONFIG_NEGOCIO.API_URL = apiUrl; // disponible ya mismo, sin esperar a Sheets

  if(!apiUrl){
    console.error("Esta instalación todavía no tiene configurada la API URL del backend (falta config.json). Se usan los valores de respaldo.");
    return CONFIG_NEGOCIO;
  }

  try{
    const res = await fetch(apiUrl + "?action=configuracionNegocio");
    const data = await res.json();
    if(!data.success || !data.config) return CONFIG_NEGOCIO;

    const cfg = data.config;

    CONFIG_NEGOCIO = {
      API_URL: apiUrl,
      NOMBRE_NEGOCIO: cfg.nombre || CONFIG_NEGOCIO_RESPALDO.NOMBRE_NEGOCIO,
      NOMBRE_CORTO: cfg.nombreCorto || CONFIG_NEGOCIO_RESPALDO.NOMBRE_CORTO,
      TEMA: cfg.tema || CONFIG_NEGOCIO_RESPALDO.TEMA,

      URL_SITIO: cfg.urlCatalogo || CONFIG_NEGOCIO_RESPALDO.URL_SITIO,
      WHATSAPP_NUMERO: cfg.beneficioWhatsappNumero || CONFIG_NEGOCIO_RESPALDO.WHATSAPP_NUMERO,
      WHATSAPP_ICONO_URL: cfg.whatsappIconoUrl || CONFIG_NEGOCIO_RESPALDO.WHATSAPP_ICONO_URL,
      ICONO_URL: cfg.iconoUrl || CONFIG_NEGOCIO_RESPALDO.ICONO_URL,

      SEO_TITULO: cfg.seoTitulo || CONFIG_NEGOCIO_RESPALDO.SEO_TITULO,
      SEO_DESCRIPCION: cfg.seoDescripcion || CONFIG_NEGOCIO_RESPALDO.SEO_DESCRIPCION,
      SEO_KEYWORDS: cfg.seoKeywords || CONFIG_NEGOCIO_RESPALDO.SEO_KEYWORDS,

      HERO_TITULO: cfg.bannerTitulo || CONFIG_NEGOCIO_RESPALDO.HERO_TITULO,
      HERO_SUBTITULO: cfg.bannerSubtitulo || CONFIG_NEGOCIO_RESPALDO.HERO_SUBTITULO,

      FOOTER_TITULO_1: cfg.footerTitulo1 || CONFIG_NEGOCIO_RESPALDO.FOOTER_TITULO_1,
      FOOTER_TEXTO_1: cfg.footerTexto1 || CONFIG_NEGOCIO_RESPALDO.FOOTER_TEXTO_1,
      FOOTER_TEXTO_2: cfg.footerTexto2 || CONFIG_NEGOCIO_RESPALDO.FOOTER_TEXTO_2,
      FOOTER_TEXTO_3: cfg.footerTexto3 || CONFIG_NEGOCIO_RESPALDO.FOOTER_TEXTO_3,
      FOOTER_COPYRIGHT: cfg.footerCopyright || CONFIG_NEGOCIO_RESPALDO.FOOTER_COPYRIGHT
    };

  }catch(error){
    console.error("No se pudo cargar la configuración del negocio, se usan los valores de respaldo:", error);
  }

  return CONFIG_NEGOCIO;
}

/**
 * Aplica el título, meta tags, Open Graph, Twitter Card y JSON-LD
 * (schema.org) de la página usando CONFIG_NEGOCIO. Llamar DESPUÉS de
 * cargarConfigNegocio(). Si la página no tiene alguno de estos tags,
 * simplemente no hace nada con ese — no hace falta que todas las
 * páginas tengan los mismos meta tags.
 */
function aplicarConfigSEO(){
  const c = CONFIG_NEGOCIO;

  function setMeta(selector, attr, valor){
    const el = document.querySelector(selector);
    if(el && valor) el.setAttribute(attr, valor);
  }

  if(c.SEO_TITULO) document.title = c.SEO_TITULO;
  setMeta('meta[name="description"]', "content", c.SEO_DESCRIPCION);
  setMeta('meta[name="keywords"]', "content", c.SEO_KEYWORDS);
  setMeta('meta[name="author"]', "content", c.NOMBRE_NEGOCIO);
  setMeta('link[rel="canonical"]', "href", c.URL_SITIO);

  setMeta('meta[property="og:url"]', "content", c.URL_SITIO);
  setMeta('meta[property="og:title"]', "content", c.SEO_TITULO);
  setMeta('meta[property="og:description"]', "content", c.SEO_DESCRIPCION);
  if(c.URL_SITIO && c.ICONO_URL){
    setMeta('meta[property="og:image"]', "content", c.URL_SITIO.replace(/\/$/, "") + "/" + c.ICONO_URL);
    setMeta('meta[name="twitter:image"]', "content", c.URL_SITIO.replace(/\/$/, "") + "/" + c.ICONO_URL);
  }
  setMeta('meta[property="og:site_name"]', "content", c.NOMBRE_NEGOCIO);

  setMeta('meta[name="twitter:title"]', "content", c.SEO_TITULO);
  setMeta('meta[name="twitter:description"]', "content", c.SEO_DESCRIPCION);

  const schemaEl = document.querySelector('script[type="application/ld+json"]');
  if(schemaEl){
    try{
      const schema = JSON.parse(schemaEl.textContent);
      schema.name = c.NOMBRE_NEGOCIO;
      if(c.URL_SITIO) schema.url = c.URL_SITIO;
      if(c.URL_SITIO && c.ICONO_URL){
        schema.logo = c.URL_SITIO.replace(/\/$/, "") + "/" + c.ICONO_URL;
        schema.image = schema.logo;
      }
      schemaEl.textContent = JSON.stringify(schema, null, 2);
    }catch(e){ /* si el JSON-LD tiene otro formato, se deja como está */ }
  }
}
