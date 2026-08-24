/* =========================================================
   CONFIG
========================================================= */

// Monto mínimo para poder enviar un pedido (configurable desde el panel admin)
let pedidoMinimo = 100000;

// Nombres de empresas de transporte que el negocio NO trabaja (ya
// normalizados), cargados desde Configuración. El cliente no puede
// escribir ninguno de estos en el campo "Transporte" del carrito.
let transportesNoDisponibles = [];

/**
 * Normaliza texto para comparar transportes ignorando mayúsculas,
 * acentos, y espacios de más — así "Vía Cargo", "via cargo" y
 * "VIA  CARGO" se consideran el mismo texto. Debe coincidir
 * exactamente con normalizarTextoTransporte() del backend.
 */
function normalizarTextoTransporte(texto){
    return String(texto || "")
        .trim()
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/\s+/g, " ");
}

// API_URL viene de config.js (window.CONFIG_NEGOCIO.API_URL), que ya se
// carga con <script src="config.js"> antes que este archivo en el HTML.
// Sin valor de respaldo a propósito: si config.js no define API_URL,
// este catálogo no tiene forma de saber a qué backend pertenece, así
// que no debe intentar hablar con el de otra instalación.
let API_URL = "";

/**
 * Reemplazo de fetch() para las llamadas al backend, con timeout
 * automático y reintentos seguros — quien navega este catálogo lo hace
 * casi siempre desde el celular, con conexiones bastante más
 * inestables que las de una PC en el local. Sin esto, un corte
 * momentáneo dejaba al cliente mirando el cartel de "cargando" sin
 * límite de tiempo.
 *
 * - LECTURAS (cargar el catálogo, la configuración del negocio, las
 *   imágenes): se reintentan solas 1 vez si fallan — no tienen
 *   ningún efecto secundario.
 * - MUTACIONES (enviar un pedido): NO se reintentan solas — si el
 *   pedido ya había llegado al servidor y solo se perdió la
 *   respuesta, reintentar a ciegas podría duplicarlo. Solo se les
 *   pone un límite de tiempo para fallar rápido y avisar con
 *   claridad, en vez de dejar al cliente esperando para siempre sin
 *   saber si su pedido se mandó o no.
 */
async function fetchAPI(url, opciones = {}, config = {}) {
  const esLectura = !opciones.method || opciones.method === "GET";
  const timeoutMs = config.timeoutMs || (esLectura ? 10000 : 20000);
  const maxIntentos = esLectura ? (config.reintentos ?? 2) : 1;

  let ultimoError;
  for (let intento = 1; intento <= maxIntentos; intento++) {
    const controlador = new AbortController();
    const timer = setTimeout(() => controlador.abort(), timeoutMs);
    try {
      const respuesta = await fetch(url, { ...opciones, signal: controlador.signal });
      clearTimeout(timer);
      return respuesta;
    } catch (error) {
      clearTimeout(timer);
      ultimoError = error;
      if (!esLectura || intento === maxIntentos) throw ultimoError;
      await new Promise(r => setTimeout(r, 400 * intento));
    }
  }
  throw ultimoError;
}

async function cargarConfigCliente() {
  if (typeof cargarConfigNegocio === "function") {
    await cargarConfigNegocio(); // de config.js — resuelve config.json y trae el resto de Sheets
  }
  if (typeof CONFIG_NEGOCIO !== "undefined" && CONFIG_NEGOCIO.API_URL) {
    API_URL = CONFIG_NEGOCIO.API_URL;
  } else {
    console.error("No se pudo obtener la API URL (falta config.js o config.json) — este catálogo no puede conectarse a ningún backend.");
  }
}

// Cantidad de productos (los últimos agregados en la hoja de Sheets)
// que se consideran "recién agregados" y se destacan en el catálogo.
const CANTIDAD_PRODUCTOS_NUEVOS = 8;

const PLACEHOLDER_IMG = "data:image/svg+xml;base64," + btoa(
    "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'>" +
    "<rect width='100%' height='100%' fill='#eef1f6'/>" +
    "<text x='50%' y='50%' font-size='20' text-anchor='middle' fill='#94a3b8' font-family='sans-serif' dy='.3em'>Sin imagen</text>" +
    "</svg>"
);

const estado = {
    productos: [],
    productosVisibles: [],
    carrito: JSON.parse(localStorage.getItem("carrito")) || [],
    busqueda: "",
    categoria: "",
    precioMin: null,
    precioMax: null,
    orden: "relevancia"
};

// Número de WhatsApp usado por el botón flotante y por el checkout.
// Se sobreescribe con el valor de Sheets en aplicarApariencia(); este
// es solo el valor por defecto mientras carga o si falla la conexión.
let whatsappNumero = "5491140975795";

// Promesa de la carga de configuración (se asigna más abajo, al llamar
// aplicarApariencia()). checkoutWhatsapp() la espera antes de armar el
// link de WhatsApp, para nunca mandar el pedido al número de respaldo
// por una carrera entre el clic del cliente y la respuesta del backend.
let apariencaCargadaPromise = null;

// Nombre del negocio, para el encabezado del PDF del catálogo. Se
// sobreescribe con el valor de Sheets en aplicarApariencia().
let nombreNegocio = "Catálogo";

let qvProductoActual = null;
let debounceTimer = null;
let precioDebounceTimer = null;

/* =========================================================
   HELPERS
========================================================= */

function escapeHtml(str){
    return String(str ?? "").replace(/[&<>"']/g, c => ({
        "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
    }[c]));
}

function formatearPrecio(valor){
    return Number(valor || 0).toLocaleString("es-AR");
}

function obtenerEstadoStock(stock){

    const n = Number(String(stock ?? "").trim());

    if(isNaN(n)) return null;

    if(n <= 0) return { texto: "Sin stock", clase: "stock-agotado" };

    return n < 5
        ? { texto: "Últimas Unidades", clase: "stock-bajo" }
        : { texto: "Disponible", clase: "stock-ok" };
}

/* =========================================================
   TOASTS
========================================================= */

function mostrarToast(mensaje, tipo){

    const cont = document.getElementById("toast-container");

    const el = document.createElement("div");
    el.className = "app-toast " + (tipo || "info");
    el.textContent = mensaje;

    cont.appendChild(el);

    requestAnimationFrame(()=> el.classList.add("show"));

    setTimeout(()=>{
        el.classList.remove("show");
        setTimeout(()=> el.remove(), 300);
    }, 2600);
}

/* =========================================================
   CARGA DE PRODUCTOS
========================================================= */

function mostrarSkeleton(n){

    n = n || 8;

    const cont = document.getElementById("productos");

    let html = "";

    for(let i=0;i<n;i++){
        html += `
        <div class="col-xl-3 col-lg-4 col-md-6 col-sm-6 mb-4">
            <div class="skeleton-card">
                <div class="skeleton-img"></div>
                <div class="skeleton-line w-80"></div>
                <div class="skeleton-line w-60"></div>
            </div>
        </div>`;
    }

    cont.innerHTML = html;

    document.getElementById("resultados-info").textContent = "";
    document.getElementById("sin-resultados").classList.add("d-none");
}

async function cargarProductos(){

    mostrarSkeleton();

    try{

        const res = await fetchAPI(API_URL + "?action=productos");
        const data = await res.json();

        const productosConStock = (data.productos || [])
            .filter(p => Number(String(p.STOCK).trim()) > 0);

        // Los productos nuevos se agregan siempre al final de la hoja
        // de Sheets, así que los últimos N (en el orden original,
        // antes de reordenar por destacados) son los "recién agregados".
        const codigosNuevos = new Set(
            productosConStock
                .slice(-CANTIDAD_PRODUCTOS_NUEVOS)
                .map(p => String(p.CODIGO))
        );

        estado.productos = productosConStock
        .map(p => ({ ...p, _esNuevo: codigosNuevos.has(String(p.CODIGO)) }))
        .sort((a,b)=>{

            const esDestacadaA = String(a.DESTACADO || "").trim().toUpperCase() === "SI";
            const esDestacadaB = String(b.DESTACADO || "").trim().toUpperCase() === "SI";

            if(esDestacadaA !== esDestacadaB) return esDestacadaA ? -1 : 1;

            // Entre no-destacados, los recién agregados van primero
            // (Array.sort es estable, así que dentro de cada grupo se
            // conserva el orden original de la hoja).
            if(a._esNuevo !== b._esNuevo) return a._esNuevo ? -1 : 1;

            return 0;
        });

        renderChips();
        aplicarFiltros();

    }catch(err){

        console.error(err);

        document.getElementById("productos").innerHTML = "";

        mostrarToast("No pudimos cargar el catálogo. Revisá tu conexión y volvé a intentar.", "error");

    } finally {

        // Ocultar el loading cat al terminar — con o sin error
        const cat = document.getElementById("loadingCat");
        if(cat){
            cat.style.opacity = "0";
            setTimeout(() => cat.remove(), 500);
        }
    }
}

/* =========================================================
   CATEGORÍAS (CHIPS)
========================================================= */

function renderChips(){

    const categorias = [...new Set(
        estado.productos
        .map(p => String(p.CATEGORIA || "").trim())
        .filter(Boolean)
    )];

    const cont = document.getElementById("categoria-chips");

    let html = `<button type="button" class="chip active" data-cat="">Todas</button>`;

    categorias.forEach(cat=>{
        html += `<button type="button" class="chip" data-cat="${escapeHtml(cat)}">${escapeHtml(cat)}</button>`;
    });

    cont.innerHTML = html;
}

function limpiarFiltros(){

    estado.categoria = "";
    estado.busqueda = "";
    estado.precioMin = null;
    estado.precioMax = null;

    document.getElementById("search").value = "";
    document.getElementById("search-clear").classList.remove("visible");

    document.getElementById("precio-min").value = "";
    document.getElementById("precio-max").value = "";
    document.getElementById("precio-clear").classList.remove("visible");

    document.querySelectorAll("#categoria-chips .chip").forEach(c => c.classList.remove("active"));

    const todas = document.querySelector('#categoria-chips .chip[data-cat=""]');
    if(todas) todas.classList.add("active");

    aplicarFiltros();
}

/* =========================================================
   FILTRO DE PRECIO (rango mín/máx)
========================================================= */

function filtrarPorPrecio(){

    clearTimeout(precioDebounceTimer);

    precioDebounceTimer = setTimeout(()=>{

        const minVal = document.getElementById("precio-min").value;
        const maxVal = document.getElementById("precio-max").value;

        estado.precioMin = minVal !== "" ? Number(minVal) : null;
        estado.precioMax = maxVal !== "" ? Number(maxVal) : null;

        const hayFiltro = estado.precioMin !== null || estado.precioMax !== null;
        document.getElementById("precio-clear").classList.toggle("visible", hayFiltro);

        aplicarFiltros();

    }, 300);
}

function limpiarFiltroPrecio(){

    document.getElementById("precio-min").value = "";
    document.getElementById("precio-max").value = "";
    document.getElementById("precio-clear").classList.remove("visible");

    estado.precioMin = null;
    estado.precioMax = null;

    aplicarFiltros();
}

/* =========================================================
   FILTRADO (BÚSQUEDA + CATEGORÍA COMBINADOS)
========================================================= */

function aplicarFiltros(){

    let lista = estado.productos;

    if(estado.categoria){
        lista = lista.filter(p => String(p.CATEGORIA || "").trim() === estado.categoria);
    }

    if(estado.busqueda){
        lista = lista.filter(p =>
            String(p.PRODUCTO || "").toLowerCase().includes(estado.busqueda)
        );
    }

    if(estado.precioMin !== null){
        lista = lista.filter(p => Number(p.PRECIO) >= estado.precioMin);
    }

    if(estado.precioMax !== null){
        lista = lista.filter(p => Number(p.PRECIO) <= estado.precioMax);
    }

    lista = ordenarLista(lista);

    // Se guarda la lista visible actual, para que el botón de descarga
    // de PDF siempre tome exactamente lo que se está mostrando en pantalla.
    estado.productosVisibles = lista;

    mostrarProductos(lista);
}

/* =========================================================
   ORDEN DE RESULTADOS
========================================================= */

/**
 * Aplica el criterio de orden elegido sobre una copia de la lista
 * (nunca sobre estado.productos directamente, para no perder el
 * orden original de "destacados primero" con el que llega del server).
 */
function ordenarLista(lista){

    const criterio = estado.orden || "relevancia";

    if(criterio === "relevancia") return lista;

    const copia = [...lista];

    switch(criterio){

        case "precio-asc":
            copia.sort((a,b) => Number(a.PRECIO) - Number(b.PRECIO));
            break;

        case "precio-desc":
            copia.sort((a,b) => Number(b.PRECIO) - Number(a.PRECIO));
            break;

        case "nombre-asc":
            copia.sort((a,b) => String(a.PRODUCTO || "").localeCompare(String(b.PRODUCTO || ""), "es", { sensitivity: "base" }));
            break;

        case "nombre-desc":
            copia.sort((a,b) => String(b.PRODUCTO || "").localeCompare(String(a.PRODUCTO || ""), "es", { sensitivity: "base" }));
            break;
    }

    return copia;
}

function ordenarProductos(){

    const select = document.getElementById("orden-select");
    estado.orden = select ? select.value : "relevancia";

    aplicarFiltros();
}

function buscarProductos(){

    clearTimeout(debounceTimer);

    debounceTimer = setTimeout(()=>{

        const texto = document.getElementById("search").value.toLowerCase().trim();

        estado.busqueda = texto;

        document.getElementById("search-clear").classList.toggle("visible", texto.length > 0);

        aplicarFiltros();

    }, 250);
}

function limpiarBusqueda(){

    document.getElementById("search").value = "";

    estado.busqueda = "";

    document.getElementById("search-clear").classList.remove("visible");

    aplicarFiltros();
}

/* =========================================================
   RENDER DE PRODUCTOS
========================================================= */

let _renderGenCatalogo = 0; // evita que un render viejo (todavía completando sus tandas) escriba encima de uno más nuevo — mismo problema que ya resolvimos en el buscador de Productos del panel

function mostrarProductos(lista){

    const container = document.getElementById("productos");
    const sinResultados = document.getElementById("sin-resultados");
    const info = document.getElementById("resultados-info");

    const miGen = ++_renderGenCatalogo;

    if(lista.length === 0){

        container.innerHTML = "";
        sinResultados.classList.remove("d-none");
        info.textContent = "";

        return;
    }

    sinResultados.classList.add("d-none");

    info.textContent = lista.length === 1
        ? "1 producto encontrado"
        : `${lista.length} productos encontrados`;

    const tarjetaHtml = p => {

        const codigo = escapeHtml(p.CODIGO);
        const nombre = escapeHtml(p.PRODUCTO);
        const categoria = escapeHtml(p.CATEGORIA);
        const imagen = p.IMAGEN || "";

        const stock = obtenerEstadoStock(p.STOCK);

        return `
        <div class="col-xl-3 col-lg-4 col-md-6 col-sm-6 mb-4">

            <div class="card-product h-100" data-code="${codigo}" data-action="quickview">

                ${String(p.DESTACADO || "").trim().toUpperCase() === "SI"
                    ? `<div class="ribbon-destacado">⭐ DESTACADO</div>`
                    : (p._esNuevo ? `<div class="ribbon-nuevo">🆕 NUEVO</div>` : "")}

                ${String(p.OFERTA || "").trim().toUpperCase() === "SI" ? `<div class="ribbon-oferta">🔥 OFERTA</div>` : ""}

                <div class="card-img-wrap">
                    <img
                        src="${imagen}"
                        alt="${nombre}"
                        loading="lazy"
                        onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
                </div>

                <div class="ticket-perf"></div>

                <div class="card-body-custom">

                    <small>${categoria}</small>

                    <h5>${nombre}</h5>

                    <div class="price">$${formatearPrecio(p.PRECIO)}</div>

                    ${stock ? `<div class="stock-badge ${stock.clase}">${stock.texto}</div>` : ""}

                    ${Number(p.UNIDADES_POR_CAJA) > 0 ? `
                    <div class="caja-oferta">
                        📦 Por caja (${p.UNIDADES_POR_CAJA} uds): <b>$${formatearPrecio(p.PRECIO_CAJA)}</b>
                        <button type="button" class="btn-caja" data-action="agregar-caja">Agregar caja</button>
                    </div>` : ""}

                    <div class="qty-stepper">
                        <button type="button" class="qty-btn" data-action="qty-minus" aria-label="Restar">−</button>
                        <input type="number" class="qty-input" data-role="qty" value="1" min="1" inputmode="numeric">
                        <button type="button" class="qty-btn" data-action="qty-plus" aria-label="Sumar">+</button>
                    </div>

                    <button type="button" class="btn btn-primary" data-action="agregar">
                        🛒 Agregar
                    </button>

                </div>

            </div>

        </div>`;
    };

    // Con catálogos grandes (varios cientos de productos), armar y
    // escribir todo el HTML de una sola vez puede trabar el navegador
    // un instante — más notorio en el celular de un cliente navegando
    // el catálogo que en una PC de local. Se arma en tandas: la
    // primera tanda se ve al instante, el resto se agrega de a poco
    // sin congelar la pantalla.
    const PRIMERA_TANDA = 24; // alcanza para llenar la pantalla inicial en cualquier tamaño
    const TANDA = 40;

    const primeros = lista.slice(0, PRIMERA_TANDA);
    container.innerHTML = primeros.map(tarjetaHtml).join("");

    if (lista.length <= PRIMERA_TANDA) return;

    let idx = PRIMERA_TANDA;
    const renderTanda = () => {
        if (miGen !== _renderGenCatalogo) return; // superado por una búsqueda/filtro más nuevo — no seguir escribiendo
        const fin = Math.min(idx + TANDA, lista.length);
        const frag = document.createDocumentFragment();
        const tmp = document.createElement("div");
        tmp.innerHTML = lista.slice(idx, fin).map(tarjetaHtml).join("");
        while (tmp.firstElementChild) frag.appendChild(tmp.firstElementChild);
        container.appendChild(frag);
        idx = fin;
        if (idx < lista.length) requestAnimationFrame(renderTanda);
    };
    requestAnimationFrame(renderTanda);
}

/* Delegación de eventos en la grilla de productos */
document.getElementById("productos").addEventListener("click", function(e){

    if(e.target.tagName === "INPUT") return;

    const actionEl = e.target.closest("[data-action]");
    if(!actionEl) return;

    const card = actionEl.closest(".card-product");
    if(!card) return;

    const codigo = card.dataset.code;
    const producto = estado.productos.find(p => String(p.CODIGO) === codigo);
    const qtyInput = card.querySelector('[data-role="qty"]');

    switch(actionEl.dataset.action){

        case "qty-plus":
            const stockMax = Number(String(producto.STOCK ?? "").trim()) || 0;
            const qtyActual = parseInt(qtyInput.value) || 1;
            qtyInput.value = stockMax > 0 ? Math.min(stockMax, qtyActual + 1) : qtyActual + 1;
            break;

        case "qty-minus":
            qtyInput.value = Math.max(1, (parseInt(qtyInput.value) || 1) - 1);
            break;

        case "agregar":
            agregarAlCarrito(producto, parseInt(qtyInput.value) || 1);
            qtyInput.value = 1;
            break;

        case "agregar-caja":
            agregarCajaAlCarrito(producto);
            break;

        case "quickview":
            abrirQuickView(producto);
            break;
    }
});

/* Delegación de clics en los chips de categoría */
document.getElementById("categoria-chips").addEventListener("click", function(e){

    const btn = e.target.closest(".chip");
    if(!btn) return;

    document.querySelectorAll("#categoria-chips .chip").forEach(c => c.classList.remove("active"));
    btn.classList.add("active");

    estado.categoria = btn.dataset.cat || "";

    aplicarFiltros();
});

/* =========================================================
   VISTA RÁPIDA
========================================================= */

function cambiarQtyInput(id, delta){

    const el = document.getElementById(id);
    const stockDisponible = qvProductoActual
        ? Number(String(qvProductoActual.STOCK ?? "").trim()) || 0
        : 0;
    const nuevo = (parseInt(el.value) || 1) + delta;
    el.value = Math.max(1, stockDisponible > 0 ? Math.min(stockDisponible, nuevo) : nuevo);
}

function abrirQuickView(producto, actualizarUrl){

    if(!producto) return;

    if(actualizarUrl === undefined) actualizarUrl = true;

    qvProductoActual = producto;

    document.getElementById("qv-titulo").textContent = producto.PRODUCTO;

    const img = document.getElementById("qv-imagen");
    img.src = producto.IMAGEN || "";
    img.alt = producto.PRODUCTO || "";
    img.onerror = function(){ this.onerror = null; this.src = PLACEHOLDER_IMG; };

    document.getElementById("qv-categoria").textContent = producto.CATEGORIA || "";
    document.getElementById("qv-precio").textContent = "$" + formatearPrecio(producto.PRECIO);

    const descripcionEl = document.getElementById("qv-descripcion");
    const descripcion = String(producto.DESCRIPCION || "").trim();
    descripcionEl.textContent = descripcion;
    descripcionEl.classList.toggle("d-none", !descripcion);

    const stockEl = document.getElementById("qv-stock");
    const stock = obtenerEstadoStock(producto.STOCK);

    if(stock){
        stockEl.textContent = stock.texto;
        stockEl.className = "stock-badge " + stock.clase;
        stockEl.classList.remove("d-none");
    }else{
        stockEl.classList.add("d-none");
    }

    document.getElementById("qv-cantidad").value = 1;

    renderRelacionados(producto);

    if(actualizarUrl) actualizarURLProducto(producto);

    const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("quickViewModal"));
    modal.show();
}

/**
 * Muestra hasta 8 productos de la misma categoría (con stock) en el
 * Quick View, para incentivar que el cliente agregue más de un
 * producto al pedido antes de cerrar el modal. Si la categoría no
 * tiene más productos, la sección se oculta directamente.
 *
 * Para que sea realmente útil (y no siempre los mismos 8 primeros
 * de la categoría), se prioriza la misma subcategoría cuando existe
 * y, dentro de cada grupo, el orden se mezcla en cada apertura.
 */
function renderRelacionados(producto){

    const wrap = document.getElementById("qv-relacionados-wrap");
    const cont = document.getElementById("qv-relacionados");
    if(!wrap || !cont) return;

    const categoria = String(producto.CATEGORIA || "").trim();
    const subcategoria = String(producto.SUBCATEGORIA || "").trim();

    const codigosEnCarrito = new Set(estado.carrito.map(p => String(p.CODIGO)));

    const candidatos = categoria
        ? estado.productos.filter(p =>
            String(p.CATEGORIA || "").trim() === categoria &&
            String(p.CODIGO) !== String(producto.CODIGO) &&
            !codigosEnCarrito.has(String(p.CODIGO)) &&
            (Number(String(p.STOCK ?? "").trim()) || 0) > 0
          )
        : [];

    // Mezcla aleatoria (Fisher-Yates) para no repetir siempre el mismo orden.
    const mezclar = (arr) => {
        const copia = arr.slice();
        for(let i = copia.length - 1; i > 0; i--){
            const j = Math.floor(Math.random() * (i + 1));
            [copia[i], copia[j]] = [copia[j], copia[i]];
        }
        return copia;
    };

    let relacionados;
    if(subcategoria){
        const mismaSub = mezclar(candidatos.filter(p => String(p.SUBCATEGORIA || "").trim() === subcategoria));
        const otraSub = mezclar(candidatos.filter(p => String(p.SUBCATEGORIA || "").trim() !== subcategoria));
        relacionados = [...mismaSub, ...otraSub].slice(0, 8);
    }else{
        relacionados = mezclar(candidatos).slice(0, 8);
    }

    if(relacionados.length === 0){
        wrap.classList.add("d-none");
        cont.innerHTML = "";
        return;
    }

    cont.innerHTML = relacionados.map(p => `
        <button
            type="button"
            class="qv-relacionado-card"
            data-code="${escapeHtml(p.CODIGO)}"
            aria-label="Ver ${escapeHtml(p.PRODUCTO)}">
            <img
                src="${p.IMAGEN || ""}"
                alt="${escapeHtml(p.PRODUCTO)}"
                loading="lazy"
                onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">
            <span class="qv-relacionado-nombre">${escapeHtml(p.PRODUCTO)}</span>
            <span class="qv-relacionado-precio">$${formatearPrecio(p.PRECIO)}</span>
        </button>
    `).join("");

    wrap.classList.remove("d-none");
}

// Al hacer click en un producto relacionado, se abre su propio Quick
// View — reemplaza al actual sin cerrar el modal, así el cliente
// puede seguir explorando la categoría sin perder el lugar.
document.getElementById("qv-relacionados").addEventListener("click", function(e){

    const card = e.target.closest(".qv-relacionado-card");
    if(!card) return;

    const codigo = card.dataset.code;
    const producto = estado.productos.find(p => String(p.CODIGO) === String(codigo));
    if(producto) abrirQuickView(producto);
});

/* =========================================================
   URL POR PRODUCTO (para que Google pueda indexar cada uno)

   Cada vez que se abre el Quick View de un producto, se agrega
   ?producto=CODIGO-slug a la URL con history.pushState (sin recargar
   la página), y se actualizan <title>, <meta name="description"> y
   <link rel="canonical">. Al cerrar el modal, se vuelve a la URL base.

   Esto también habilita "deep links": si alguien entra directo a
   tuweb.com/?producto=123-nombre, el Quick View de ese producto se
   abre solo al cargar — así Googlebot (que sí ejecuta JS) puede
   rastrear y renderizar el contenido de esa URL puntual.

   OJO: esto por sí solo no hace que Google "descubra" las URLs de
   producto. Para que las indexe hace falta que existan enlaces
   rastreables hacia ellas (o un sitemap.xml con esas URLs). Si querés,
   te ayudo a generar ese sitemap aparte.
========================================================= */

let urlBase = null;
let metaOriginal = null;

function generarSlug(texto){
    return String(texto || "")
        .trim()
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function actualizarURLProducto(producto){

    if(!producto) return;

    if(!urlBase){
        urlBase = window.location.href.split("?")[0].split("#")[0];
    }

    if(!metaOriginal){
        const metaDescActual = document.querySelector('meta[name="description"]');
        metaOriginal = {
            title: document.title,
            description: metaDescActual ? metaDescActual.getAttribute("content") : ""
        };
    }

    const slug = generarSlug(producto.PRODUCTO);
    const codigo = encodeURIComponent(producto.CODIGO);
    const nuevaUrl = urlBase + "?producto=" + codigo + (slug ? "-" + slug : "");
    // El canonical NO apunta a nuevaUrl (la URL con ?producto=... que
    // ve el usuario en la SPA), sino a la página estática generada por
    // scripts/generar-seo.js en /producto/CODIGO-slug/ — esa es la que
    // se lista en sitemap.xml y la que conviene que Google indexe como
    // "la" URL de este producto, para no generar contenido duplicado
    // entre las dos versiones.
    const urlCanonicaEstatica = urlBase + "producto/" + codigo + (slug ? "-" + slug : "") + "/";
    const tituloProducto = producto.PRODUCTO + (nombreNegocio ? " | " + nombreNegocio : "");
    const descripcionCorta = String(producto.DESCRIPCION || producto.PRODUCTO || "").slice(0, 160);
    const imagenProducto = producto.IMAGEN || "";

    document.title = tituloProducto;

    setMetaTag('meta[name="description"]', "name", "description", descripcionCorta);
    setMetaTag('link[rel="canonical"]', "rel", "canonical", urlCanonicaEstatica, "href");

    // Open Graph — WhatsApp/Facebook no ejecutan JS, así que esto solo
    // sirve para cuando Googlebot renderiza la página o para debug
    // tools (Rich Results Test, Facebook Debugger forzando refetch).
    // Los links compartidos reales dependen de las páginas estáticas
    // generadas en /producto/ (ver scripts/generar-seo.js).
    setMetaTag('meta[property="og:url"]', "property", "og:url", urlCanonicaEstatica);
    setMetaTag('meta[property="og:title"]', "property", "og:title", producto.PRODUCTO);
    setMetaTag('meta[property="og:description"]', "property", "og:description", descripcionCorta);
    if(imagenProducto) setMetaTag('meta[property="og:image"]', "property", "og:image", imagenProducto);

    setMetaTag('meta[name="twitter:title"]', "name", "twitter:title", producto.PRODUCTO);
    setMetaTag('meta[name="twitter:description"]', "name", "twitter:description", descripcionCorta);
    if(imagenProducto) setMetaTag('meta[name="twitter:image"]', "name", "twitter:image", imagenProducto);

    actualizarSchemaProducto(producto, urlCanonicaEstatica, descripcionCorta, imagenProducto);

    // No usar la misma URL dos veces seguidas en el historial
    // (por ej. al pasar de un producto a un relacionado)
    if(window.location.href !== nuevaUrl){
        history.pushState({ producto: producto.CODIGO }, "", nuevaUrl);
    }
}

/**
 * Crea (si no existe) o actualiza un meta/link tag del <head>.
 * attrSelector/attrNombre identifican el tag (ej. name="description"),
 * attrValor es lo que se busca setear (por defecto "content", pero
 * <link> usa "href").
 */
function setMetaTag(selector, attrNombre, attrValorId, contenido, attrContenido){
    attrContenido = attrContenido || "content";
    let tag = document.querySelector(selector);
    if(!tag){
        tag = document.createElement(selector.startsWith("link") ? "link" : "meta");
        tag.setAttribute(attrNombre, attrValorId);
        document.head.appendChild(tag);
    }
    tag.setAttribute(attrContenido, contenido);
}

/**
 * Reemplaza el JSON-LD de tipo Store (#schema-negocio) por uno de
 * tipo Product mientras el Quick View de un producto está abierto,
 * y lo restaura al cerrar (ver restaurarURLBase).
 */
let schemaOriginalTexto = null;

function actualizarSchemaProducto(producto, url, descripcion, imagen){
    const schemaTag = document.getElementById("schema-negocio");
    if(!schemaTag) return;

    if(schemaOriginalTexto === null){
        schemaOriginalTexto = schemaTag.textContent;
    }

    const precioNum = Number(String(producto.PRECIO || "").replace(/[^\d.,-]/g, "").replace(",", "."));

    const schemaProducto = {
        "@context": "https://schema.org",
        "@type": "Product",
        "name": producto.PRODUCTO,
        "description": descripcion,
        "sku": String(producto.CODIGO),
        "image": imagen || undefined,
        "category": producto.CATEGORIA || undefined,
        "offers": {
            "@type": "Offer",
            "url": url,
            "priceCurrency": "ARS",
            "price": isFinite(precioNum) && precioNum > 0 ? precioNum : undefined,
            "availability": "https://schema.org/InStock"
        }
    };

    schemaTag.textContent = JSON.stringify(schemaProducto);
}

function restaurarSchemaNegocio(){
    const schemaTag = document.getElementById("schema-negocio");
    if(schemaTag && schemaOriginalTexto !== null){
        schemaTag.textContent = schemaOriginalTexto;
    }
}

function restaurarURLBase(){

    if(!urlBase) return;

    if(metaOriginal){
        document.title = metaOriginal.title;
        const metaDesc = document.querySelector('meta[name="description"]');
        if(metaDesc) metaDesc.setAttribute("content", metaOriginal.description);

        setMetaTag('meta[property="og:url"]', "property", "og:url", urlBase);
        setMetaTag('meta[property="og:title"]', "property", "og:title", metaOriginal.title);
        setMetaTag('meta[property="og:description"]', "property", "og:description", metaOriginal.description);
        setMetaTag('meta[name="twitter:title"]', "name", "twitter:title", metaOriginal.title);
        setMetaTag('meta[name="twitter:description"]', "name", "twitter:description", metaOriginal.description);
    }

    const canonical = document.querySelector('link[rel="canonical"]');
    if(canonical) canonical.setAttribute("href", urlBase);

    restaurarSchemaNegocio();

    if(window.location.href !== urlBase){
        history.pushState({}, "", urlBase);
    }
}

// Al cerrar el Quick View (X, click afuera, Escape) se vuelve a la URL base
document.getElementById("quickViewModal").addEventListener("hidden.bs.modal", function(){
    qvProductoActual = null;
    restaurarURLBase();
});

// Botón "atrás"/"adelante" del navegador
window.addEventListener("popstate", function(){

    const codigoParam = new URLSearchParams(window.location.search).get("producto");

    if(!codigoParam){
        const modal = bootstrap.Modal.getInstance(document.getElementById("quickViewModal"));
        if(modal) modal.hide();
        return;
    }

    const codigo = codigoParam.split("-")[0];
    const producto = estado.productos.find(p => String(p.CODIGO) === String(codigo));
    if(producto) abrirQuickView(producto, false); // false: no volver a pushear la URL
});

// Deep link inicial: si la página se abre con ?producto=... en la URL,
// abre ese Quick View automáticamente una vez cargado el catálogo.
function abrirProductoDesdeURL(){

    const codigoParam = new URLSearchParams(window.location.search).get("producto");
    if(!codigoParam) return;

    const codigo = codigoParam.split("-")[0];
    const producto = estado.productos.find(p => String(p.CODIGO) === String(codigo));
    if(producto) abrirQuickView(producto, false);
}

document.getElementById("qv-agregar").addEventListener("click", function(){

    const cantidad = parseInt(document.getElementById("qv-cantidad").value) || 1;

    agregarAlCarrito(qvProductoActual, cantidad);

    const modal = bootstrap.Modal.getInstance(document.getElementById("quickViewModal"));
    if(modal) modal.hide();
});

/**
 * Zoom estilo Amazon sobre la imagen del Quick View: al mover el
 * mouse, la imagen se agranda y el punto bajo el cursor queda como
 * centro de la ampliación. Solo se activa en dispositivos con mouse
 * (matchMedia "hover: hover") para no dejar el zoom trabado en
 * celulares, donde no tiene sentido este gesto.
 */
(function initZoomQuickView(){

    const wrap = document.getElementById("qv-imagen-zoom-wrap");
    const img = document.getElementById("qv-imagen");
    if(!wrap || !img) return;

    const tieneHover = window.matchMedia && window.matchMedia("(hover: hover)").matches;
    if(!tieneHover) return;

    wrap.addEventListener("mouseenter", function(){
        wrap.classList.add("zoom-activo");
    });

    wrap.addEventListener("mousemove", function(e){

        const rect = wrap.getBoundingClientRect();
        const xPorc = ((e.clientX - rect.left) / rect.width) * 100;
        const yPorc = ((e.clientY - rect.top) / rect.height) * 100;

        img.style.transformOrigin =
            `${Math.max(0, Math.min(100, xPorc))}% ${Math.max(0, Math.min(100, yPorc))}%`;
    });

    wrap.addEventListener("mouseleave", function(){
        wrap.classList.remove("zoom-activo");
        img.style.transformOrigin = "center";
    });
})();

/* =========================================================
   CARRITO
========================================================= */

function agregarAlCarrito(producto, cantidad){

    if(!producto) return;

    cantidad = Math.max(1, cantidad || 1);

    const stockDisponible = Number(String(producto.STOCK ?? "").trim()) || 0;

    if(stockDisponible <= 0){
        mostrarToast(`"${producto.PRODUCTO}" no tiene stock disponible`, "error");
        return;
    }

    const existente = estado.carrito.find(p => String(p.CODIGO) === String(producto.CODIGO));
    const yaEnCarrito = existente ? existente.cantidad : 0;
    const totalSolicitado = yaEnCarrito + cantidad;

    if(totalSolicitado > stockDisponible){
        const podemos = stockDisponible - yaEnCarrito;
        if(podemos <= 0){
            mostrarToast(`⚠️ Ya tenés el máximo disponible de "${producto.PRODUCTO}" en el carrito (${stockDisponible} ud${stockDisponible !== 1 ? "s" : ""})`, "error");
            return;
        }
        // Agrega solo lo que queda disponible
        cantidad = podemos;
        mostrarToast(`⚠️ Solo se agregaron ${cantidad} ud${cantidad !== 1 ? "s" : ""} de "${producto.PRODUCTO}" (stock disponible: ${stockDisponible})`, "error");
    }

    if(existente){
        existente.cantidad += cantidad;
    }else{
        estado.carrito.push({ ...producto, cantidad });
    }

    guardarCarrito();

    if(stockDisponible <= 0 || totalSolicitado <= stockDisponible){
        mostrarToast(`✓ ${producto.PRODUCTO} agregado (${cantidad})`, "success");
    }
}

/**
 * Agrega al carrito una "caja" (bulto cerrado) de un producto que
 * también se vende suelto. Usa el mismo CODIGO real del producto
 * (el stock es el mismo, se descuenta de ahí), pero como línea
 * aparte del carrito (marcada _esCaja) porque el precio por unidad
 * equivalente de la caja es distinto al de comprarlo suelto.
 */
function agregarCajaAlCarrito(producto){
    if(!producto) return;

    const unidades = Number(producto.UNIDADES_POR_CAJA) || 0;
    const precioCaja = Number(producto.PRECIO_CAJA) || 0;
    if(unidades <= 0 || precioCaja <= 0) return;

    const stockDisponible = Number(String(producto.STOCK ?? "").trim()) || 0;

    if(stockDisponible <= 0){
        mostrarToast(`"${producto.PRODUCTO}" no tiene stock disponible`, "error");
        return;
    }

    // Ya en el carrito, sumando lo que haya tanto suelto como en cajas
    // anteriores — el stock es uno solo para el mismo producto.
    const yaEnCarrito = estado.carrito
        .filter(p => String(p.CODIGO) === String(producto.CODIGO))
        .reduce((acc, p) => acc + p.cantidad, 0);

    if(yaEnCarrito + unidades > stockDisponible){
        mostrarToast(`⚠️ No hay suficiente stock para otra caja de "${producto.PRODUCTO}" (disponible: ${stockDisponible - yaEnCarrito} ud${(stockDisponible - yaEnCarrito) !== 1 ? "s" : ""})`, "error");
        return;
    }

    const existente = estado.carrito.find(p => String(p.CODIGO) === String(producto.CODIGO) && p._esCaja);
    if(existente){
        existente.cantidad += unidades;
    }else{
        estado.carrito.push({
            ...producto,
            cantidad: unidades,
            PRECIO: precioCaja / unidades,
            PRODUCTO: `${producto.PRODUCTO} (caja x${unidades})`,
            _esCaja: true
        });
    }

    guardarCarrito();
    mostrarToast(`✓ 1 caja de "${producto.PRODUCTO}" agregada (${unidades} uds) — $${formatearPrecio(precioCaja)}`, "success");
}

function guardarCarrito(){

    localStorage.setItem("carrito", JSON.stringify(estado.carrito));

    actualizarContador();
}

function actualizarContador(){

    const cantidadTotal = estado.carrito.reduce((acc,item) => acc + item.cantidad, 0);
    const totalPrecio = estado.carrito.reduce((acc,item) => acc + (item.PRECIO * item.cantidad), 0);

    document.getElementById("cart-count").innerText = cantidadTotal;

    const mcb = document.getElementById("mobile-cart-bar");

    if(cantidadTotal > 0){

        mcb.classList.remove("d-none");

        document.getElementById("mcb-count").innerText = cantidadTotal;
        document.getElementById("mcb-total").innerText = formatearPrecio(totalPrecio);

    }else{

        mcb.classList.add("d-none");
    }

    actualizarBarraMinimo(totalPrecio);
}

/**
 * Barra de progreso hacia el pedido mínimo, visible en la parte
 * superior del catálogo (debajo del navbar) apenas hay algo en el
 * carrito. Se oculta sola cuando ya se llegó al mínimo o cuando el
 * carrito está vacío, para no ocupar espacio innecesariamente.
 */
function actualizarBarraMinimo(totalPrecio){

    const cont = document.getElementById("minimo-progress");
    if(!cont) return;

    if(totalPrecio <= 0){
        cont.classList.add("d-none");
        document.documentElement.style.setProperty("--minimo-bar-h", "0px");
        return;
    }

    const fill = document.getElementById("minimo-progress-fill");
    const texto = document.getElementById("minimo-progress-texto");

    if(totalPrecio >= pedidoMinimo){

        fill.style.width = "100%";
        cont.classList.add("minimo-progress-completo");
        texto.innerHTML = `✅ Pedido mínimo alcanzado — Total: <b>$${formatearPrecio(totalPrecio)}</b>`;

    }else{

        const porcentaje = Math.max(0, Math.min(100, (totalPrecio / pedidoMinimo) * 100));
        const falta = pedidoMinimo - totalPrecio;

        cont.classList.remove("minimo-progress-completo");
        fill.style.width = porcentaje + "%";
        texto.innerHTML =
            `🛒 Te faltan <b>$${formatearPrecio(falta)}</b> para llegar al pedido mínimo de $${formatearPrecio(pedidoMinimo)}`;
    }

    cont.classList.remove("d-none");

    // La barra es "position:fixed", así que reserva su espacio real
    // (--minimo-bar-h) para que el contenido no quede tapado detrás
    // de ella — mismo patrón que --top-banner-h.
    requestAnimationFrame(()=>{
        document.documentElement.style.setProperty("--minimo-bar-h", cont.offsetHeight + "px");
    });
}

function cambiarCantidad(codigo, cambio){

    const item = estado.carrito.find(p => String(p.CODIGO) === String(codigo));
    if(!item) return;

    const nuevaCantidad = item.cantidad + cambio;

    if(nuevaCantidad <= 0){
        estado.carrito = estado.carrito.filter(p => String(p.CODIGO) !== String(codigo));
        guardarCarrito();
        abrirCarrito();
        return;
    }

    // Respeta el stock — el objeto item tiene STOCK porque viene del producto original
    const stockDisponible = Number(String(item.STOCK ?? "").trim()) || 0;
    if(stockDisponible > 0 && nuevaCantidad > stockDisponible){
        mostrarToast(`⚠️ Stock máximo disponible: ${stockDisponible} ud${stockDisponible !== 1 ? "s" : ""}`, "error");
        return;
    }

    item.cantidad = nuevaCantidad;

    guardarCarrito();
    abrirCarrito();
}

function actualizarCantidadManual(codigo, cantidad){

    const item = estado.carrito.find(p => String(p.CODIGO) === String(codigo));
    if(!item) return;

    cantidad = parseInt(cantidad);

    if(isNaN(cantidad) || cantidad < 1){
        cantidad = 1;
    }

    // Respeta el stock — el objeto item tiene STOCK porque viene del producto original
    const stockDisponible = Number(String(item.STOCK ?? "").trim()) || 0;
    if(stockDisponible > 0 && cantidad > stockDisponible){
        cantidad = stockDisponible;
        mostrarToast(`⚠️ Stock máximo disponible: ${stockDisponible} ud${stockDisponible !== 1 ? "s" : ""}`, "error");
    }

    item.cantidad = cantidad;

    guardarCarrito();
    abrirCarrito();
}

function eliminarProducto(codigo){

    estado.carrito = estado.carrito.filter(p => String(p.CODIGO) !== String(codigo));

    guardarCarrito();
    abrirCarrito();
}

function vaciarCarrito(){

    if(estado.carrito.length === 0) return;

    if(!confirm("¿Vaciar carrito?")) return;

    estado.carrito = [];

    guardarCarrito();
    abrirCarrito();

    mostrarToast("Carrito vaciado", "success");
}

/**
 * Vuelve a comparar cada ítem del carrito contra el stock ACTUAL
 * (el que ya está cargado en estado.productos, recién traído del
 * servidor) — el carrito puede tener quedado guardado en el
 * navegador de una visita anterior, con datos de stock y hasta de
 * precio ya viejos. Devuelve true si hubo que tocar algo (para poder
 * avisarle al cliente).
 *
 * - Producto que ya no existe/no está publicado → se quita del carrito.
 * - Producto sin stock (0 o negativo) → se quita del carrito.
 * - Cantidad pedida mayor a la disponible → se ajusta al máximo disponible.
 * - Precio actualizado → se refresca (por si cambió desde que se agregó).
 */
function sincronizarCarritoConStockActual(){
    if(estado.carrito.length === 0) return false;

    let huboAjustes = false;
    const avisos = [];
    const nuevoCarrito = [];

    estado.carrito.forEach(item => {
        const actual = estado.productos.find(p => String(p.CODIGO) === String(item.CODIGO));

        if(!actual){
            huboAjustes = true;
            avisos.push(`"${item.PRODUCTO}" ya no está disponible y se quitó del carrito`);
            return; // no se agrega al nuevo carrito
        }

        const stockActual = Number(String(actual.STOCK ?? "").trim()) || 0;

        if(stockActual <= 0){
            huboAjustes = true;
            avisos.push(`"${item.PRODUCTO}" se quedó sin stock y se quitó del carrito`);
            return;
        }

        // Actualiza el precio y el stock "de referencia" del ítem por si cambiaron
        item.PRECIO = actual.PRECIO;
        item.STOCK = stockActual;

        if(item.cantidad > stockActual){
            huboAjustes = true;
            avisos.push(`"${item.PRODUCTO}": se ajustó de ${item.cantidad} a ${stockActual} unidad${stockActual !== 1 ? "es" : ""} (es lo que hay disponible)`);
            item.cantidad = stockActual;
        }

        nuevoCarrito.push(item);
    });

    estado.carrito = nuevoCarrito;

    if(huboAjustes){
        guardarCarrito();
        avisos.forEach(msg => mostrarToast(`⚠️ ${msg}`, "error"));
    }

    return huboAjustes;
}

function abrirCarrito(){

    sincronizarCarritoConStockActual();

    const cont = document.getElementById("cart-items");
    const emptyEl = document.getElementById("cart-empty");

    let total = 0;

    if(estado.carrito.length === 0){

        cont.innerHTML = "";
        emptyEl.classList.remove("d-none");

    }else{

        emptyEl.classList.add("d-none");

        let html = "";

        estado.carrito.forEach(item=>{

            const subtotal = item.PRECIO * item.cantidad;
            total += subtotal;

            html += `
            <div class="cart-item-row" data-code="${escapeHtml(item.CODIGO)}">

                <div class="cart-item-main">

                    <img
                        class="cart-item-thumb"
                        src="${item.IMAGEN || ""}"
                        alt="${escapeHtml(item.PRODUCTO)}"
                        loading="lazy"
                        onerror="this.onerror=null;this.src='${PLACEHOLDER_IMG}'">

                    <div class="cart-item-info">

                        <div class="d-flex justify-content-between align-items-center">

                            <span class="cart-item-name">${escapeHtml(item.PRODUCTO)}</span>

                            <button type="button" class="btn btn-sm btn-danger" data-action="eliminar" aria-label="Quitar producto">
                                🗑
                            </button>

                        </div>

                        <div class="qty-stepper">

                            <button type="button" class="qty-btn" data-action="menos" aria-label="Restar">−</button>

                            <input
                                type="number"
                                min="1"
                                value="${item.cantidad}"
                                class="qty-input"
                                data-action-input="cantidad"
                                inputmode="numeric">

                            <button type="button" class="qty-btn" data-action="mas" aria-label="Sumar">+</button>

                        </div>

                        <div class="cart-item-subtotal">$${formatearPrecio(subtotal)}</div>

                    </div>

                </div>

            </div>`;
        });

        cont.innerHTML = html;
    }

    document.getElementById("cart-total").innerText = formatearPrecio(total);

    const avisoMinimo = document.getElementById("cart-minimo-aviso");
    if(avisoMinimo){
        if(total > 0 && total < pedidoMinimo){
            const falta = pedidoMinimo - total;
            avisoMinimo.textContent = `⚠️ Te faltan $${formatearPrecio(falta)} para el pedido mínimo de $${formatearPrecio(pedidoMinimo)}`;
            avisoMinimo.classList.remove("d-none");
        }else{
            avisoMinimo.classList.add("d-none");
        }
    }

    const btnCheckout = document.getElementById("btn-checkout");
    btnCheckout.disabled = estado.carrito.length === 0;

    const modalElement = document.getElementById("cartModal");
    const modal = bootstrap.Modal.getOrCreateInstance(modalElement);

    modal.show();
}

/* Delegación de eventos dentro del carrito */
document.getElementById("cart-items").addEventListener("click", function(e){

    const btn = e.target.closest("[data-action]");
    if(!btn) return;

    const row = btn.closest(".cart-item-row");
    if(!row) return;

    const codigo = row.dataset.code;

    if(btn.dataset.action === "eliminar") eliminarProducto(codigo);
    if(btn.dataset.action === "menos") cambiarCantidad(codigo, -1);
    if(btn.dataset.action === "mas") cambiarCantidad(codigo, 1);
});

document.getElementById("cart-items").addEventListener("change", function(e){

    if(e.target.dataset.actionInput === "cantidad"){

        const row = e.target.closest(".cart-item-row");
        actualizarCantidadManual(row.dataset.code, e.target.value);
    }
});

/**
 * Se ejecuta con cada tecla en el campo "Transporte". Si lo que hay
 * escrito coincide con una empresa que el negocio no trabaja, muestra
 * un aviso debajo del campo — no bloquea el tipeo en sí, pero si al
 * momento de enviar el pedido sigue coincidiendo, ahí sí se bloquea
 * el envío (ver checkoutWhatsapp).
 */
function validarCampoTransporte(){
    const input = document.getElementById("clienteEmpresa");
    const errorEl = document.getElementById("clienteEmpresaError");
    if(!input || !errorEl) return true;

    const bloqueado = transporteEstaBloqueado(input.value);

    if(bloqueado){
        errorEl.textContent = "No trabajamos con esa empresa de transporte. Elegí otra, por favor.";
        errorEl.style.display = "block";
        input.classList.add("is-invalid");
    }else{
        errorEl.style.display = "none";
        input.classList.remove("is-invalid");
    }

    return !bloqueado;
}

/** true si el texto ingresado coincide con alguna empresa de transporte no disponible */
function transporteEstaBloqueado(texto){
    const normalizado = normalizarTextoTransporte(texto);
    if(!normalizado) return false;
    return transportesNoDisponibles.some(bloqueado => normalizado.indexOf(bloqueado) !== -1);
}

/* =========================================================
   CHECKOUT (WHATSAPP)
========================================================= */

// Bandera explícita además de btn.disabled — evita que dos clics
// disparados casi en simultáneo (doble clic muy rápido) entren ambos
// a la función antes de que el atributo "disabled" surta efecto.
let enviandoPedido = false;

/** Puts the checkout button into its "sending" state: spinner, disabled, locked */
function activarCargaCheckout(){
    enviandoPedido = true;
    const btn = document.getElementById("btn-checkout");
    const texto = document.getElementById("btn-checkout-texto");
    if(btn){ btn.disabled = true; btn.classList.add("loading"); }
    if(texto) texto.textContent = "Enviando pedido...";
}

/** Restores the checkout button to its normal, clickable state */
function desactivarCargaCheckout(){
    enviandoPedido = false;
    const btn = document.getElementById("btn-checkout");
    const texto = document.getElementById("btn-checkout-texto");
    if(btn){ btn.disabled = false; btn.classList.remove("loading"); }
    if(texto) texto.textContent = "Enviar pedido por WhatsApp";
}

async function checkoutWhatsapp(){

    // Primera línea de defensa contra doble envío: si ya hay un pedido
    // en curso, no hace nada más — ni siquiera vuelve a validar.
    if(enviandoPedido) return;
    activarCargaCheckout();

    // Espera a que termine de cargar la configuración del negocio (de donde
    // sale whatsappNumero), por si el cliente hizo clic muy rápido y esa
    // carga todavía estaba en curso. Si ya terminó, esto no demora nada.
    // Si falla, igual sigue: whatsappNumero ya tiene el valor de respaldo.
    if(apariencaCargadaPromise){
        try{ await apariencaCargadaPromise; }catch(e){ /* whatsappNumero ya tiene el valor de respaldo */ }
    }

    const nombre = document.getElementById("clienteNombre").value.trim();
    const empresa = document.getElementById("clienteEmpresa").value.trim();
    const direccion = document.getElementById("clienteDireccion").value.trim();
    const localidad = document.getElementById("clienteLocalidad").value.trim();
    const provincia = document.getElementById("clienteProvincia").value.trim();
    const codigoPostal = document.getElementById("clienteCodigoPostal").value.trim();
    const telefono = document.getElementById("clienteTelefono").value.trim();
    const dni = document.getElementById("clienteDni").value.trim();

    if(nombre === "" || direccion === "" || localidad === "" || provincia === "" || telefono === "" || dni === ""){
        mostrarToast("Completá Nombre, Dirección, Localidad, Provincia, Teléfono y DNI o CUIT.", "error");
        desactivarCargaCheckout();
        return;
    }

    if(transporteEstaBloqueado(empresa)){
        validarCampoTransporte(); // muestra el aviso debajo del campo, por si no lo había visto
        mostrarToast("No trabajamos con la empresa de transporte indicada. Elegí otra para poder continuar.", "error");
        desactivarCargaCheckout();
        return;
    }

    if(estado.carrito.length === 0){
        mostrarToast("Tu carrito está vacío.", "error");
        desactivarCargaCheckout();
        return;
    }

    // Último chequeo antes de enviar: puede haber pasado tiempo desde
    // que se abrió el carrito (o directamente nunca se abrió si el
    // cliente fue directo a completar sus datos con un carrito viejo
    // guardado de una visita anterior). Si algo cambió, se corta acá
    // y se le pide que revise el carrito ya actualizado, en vez de
    // mandar un pedido con datos viejos.
    if(sincronizarCarritoConStockActual()){
        mostrarToast("Algunos productos de tu carrito cambiaron de stock — revisalo antes de enviar el pedido.", "error");
        desactivarCargaCheckout();
        return;
    }

    if(estado.carrito.length === 0){
        mostrarToast("Tu carrito quedó vacío después de actualizar el stock — agregá productos de nuevo.", "error");
        desactivarCargaCheckout();
        return;
    }

    let total = 0;
    estado.carrito.forEach(item => { total += item.PRECIO * item.cantidad; });

    if(total < 100000){
        const falta2 = pedidoMinimo - total;
        mostrarToast(`Te faltan $${formatearPrecio(falta2)} para llegar al pedido mínimo de $${formatearPrecio(pedidoMinimo)}.`, "error");
        desactivarCargaCheckout();
        return;
    }

    try{

        // POST en vez de GET: con varios productos en el carrito, armar
        // todo en la URL (como antes) podía superar el límite de longitud
        // de URL de Safari/iOS y el pedido fallaba sin guardarse. Con el
        // carrito en el body, no hay ese límite. El backend (doPost) ya
        // espera exactamente este formato para action: "guardarPedido".
        const response = await fetchAPI(API_URL, {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita que el navegador dispare un preflight CORS contra Apps Script
            body: JSON.stringify({
                action: "guardarPedido",
                nombre,
                empresa,
                direccion,
                localidad,
                provincia,
                codigoPostal,
                telefono,
                dni,
                total,
                carrito: estado.carrito
            })
        });
        const resultado = await response.json();

        if(!resultado.success){
            mostrarToast(resultado.message || "No se pudo guardar el pedido. Intentá de nuevo.", "error");
            desactivarCargaCheckout();
            return;
        }

        let mensaje = `*PEDIDO ${nombreNegocio.toUpperCase()}*

🧾 Pedido: ${resultado.pedidoId}

👤 Cliente: ${nombre}
🚚 Transporte: ${empresa}
🏠 Dirección: ${direccion}
📍 Localidad: ${localidad} (${provincia})${codigoPostal ? " - CP: " + codigoPostal : ""}
📱 Teléfono: ${telefono}
🆔 DNI/CUIT: ${dni}

`;

        estado.carrito.forEach(item=>{

            const subtotal = item.PRECIO * item.cantidad;

            mensaje += `
• ${item.PRODUCTO}
Cantidad: ${item.cantidad}
Subtotal: $${formatearPrecio(subtotal)}

`;
        });

        mensaje += `
💰 TOTAL: $${formatearPrecio(total)}
`;

        estado.carrito = [];
        localStorage.removeItem("carrito");
        guardarCarrito();

        document.getElementById("cart-items").innerHTML = "";
        document.getElementById("cart-total").innerText = "0";

        const modalElement = document.getElementById("cartModal");
        const modal = bootstrap.Modal.getInstance(modalElement);
        if(modal) modal.hide();

        desactivarCargaCheckout();

        setTimeout(()=>{
            window.location.href = `https://api.whatsapp.com/send?phone=${whatsappNumero}&text=${encodeURIComponent(mensaje)}`;
        }, 300);

    }catch(error){

        console.error(error);

        mostrarToast("Error al registrar el pedido.", "error");

        desactivarCargaCheckout();
    }
}

/* =========================================================
   VOLVER ARRIBA
========================================================= */

window.addEventListener("scroll", function(){

    const btn = document.getElementById("scroll-top-btn");

    if(window.scrollY > 400){
        btn.classList.remove("d-none");
    }else{
        btn.classList.add("d-none");
    }
});

/* =========================================================
   SINCRONIZACIÓN AL VOLVER A LA PÁGINA
========================================================= */

window.addEventListener("pageshow", function(){

    estado.carrito = JSON.parse(localStorage.getItem("carrito")) || [];

    actualizarContador();
});

// Recalcula la altura reservada para la barra del pedido mínimo si
// cambia el ancho de pantalla (p. ej. al rotar el celular), ya que
// el texto puede pasar de una a dos líneas y cambiar su alto real.
window.addEventListener("resize", function(){

    const cont = document.getElementById("minimo-progress");
    if(cont && !cont.classList.contains("d-none")){
        document.documentElement.style.setProperty("--minimo-bar-h", cont.offsetHeight + "px");
    }
});

/* =========================================================
   APARIENCIA (BANNER + TEMA) — DESDE GOOGLE SHEETS
   Se trae de la misma hoja CONFIGURACION que usa el panel
   admin, así ambos quedan siempre sincronizados.
========================================================= */

async function aplicarApariencia(){

    try{

        const res = await fetchAPI(API_URL + "?action=configuracionNegocio");
        const data = await res.json();

        if(!data.success || !data.config) return;

        const cfg = data.config;

        // --- Tema de color ---
        const tema = (cfg.tema || "navy").toLowerCase();
        document.body.setAttribute("data-tema", tema);

        // --- Texto e ícono del encabezado (navbar) ---
        const navbarTextoEl = document.getElementById("navbar-brand-texto");
        const navbarIconoEl = document.getElementById("navbar-brand-icono");

        if(navbarTextoEl && cfg.navbarTexto){
            navbarTextoEl.textContent = cfg.navbarTexto;
        }
        if(navbarIconoEl && cfg.navbarIcono){
            navbarIconoEl.textContent = cfg.navbarIcono;
        }

        // --- Gradiente propio (opcional, pisa el tema de arriba) ---
        if(cfg.gradPersonalizado && cfg.gradA && cfg.gradB){
            document.body.style.setProperty("--grad-a", cfg.gradA);
            document.body.style.setProperty("--grad-b", cfg.gradB);
        }else{
            document.body.style.removeProperty("--grad-a");
            document.body.style.removeProperty("--grad-b");
        }

        // --- Título / subtítulo del banner ---
        // Si vienen vacíos desde Configuración, se ocultan del todo (en vez
        // de dejar el texto de respaldo del HTML para siempre) — pensado
        // para cuando el banner ya es una imagen con su propio diseño y
        // texto incorporado, que no necesita nada del sistema superpuesto.
        const tituloEl = document.getElementById("hero-titulo");
        const subtituloEl = document.getElementById("hero-subtitulo");

        const tituloVacio = !cfg.bannerTitulo || !cfg.bannerTitulo.trim();

        if(tituloEl){
            if(tituloVacio){
                tituloEl.style.display = "none";
            }else{
                tituloEl.textContent = cfg.bannerTitulo;
                tituloEl.style.display = "";
            }
        }

        if(subtituloEl){
            if(!cfg.bannerSubtitulo || !cfg.bannerSubtitulo.trim()){
                subtituloEl.style.display = "none";
            }else{
                subtituloEl.textContent = cfg.bannerSubtitulo;
                subtituloEl.style.display = "";
            }
        }

        // --- Imagen de fondo del banner (opcional) ---
        const heroEl = document.getElementById("hero");

        if(heroEl && cfg.bannerImagen){
            heroEl.style.setProperty("--hero-bg-img", `url("${cfg.bannerImagen}")`);
            heroEl.classList.add("hero--imagen");

            // Si no hay título de texto del sistema, tampoco hace falta el
            // oscurecido que existe solo para que ese texto se lea bien
            // sobre la foto — así la imagen del banner se ve nítida, sin
            // ningún velo encima.
            heroEl.classList.toggle("hero--sin-degradado", tituloVacio);
        }

        // --- Título de la pestaña del navegador ---
        // El resto de los metadatos SEO/OG/Twitter/schema.org los aplica
        // aplicarConfigSEO() en config.js (ver el script inline al final
        // de index.html) — no se duplica acá para evitar dos fetches y
        // dos escrituras compitiendo sobre los mismos meta tags.
        if(cfg.nombre){
            document.title = cfg.nombre;
            nombreNegocio = cfg.nombre;
        }

        // --- Sección "Beneficios" (chips bajo el banner) ---
        aplicarBeneficios(cfg);

    }catch(err){
        // Si falla, la página sigue mostrando los valores fijos del HTML.
        console.error("No se pudo cargar la apariencia desde Sheets:", err);
    }
}

/**
 * Limpia un número de teléfono dejando solo dígitos y un "+" inicial
 * opcional, para armar un link tel: válido a partir de lo que el
 * admin haya escrito en Sheets (con guiones, espacios, paréntesis, etc).
 */
function limpiarTelefonoParaLink(telefono){
    return String(telefono || "").trim().replace(/[^\d+]/g, "");
}

/**
 * Devuelve el número de teléfono "para mostrar": igual a
 * limpiarTelefonoParaLink pero además le saca el código de país
 * argentino (549 / +549) del inicio, para mostrarlo más corto
 * en el modal de ubicación.
 */
function limpiarTelefonoParaMostrar(telefono){
    return limpiarTelefonoParaLink(telefono).replace(/^\+?549/, "");
}

/**
 * Muestra u oculta un chip de la sección Beneficios según tenga
 * contenido o no, para no dejar espacios vacíos en la fila.
 */
function configurarChipBeneficio(wrapId, visible){
    const wrap = document.getElementById(wrapId);
    if(wrap) wrap.classList.toggle("d-none", !visible);
}

function aplicarBeneficios(cfg){

    // --- WhatsApp: actualiza el botón flotante y la variable de checkout ---
    const numeroWa = limpiarTelefonoParaLink(cfg.beneficioWhatsappNumero) || whatsappNumero;
    whatsappNumero = numeroWa;

    const btnFlotanteWa = document.getElementById("whatsapp-float-btn");
    if(btnFlotanteWa){
        btnFlotanteWa.href = `https://wa.me/${numeroWa}`;
    }

    // --- Instagram ---
    const instagramUrl = (cfg.beneficioInstagramUrl || "").trim();
    const instagramEl = document.getElementById("beneficio-instagram");
    const instagramTextoEl = document.getElementById("beneficio-instagram-texto");

    if(instagramEl && instagramTextoEl && instagramUrl){
        instagramEl.href = instagramUrl;
        // Si pegaron solo "@usuario" o "usuario", se usa como texto;
        // si es una URL completa, se muestra "Instagram" como texto fijo.
        instagramTextoEl.textContent = instagramUrl.startsWith("http")
            ? "Instagram"
            : instagramUrl;
    }
    configurarChipBeneficio("beneficio-instagram-wrap", !!instagramUrl);

    // --- Teléfono 1 ---
    const tel1 = (cfg.beneficioTelefono1 || "").trim();
    const tel1El = document.getElementById("beneficio-telefono1");
    const tel1TextoEl = document.getElementById("beneficio-telefono1-texto");

    if(tel1El && tel1TextoEl && tel1){
        tel1El.href = "https://wa.me/" + limpiarTelefonoParaLink(tel1);
        tel1TextoEl.textContent = "WhatsApp";
    }
    configurarChipBeneficio("beneficio-telefono1-wrap", !!tel1);

    // --- Teléfono 2 ---
    const tel2 = (cfg.beneficioTelefono2 || "").trim();
    const tel2El = document.getElementById("beneficio-telefono2");
    const tel2TextoEl = document.getElementById("beneficio-telefono2-texto");

    if(tel2El && tel2TextoEl && tel2){
        tel2El.href = "https://wa.me/" + limpiarTelefonoParaLink(tel2);
        tel2TextoEl.textContent = "WhatsApp";
    }
    configurarChipBeneficio("beneficio-telefono2-wrap", !!tel2);

    // --- Dirección: chip que abre el modal de ubicación ---
    const direccion = (cfg.beneficioDireccion || "").trim();
    const direccionTextoEl = document.getElementById("beneficio-direccion-texto");

    if(direccionTextoEl && direccion){
        direccionTextoEl.textContent = direccion;
    }
    configurarChipBeneficio("beneficio-direccion-wrap", !!direccion);

    // --- Modal de ubicación: minimapa + dirección + teléfonos ---
    // Se completa siempre que haya al menos dirección o algún teléfono
    // cargado en el panel admin, aunque el chip de dirección de arriba
    // (que es el que lo abre) solo se muestra si hay dirección.
    const mapaWrap = document.getElementById("modalUbicacion-mapa-wrap");
    const mapaIframe = document.getElementById("modalUbicacion-mapa-iframe");

    if(mapaWrap && mapaIframe){
        if(direccion){
            // Embed público de Google Maps — no requiere API key
            mapaIframe.src = "https://maps.google.com/maps?q=" + encodeURIComponent(direccion) + "&z=15&output=embed";
            mapaWrap.classList.remove("d-none");
        } else {
            mapaIframe.src = "";
            mapaWrap.classList.add("d-none");
        }
    }

    const modalDireccionEl = document.getElementById("modalUbicacion-direccion");
    if(modalDireccionEl){
        modalDireccionEl.querySelector("span").textContent = direccion;
        modalDireccionEl.classList.toggle("d-none", !direccion);
    }

    const modalTel1El = document.getElementById("modalUbicacion-telefono1");
    if(modalTel1El){
        modalTel1El.href = "https://wa.me/" + limpiarTelefonoParaLink(tel1);
        modalTel1El.querySelector("span").textContent = limpiarTelefonoParaMostrar(tel1);
        modalTel1El.classList.toggle("d-none", !tel1);
    }

    const modalTel2El = document.getElementById("modalUbicacion-telefono2");
    if(modalTel2El){
        modalTel2El.href = "https://wa.me/" + limpiarTelefonoParaLink(tel2);
        modalTel2El.querySelector("span").textContent = limpiarTelefonoParaMostrar(tel2);
        modalTel2El.classList.toggle("d-none", !tel2);
    }

    const modalComoLlegarEl = document.getElementById("modalUbicacion-comofllegar");
    if(modalComoLlegarEl){
        if(direccion){
            modalComoLlegarEl.href = "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(direccion);
            modalComoLlegarEl.classList.remove("d-none");
        } else {
            modalComoLlegarEl.classList.add("d-none");
        }
    }

    // --- Textos libres (si el contenido es un link, se muestra como
    // botón clickable con el nombre de la red social detectada en vez
    // del texto plano original) ---
    const texto1 = (cfg.beneficioTextoLibre1 || "").trim();
    renderBeneficioTextoLibre("beneficio-texto1-wrap", texto1);
    configurarChipBeneficio("beneficio-texto1-wrap", !!texto1);

    const texto2 = (cfg.beneficioTextoLibre2 || "").trim();
    renderBeneficioTextoLibre("beneficio-texto2-wrap", texto2);
    configurarChipBeneficio("beneficio-texto2-wrap", !!texto2);

    aplicarBannerTop(cfg.bannerTopMensajes);

    // Pedido mínimo configurable
    const minimoConfigurado = Number(cfg.pedidoMinimo);
    if(!isNaN(minimoConfigurado) && minimoConfigurado >= 0){
        pedidoMinimo = minimoConfigurado;
    }

    // Recalcula la barra de progreso del mínimo por si el carrito ya
    // traía productos de una visita anterior (localStorage) antes de
    // que llegara este valor configurado del negocio.
    actualizarContador();

    // Transportes que el negocio no trabaja — el cliente no puede
    // escribirlos en el campo "Transporte" del carrito (ver
    // validarCampoTransporte()).
    transportesNoDisponibles = String(cfg.transportesNoDisponibles || "")
        .split("\n")
        .map(normalizarTextoTransporte)
        .filter(Boolean);

    // Popup promocional — se muestra si está activo y tiene imagen
    cargarPopupPromo(cfg);
}

/**
 * Muestra la franja superior con los mensajes configurados desde
 * Configuración → "Banner superior" (uno por línea). Si no hay
 * ningún mensaje, la franja queda oculta y el navbar/contenido vuelven
 * a su posición normal (--top-banner-h en 0). Con más de un mensaje,
 * rota entre ellos cada pocos segundos con un fade simple.
 */
let bannerTopIntervalId = null;

function aplicarBannerTop(mensajesTexto){
    const banner = document.getElementById("top-banner");
    const track = document.getElementById("top-banner-track");
    if(!banner || !track) return;

    if(bannerTopIntervalId){
        clearInterval(bannerTopIntervalId);
        bannerTopIntervalId = null;
    }

    const mensajes = String(mensajesTexto || "")
        .split("\n")
        .map(m => m.trim())
        .filter(m => m.length > 0);

    if(mensajes.length === 0){
        banner.classList.add("d-none");
        document.documentElement.style.setProperty("--top-banner-h", "0px");
        return;
    }

    track.innerHTML = mensajes
        .map((m, i) => `<span class="msg${i === 0 ? " activo" : ""}">${escapeHtml(m)}</span>`)
        .join("");

    banner.classList.remove("d-none");

    // La altura real (34px definidos en CSS para .top-banner-track,
    // pero se mide en vivo por si el texto necesita más de una línea
    // en pantallas angostas) se aplica recién después de que el
    // navegador ya puso la franja en el DOM, para que la medición sea
    // exacta — sin esto, podría medir 0 y dejar el navbar mal ubicado.
    requestAnimationFrame(() => {
        const alturaReal = banner.offsetHeight;
        document.documentElement.style.setProperty("--top-banner-h", alturaReal + "px");
    });

    if(mensajes.length > 1){
        let indiceActual = 0;
        bannerTopIntervalId = setInterval(() => {
            const spans = track.querySelectorAll(".msg");
            spans[indiceActual].classList.remove("activo");
            indiceActual = (indiceActual + 1) % spans.length;
            spans[indiceActual].classList.add("activo");
        }, 4000);
    }
}

/**
 * Lista de redes sociales/plataformas que se reconocen por su dominio,
 * con el nombre y la clase de ícono (Bootstrap Icons) que se muestran
 * en el chip cuando el texto libre es un link a ese sitio. Si el link
 * no coincide con ninguna, se usa el genérico "Visitar enlace" (ver
 * más abajo).
 */
const REDES_SOCIALES_CONOCIDAS = [
    { dominio: "tiktok.com",     nombre: "TikTok",    iconoClase: "bi-tiktok" },
    { dominio: "instagram.com",  nombre: "Instagram", iconoClase: "bi-instagram" },
    { dominio: "facebook.com",   nombre: "Facebook",  iconoClase: "bi-facebook" },
    { dominio: "fb.com",         nombre: "Facebook",  iconoClase: "bi-facebook" },
    { dominio: "wa.me",          nombre: "WhatsApp",  iconoClase: "bi-whatsapp" },
    { dominio: "whatsapp.com",   nombre: "WhatsApp",  iconoClase: "bi-whatsapp" },
    { dominio: "youtube.com",    nombre: "YouTube",   iconoClase: "bi-youtube" },
    { dominio: "youtu.be",       nombre: "YouTube",   iconoClase: "bi-youtube" },
    { dominio: "twitter.com",    nombre: "Twitter",   iconoClase: "bi-twitter-x" },
    { dominio: "x.com",          nombre: "X",         iconoClase: "bi-twitter-x" },
    { dominio: "linkedin.com",   nombre: "LinkedIn",  iconoClase: "bi-linkedin" },
    { dominio: "t.me",           nombre: "Telegram",  iconoClase: "bi-telegram" }
];

/** Returns {nombre, iconoClase} for a known social network, by matching its domain against the URL */
function detectarRedSocial(url){
    const urlMin = url.toLowerCase();
    const encontrada = REDES_SOCIALES_CONOCIDAS.find(r => urlMin.includes(r.dominio));
    return encontrada || { nombre: "Visitar enlace", iconoClase: "bi-link-45deg" };
}

/** Returns true if the text looks like a URL (with or without an explicit http(s):// scheme) */
function esLinkValido(texto){
    if(/^https?:\/\//i.test(texto)) return true;
    // También se acepta sin "https://" adelante (ej. "tiktok.com/@negocio"),
    // siempre que tenga la forma de un dominio con algo después.
    return /^[a-z0-9.-]+\.[a-z]{2,}\/?\S*$/i.test(texto);
}

/**
 * Pinta el contenido de un chip de "texto libre": si el texto es un
 * link, lo muestra como botón clickable (mismo estilo que el chip de
 * Instagram) con el nombre de la red social detectada; si no, lo
 * muestra como antes, como texto plano sin link.
 */
function renderBeneficioTextoLibre(idWrap, texto){
    const wrap = document.getElementById(idWrap);
    if(!wrap) return;

    if(!texto){
        wrap.innerHTML = `<span class="beneficio-item"></span>`;
        return;
    }

    if(esLinkValido(texto)){
        const href = /^https?:\/\//i.test(texto) ? texto : ("https://" + texto);
        const { nombre, iconoClase } = detectarRedSocial(texto);

        wrap.innerHTML = `
            <a href="${escapeHtml(href)}" class="beneficio-item beneficio-link" target="_blank" rel="noopener">
                <i class="bi ${escapeHtml(iconoClase)}"></i> <span>${escapeHtml(nombre)}</span>
            </a>
        `;
    } else {
        wrap.innerHTML = `<span class="beneficio-item">${escapeHtml(texto)}</span>`;
    }
}

/* =========================================================
   DESCARGA DE CATÁLOGO EN PDF
   El PDF ya está generado en el servidor (se arma solo todos los
   días a las 3 AM, con los productos que tengan stock a esa hora —
   ver generarCatalogoPDFDiario en code.gs) y guardado en Drive. Acá
   no se genera nada: solo se pide el link ya listo
   (?action=catalogoPDFInfo) y se abre para descargar. Por eso el
   botón responde casi al instante en vez de tener que armar el PDF
   en el navegador del cliente cada vez que lo aprieta.
========================================================= */

/** Main entry point: pide el link del catálogo PDF ya generado y lo descarga */
async function descargarCatalogoPDF(){

    const btn = document.getElementById("btn-descargar-pdf");
    const textoOriginal = btn ? btn.innerHTML : "";
    if(btn){ btn.disabled = true; btn.innerHTML = "⏳ Preparando..."; }

    try{

        const response = await fetchAPI(API_URL + "?action=catalogoPDFInfo");
        const data = await response.json();

        if(!data.success){
            mostrarToast(data.message || "No se pudo obtener el catálogo en PDF.", "error");
            return;
        }

        // Descarga directa del archivo ya generado en Drive.
        const link = document.createElement("a");
        link.href = data.url;
        link.target = "_blank";
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();

        mostrarToast("Descargando catálogo...", "success");

    }catch(error){
        console.error("Error al descargar el catálogo PDF:", error);
        mostrarToast("No se pudo descargar el catálogo. Intentá de nuevo.", "error");
    }finally{
        if(btn){ btn.disabled = false; btn.innerHTML = textoOriginal; }
    }
}


/* =========================================================
   INICIO
========================================================= */

// Inicialización: primero fijar API_URL desde config.js, luego
// apariencia y productos para que API_URL ya esté lista.
(async () => {
  await cargarConfigCliente();
  apariencaCargadaPromise = aplicarApariencia();
  actualizarContador();
  await cargarProductos();
  abrirProductoDesdeURL();
})();

/* =========================================================
   SEGUIMIENTO DE PEDIDO
========================================================= */

function abrirConsultaPedido() {
  resetConsultaPedido();
  const modal = bootstrap.Modal.getOrCreateInstance(document.getElementById("modalConsultaPedido"));
  modal.show();
  setTimeout(() => document.getElementById("consultaPedidoId").focus(), 300);
}

function resetConsultaPedido() {
  document.getElementById("consultaForm").style.display = "block";
  document.getElementById("consultaResultado").style.display = "none";
  document.getElementById("consultaPedidoId").value = "";
  document.getElementById("consultaDni").value = "";
  document.getElementById("consultaError").classList.add("d-none");
  document.getElementById("consultaError").textContent = "";
  const btn = document.getElementById("btnConsultar");
  btn.disabled = false;
  btn.textContent = "Consultar";
}

const ESTADO_COLOR = {
  NUEVO:      { bg:"#fef9ec", color:"#b45309", texto:"Nuevo" },
  PREPARANDO: { bg:"#eaf1ff", color:"#2563eb", texto:"Preparando" },
  ENVIADO:    { bg:"#eafaf0", color:"#16a34a", texto:"Enviado" },
  CANCELADO:  { bg:"#fdecec", color:"#dc2626", texto:"Cancelado" }
};

async function ejecutarConsultaPedido() {
  const pedidoId = "PED-" + document.getElementById("consultaPedidoId").value.trim();
  const dni = document.getElementById("consultaDni").value.trim();
  const errorBox = document.getElementById("consultaError");

  errorBox.classList.add("d-none");

  if (!pedidoId || !dni) {
    errorBox.textContent = "Completá el número de pedido y tu DNI.";
    errorBox.classList.remove("d-none");
    return;
  }

  const btn = document.getElementById("btnConsultar");
  btn.disabled = true;
  btn.textContent = "Consultando...";

  try {
    const response = await fetch(
      API_URL + "?action=consultarPedido&pedidoId=" + encodeURIComponent(pedidoId) + "&dni=" + encodeURIComponent(dni)
    );
    const data = await response.json();

    if (!data.success) {
      errorBox.textContent = data.message || "No se pudo consultar el pedido.";
      errorBox.classList.remove("d-none");
      btn.disabled = false;
      btn.textContent = "Consultar";
      return;
    }

    const { pedido, items } = data;
    const estado = ESTADO_COLOR[pedido.ESTADO] || { bg:"#f4f4f4", color:"#333", texto: pedido.ESTADO };
    const simbolo = String(pedido.MONEDA || "ARS").toUpperCase() === "USD" ? "US$" : "$";
    const fecha = pedido.FECHA ? new Date(pedido.FECHA).toLocaleDateString("es-AR", {day:"2-digit", month:"2-digit", year:"numeric"}) : "—";

    const itemsHtml = items.map(i =>
      `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid #eee;font-size:13px;">
        <span>${i.cantidad}x ${i.PRODUCTO}</span>
        <span style="font-weight:600;">${simbolo}${Number(i.subtotal || 0).toLocaleString("es-AR")}</span>
      </div>`
    ).join("");

    const envioHtml = [pedido.DIRECCION, pedido.LOCALIDAD, pedido.PROVINCIA].filter(Boolean).join(", ");

    document.getElementById("consultaResultadoBody").innerHTML = `
      <div style="border-radius:12px;background:#f7f8fa;padding:16px;margin-bottom:12px;">
        <div style="font-size:11px;font-weight:700;color:#6b7585;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px;">${pedido.PEDIDO_ID} · ${fecha}</div>
        <div style="font-size:17px;font-weight:800;color:#0b1633;margin-bottom:8px;">${pedido.NOMBRE}</div>
        <div style="display:inline-block;padding:4px 14px;border-radius:20px;font-size:12px;font-weight:700;background:${estado.bg};color:${estado.color};">
          ${estado.texto}
        </div>
      </div>

      ${envioHtml ? `<div style="font-size:13px;color:#6b7585;margin-bottom:4px;">📍 ${envioHtml}</div>` : ""}
      ${pedido.EMPRESA ? `<div style="font-size:13px;color:#6b7585;margin-bottom:12px;">🚚 Transporte: ${pedido.EMPRESA}</div>` : `<div style="margin-bottom:12px;"></div>`}

      <div style="background:#fff;border-radius:10px;padding:12px;border:1px solid #e2e6ed;">
        <div style="font-size:12px;font-weight:700;color:#6b7585;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px;">Resumen del pedido</div>
        ${itemsHtml}
        <div style="display:flex;justify-content:space-between;padding-top:10px;font-weight:800;font-size:15px;color:#0b1633;">
          <span>Total</span>
          <span>${simbolo}${Number(pedido.TOTAL || 0).toLocaleString("es-AR")}</span>
        </div>
      </div>`;

    document.getElementById("consultaForm").style.display = "none";
    document.getElementById("consultaResultado").style.display = "block";

  } catch (error) {
    console.error("Error al consultar el pedido:", error);
    errorBox.textContent = "Error de conexión. Intentá de nuevo en unos segundos.";
    errorBox.classList.remove("d-none");
    btn.disabled = false;
    btn.textContent = "Consultar";
  }
}

// Permitir consultar con Enter
document.addEventListener("DOMContentLoaded", () => {
  ["consultaPedidoId", "consultaDni"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") ejecutarConsultaPedido(); });
  });
});

/* =========================================================
   POPUP PROMOCIONAL
========================================================= */

// Extensiones que se consideran video. Si la URL no tiene ninguna
// de estas extensiones (por ej. viene de Google Drive sin .mp4 al final),
// se puede forzar el tipo con el 2do parámetro ("imagen" | "video").
const EXTENSIONES_VIDEO_POPUP = [".mp4", ".webm", ".ogg", ".mov", ".m4v"];

function esUrlDeVideo(url) {
  const limpia = String(url || "").split("?")[0].toLowerCase();
  return EXTENSIONES_VIDEO_POPUP.some(ext => limpia.endsWith(ext));
}

function mostrarPopupPromo(url, tipo) {
  if (!url) return;
  const popup = document.getElementById("popupPromo");
  const img = document.getElementById("popupPromoImg");
  const video = document.getElementById("popupPromoVideo");
  if (!popup || !img || !video) return;

  const esVideo = tipo ? tipo === "video" : esUrlDeVideo(url);

  if (esVideo) {
    img.style.display = "none";
    img.src = "";
    video.src = url;
    video.style.display = "block";
    video.currentTime = 0;
    video.play().catch(() => {}); // algunos navegadores bloquean autoplay con sonido
  } else {
    video.style.display = "none";
    video.pause();
    video.src = "";
    img.src = url;
    img.style.display = "block";
  }

  popup.style.display = "flex";
  document.body.style.overflow = "hidden";
}

function cerrarPopupPromo() {
  const popup = document.getElementById("popupPromo");
  const video = document.getElementById("popupPromoVideo");
  if (popup) popup.style.display = "none";
  if (video) video.pause();
  document.body.style.overflow = "";
}

// Cargar popup si está activo — se llama desde aplicarApariencia
// Soporta config.popupImagen (imagen o video, se detecta por extensión)
// y opcionalmente config.popupTipo ("imagen" | "video") para forzar el tipo
// cuando la URL no tiene extensión reconocible (ej: enlaces de Drive/Sheets).
function cargarPopupPromo(config) {
  if (config && config.popupActivo && config.popupImagen) {
    // Pequeña espera para que el catálogo cargue primero
    setTimeout(() => mostrarPopupPromo(config.popupImagen, config.popupTipo), 800);
  }
}
