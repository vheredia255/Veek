/* ===================================================================
   JIREH ADMIN — app logic v2
   • All original Apps Script API calls preserved
   • Thermal print (POS80 80mm) added
   • Dashboard POS summary added
   • Responsive mobile nav sync added
=================================================================== */

// API_URL dinámica — se carga desde config.json al iniciar.
// Permite instalar el mismo código para distintos clientes
// sin modificar nada manualmente.
let API_URL =
  "https://script.google.com/macros/s/AKfycbw1eY_mXImG503rU0Cqddx1WBuGIOhxaW_SXGoIMsug_CjsSC-HLsb2XzYwrovaGBU/exec";

/**
 * Reemplazo de fetch() para las llamadas al backend, con timeout
 * automático y reintentos seguros — pensado para conexiones
 * inestables (wifi que se corta un momento, 4G que titila, etc.).
 *
 * Antes, un corte momentáneo de conexión dejaba el fetch() colgado
 * esperando una respuesta que podía no llegar nunca — sin timeout, el
 * navegador puede tardar más de un minuto en darse por vencido solo.
 * Eso se sentía como que "el sistema se congeló", cuando en realidad
 * solo hacía falta reintentar.
 *
 * - LECTURAS (sin body / GET, la gran mayoría de las llamadas: cargar
 *   productos, pedidos, clientes, reportes, etc.): si fallan por
 *   timeout o corte de red, se reintentan solas 1 vez más — no tienen
 *   ningún efecto secundario, así que reintentar es 100% seguro.
 * - MUTACIONES (POST: crear/editar/eliminar algo, registrar un pago,
 *   etc.): acá NO se reintenta solo. Si la operación ya había llegado
 *   al servidor y solo se cortó la respuesta de vuelta, reintentar a
 *   ciegas podría duplicarla (dos clientes, dos pagos, dos deudas).
 *   Solo se les pone un límite de tiempo para que al menos fallen
 *   rápido y avisen con un error claro, en vez de dejar el botón
 *   "Guardando..." colgado para siempre — así el usuario puede
 *   revisar si se guardó o no antes de reintentar a mano.
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
      // Corte momentáneo — pequeña espera antes de reintentar
      await new Promise(r => setTimeout(r, 400 * intento));
    }
  }
  throw ultimoError;
}

async function cargarConfigCliente() {
  try {
    const res = await fetch("../config.json?_=" + Date.now(), { cache: "no-store" });
    if (res.ok) {
      const cfg = await res.json();
      if (cfg.apiUrl) API_URL = cfg.apiUrl;
      return true; // config.json existe: esta instalación ya fue configurada alguna vez
    }
  } catch(e) {
    console.log("config.json no encontrado, usando URL por defecto");
  }
  return false;
}

let pedidosGlobal = [];
let _avisoPedidosCaido = false; // evita repetir el toast de error de conexión en cada ciclo del polling

// Store last completed sale for "print from receipt modal"
let ultimaVentaImprimible = null;

// Store POS sales loaded for dashboard
let ventasPOSGlobal = [];

// El chequeo de "¿está logueado?" se hizo ANTES una función síncrona
// que corría acá mismo, redirigiendo a login.html apenas se cargaba
// el script — sin siquiera esperar a ver si config.json existía. El
// problema: en una instalación recién copiada para un cliente nuevo
// (sin config.json todavía, porque no pasó por el Instalador), esto
// mandaba a login.html, que terminaba usando la URL de Apps Script
// de Jireh que viene por defecto en el código — pidiendo la
// contraseña de OTRA cuenta que el cliente nuevo ni siquiera tiene.
// Ahora esa decisión se toma recién dentro de DOMContentLoaded, una
// vez que ya se supo si esta instalación tiene config.json propio o no.

function iniciarPollingSecciones() {
  const offsetInicial = Math.floor(Math.random() * 4000);

  setTimeout(() => {
    ejecutarPollingSecciones();
    setInterval(ejecutarPollingSecciones, 15000); // 15 s — near real-time without hammering the API
  }, offsetInicial);
}

function ejecutarPollingSecciones() {
  if (document.hidden) return; // pestaña en segundo plano: no consultar

  const dashboardVisible = document.getElementById("dashboard").style.display === "block";
  const pedidosVisible   = document.getElementById("pedidos").style.display === "block";
  const clientesVisible  = document.getElementById("clientes").style.display === "block";

  // Antes esto llamaba a cargarMetricas() siempre, aunque el cajero
  // estuviera en Productos o en el POS vendiendo — son llamadas al
  // backend (Apps Script + Sheets) que no hacían falta y competían
  // con lo que el cajero estaba haciendo en ese momento. Ahora solo
  // se actualiza la pantalla que efectivamente está en uso.
  if (dashboardVisible) { cargarMetricas(); cargarVentasPOS(); }
  if (pedidosVisible)   cargarPedidos();
  if (clientesVisible)  cargarClientes();
}

document.addEventListener("DOMContentLoaded", async () => {
  const yaConfigurado = await cargarConfigCliente();

  if (!yaConfigurado) {
    // Instalación nueva, sin config.json propio todavía — no tiene
    // sentido pedir login (no hay ninguna cuenta real detrás todavía,
    // y menos la de otro cliente). Se muestra directo el Instalador,
    // sin arrancar nada que dependa de un backend que no existe.
    document.querySelectorAll(".sidebar a[data-target], #bottomNavLinks a[data-target]").forEach(a => {
      if (a.getAttribute("data-target") !== "instalador") a.style.display = "none";
    });
    mostrarSeccion("instalador");
    toast("Primera vez acá — completá el Instalador para configurar este negocio", "success");

    const cat = document.getElementById("loadingCat");
    if (cat) { cat.style.opacity = "0"; setTimeout(() => cat.remove(), 500); }
    return;
  }

  if (sessionStorage.getItem("admin") !== "true") {
    window.location.href = "login.html";
    return;
  }

  // Verificar licencia (solo en Electron con window.veekpos disponible)
  aplicarEstadoLicencia();

  mostrarSeccion("dashboard");
  cargarConfigNegocioDesdeBackend();
  reconectarImpresoraUSBSiPosible();
  // Antes esto esperaba a que terminaran las métricas para recién
  // ahí arrancar el pedido de ventas POS — dos idas y vueltas al
  // backend en serie, una atrás de la otra, aunque no dependen entre
  // sí. Ahora arrancan las dos al mismo tiempo: el dashboard queda
  // listo en lo que tarda la más lenta de las dos, no en la suma.
  await Promise.all([cargarMetricas(), cargarVentasPOS()]);
  iniciarPollingSecciones();

  // Si quedaron ventas pendientes de sincronizar de una sesión
  // anterior (por ejemplo, se cerró la app en medio de un corte de
  // conexión), mostrar el aviso y probar subirlas ahora.
  actualizarBadgeVentasPendientes(_leerColaVentasPendientes().length);
  sincronizarVentasPendientes();

  // Ocultar el loading cat una vez que el dashboard cargó
  const cat = document.getElementById("loadingCat");
  if (cat) {
    cat.style.opacity = "0";
    setTimeout(() => cat.remove(), 500);
  }

  setupScannerListener();
});


/* ===================== UTILS ===================== */

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

/**
 * Devuelve una versión "demorada" de una función: si se la llama
 * varias veces seguidas (por ejemplo, una vez por cada tecla mientras
 * alguien escribe rápido en un buscador), solo se ejecuta la ÚLTIMA
 * llamada, esperando `demoraMs` desde que paró de llamarse — evita
 * redibujar una tabla o grilla completa en cada tecla, cuando en la
 * práctica el usuario ya tipeó la letra siguiente antes de llegar a
 * ver el resultado intermedio.
 *
 * Uso: const buscarConDemora = debounce(buscarFunction, 150);
 *      buscarConDemora(); // se llama igual que la función original
 */
function debounce(fn, demoraMs) {
  let temporizador = null;
  return function (...args) {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => fn.apply(this, args), demoraMs);
  };
}

function actualizarElemento(id, valor) {
  const el = document.getElementById(id);
  if (el) el.textContent = valor;
}

/* ===================== CONFIGURACIÓN DEL NEGOCIO (encabezado del ticket) ===================== */

// Valores por defecto — son los que ya venía usando el ticket, así que
// si todavía no cargó la config del servidor, todo se imprime igual que antes.
const CONFIG_NEGOCIO_DEFAULT = {
  nombre:     "JIREH",
  subtitulo:  "Punto de Venta",
  direccion:  "",
  telefono1:  "",
  telefono2:  "",
  pie:        "¡Gracias por su compra!",

  bannerTitulo:    "Mayorista Jireh",
  bannerSubtitulo: "Catálogo Mayorista Online",
  bannerImagen:    "",
  tema:            "navy"
};

// Caché en memoria de la config, para que imprimir un ticket no tenga
// que esperar una llamada al servidor cada vez. Se carga al iniciar la
// app y se refresca cada vez que se guarda desde el formulario.
let configNegocioCache = { ...CONFIG_NEGOCIO_DEFAULT };

/** Synchronous read used by the print functions — always returns instantly from the in-memory cache */
function obtenerConfigNegocio() {
  return configNegocioCache;
}

/** Fetches the saved config from the backend (hoja CONFIGURACION) and refreshes the in-memory cache */
async function cargarConfigNegocioDesdeBackend() {
  try {
    const response = await fetchAPI(API_URL + "?action=configuracionNegocio");
    const data = await response.json();
    if (data.success && data.config) {
      configNegocioCache = { ...CONFIG_NEGOCIO_DEFAULT, ...data.config };
      aplicarSidebarBrand(configNegocioCache);
      aplicarTemaAdmin(configNegocioCache);
    }
  } catch (error) {
    console.warn("No se pudo cargar la configuración del negocio:", error);
  }
  return configNegocioCache;
}

/** Loads the saved config into the form fields (called when the Configuración section opens) */
async function cargarConfigNegocioForm() {
  const form = document.getElementById("cfgNombreLocal");
  if (form) form.placeholder = "Cargando...";

  const cfg = await cargarConfigNegocioDesdeBackend();

  document.getElementById("cfgNombreLocal").value = cfg.nombre;
  document.getElementById("cfgSubtitulo").value   = cfg.subtitulo;
  document.getElementById("cfgDireccion").value   = cfg.direccion;
  document.getElementById("cfgTelefono1").value   = cfg.telefono1;
  document.getElementById("cfgTelefono2").value   = cfg.telefono2;
  document.getElementById("cfgPie").value         = cfg.pie;

  cargarAparienciaForm(cfg);
  cargarBeneficiosForm(cfg);
  document.getElementById("cfgBannerTopMensajes").value = cfg.bannerTopMensajes ?? "";
  document.getElementById("cfgTransportesNoDisponibles").value = cfg.transportesNoDisponibles ?? "";
  cargarSidebarForm(cfg);
  cargarDriveProductosForm(cfg);
  cargarDrivePedidosForm(cfg);
  cargarUrlCatalogoForm(cfg);

  if (form) form.placeholder = "Ej: JIREH";
}

/** Reads the form fields and saves them to the backend (hoja CONFIGURACION) */
async function guardarConfigNegocioForm() {
  const nombre = document.getElementById("cfgNombreLocal").value.trim();

  if (!nombre) {
    toast("El nombre del local es obligatorio", "error");
    return;
  }

  const cfg = {
    nombre,
    subtitulo: document.getElementById("cfgSubtitulo").value.trim(),
    direccion: document.getElementById("cfgDireccion").value.trim(),
    telefono1: document.getElementById("cfgTelefono1").value.trim(),
    telefono2: document.getElementById("cfgTelefono2").value.trim(),
    pie:       document.getElementById("cfgPie").value.trim()
  };

  const btn = document.getElementById("btnGuardarConfigNegocio");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", ...cfg });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar la configuración", "error");
      return;
    }

    configNegocioCache = { ...cfg };
    toast("Configuración guardada", "success");

  } catch (error) {
    console.error("Error al guardar la configuración del negocio:", error);
    toast("Error de conexión al guardar la configuración", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/**
 * Modal de confirmación genérico, para reemplazar usos puntuales de
 * window.confirm() nativo — ese diálogo síncrono puede dejar el foco
 * de teclado roto en Electron después de cerrarse (el input de texto
 * deja de responder). mensaje: texto a mostrar. onConfirmar: función
 * que se ejecuta si el usuario confirma.
 */
function confirmarAccion(mensaje, onConfirmar, titulo) {
  window._accionConfirmadaCallback = onConfirmar;

  const backdrop = document.getElementById("modalConfirmGenericoBackdrop");
  const texto = document.getElementById("modalConfirmGenericoTexto");
  const tituloEl = document.getElementById("modalConfirmGenericoTitulo");
  if (texto) texto.textContent = mensaje;
  if (tituloEl) tituloEl.textContent = titulo || "⚠️ Confirmar acción";
  if (backdrop) backdrop.classList.add("show");
}

function cerrarModalConfirmGenerico() {
  const backdrop = document.getElementById("modalConfirmGenericoBackdrop");
  if (backdrop) backdrop.classList.remove("show");
  window._accionConfirmadaCallback = null;
}

function _ejecutarAccionConfirmada() {
  const fn = window._accionConfirmadaCallback;
  cerrarModalConfirmGenerico();
  if (typeof fn === "function") fn();
}

/** Resets the form (and the saved sheet values) back to the original JIREH defaults */
function restablecerConfigNegocio() {
  confirmarAccion(
    "¿Restablecer los datos del local a los valores originales?",
    _restablecerConfigNegocioConfirmado
  );
}

async function _restablecerConfigNegocioConfirmado() {
  document.getElementById("cfgNombreLocal").value = CONFIG_NEGOCIO_DEFAULT.nombre;
  document.getElementById("cfgSubtitulo").value   = CONFIG_NEGOCIO_DEFAULT.subtitulo;
  document.getElementById("cfgDireccion").value   = CONFIG_NEGOCIO_DEFAULT.direccion;
  document.getElementById("cfgTelefono1").value   = CONFIG_NEGOCIO_DEFAULT.telefono1;
  document.getElementById("cfgTelefono2").value   = CONFIG_NEGOCIO_DEFAULT.telefono2;
  document.getElementById("cfgPie").value         = CONFIG_NEGOCIO_DEFAULT.pie;

  await guardarConfigNegocioForm();
}

/** Prints a sample receipt using the form's current (possibly unsaved) values, so the admin can check before saving */
function vistaPreviaTicketConfig() {
  const cfgPreview = {
    nombre:    document.getElementById("cfgNombreLocal").value.trim() || CONFIG_NEGOCIO_DEFAULT.nombre,
    subtitulo: document.getElementById("cfgSubtitulo").value.trim(),
    direccion: document.getElementById("cfgDireccion").value.trim(),
    telefono1: document.getElementById("cfgTelefono1").value.trim(),
    telefono2: document.getElementById("cfgTelefono2").value.trim(),
    pie:       document.getElementById("cfgPie").value.trim() || CONFIG_NEGOCIO_DEFAULT.pie
  };

  const itemsEjemplo = [
    { PRODUCTO: "Producto de ejemplo", PRECIO: 1500, cantidad: 2 },
    { PRODUCTO: "Otro producto", PRECIO: 800, cantidad: 1 }
  ];
  const total = itemsEjemplo.reduce((acc, i) => acc + i.PRECIO * i.cantidad, 0);

  const frame = document.getElementById("thermalPrintFrame");
  if (!frame) { toast("Error: frame de impresión no encontrado", "error"); return; }

  frame.innerHTML = buildThermalHTML("PREVIEW", itemsEjemplo, total, "EFECTIVO", new Date(), null, cfgPreview);

  setTimeout(() => { window.print(); }, 120);
}

/* ===================== APARIENCIA DEL PANEL ADMIN (letra + nombre del sidebar) ===================== */

const SIDEBAR_BRAND_DEFAULT = {
  sidebarMark:  "J",
  sidebarTexto: "JIREH"
};

/** Applies the saved letter/name to the sidebar in the DOM — runs on every page load, not just inside Configuración */
function aplicarSidebarBrand(cfg) {
  const markEl  = document.getElementById("sidebarMark");
  const textoEl = document.getElementById("sidebarLabelTexto");

  if (markEl)  markEl.textContent  = (cfg.sidebarMark  || SIDEBAR_BRAND_DEFAULT.sidebarMark).toUpperCase();
  if (textoEl) textoEl.textContent = (cfg.sidebarTexto || SIDEBAR_BRAND_DEFAULT.sidebarTexto).toUpperCase();
}

/** Loads the saved letter/name into the "Apariencia del panel admin" form */
function cargarSidebarForm(cfg) {
  document.getElementById("cfgSidebarMark").value  = cfg.sidebarMark  ?? SIDEBAR_BRAND_DEFAULT.sidebarMark;
  document.getElementById("cfgSidebarTexto").value = cfg.sidebarTexto ?? SIDEBAR_BRAND_DEFAULT.sidebarTexto;
}

/** Reads the form and saves the sidebar letter/name to the backend (hoja CONFIGURACION) */
async function guardarSidebarForm() {
  const nombre = document.getElementById("cfgNombreLocal").value.trim();

  if (!nombre) {
    toast("Completá primero el nombre del local, arriba", "error");
    return;
  }

  const cfg = {
    nombre,
    sidebarMark:  document.getElementById("cfgSidebarMark").value.trim() || SIDEBAR_BRAND_DEFAULT.sidebarMark,
    sidebarTexto: document.getElementById("cfgSidebarTexto").value.trim()
  };

  const btn = document.getElementById("btnGuardarSidebar");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", ...cfg });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar", "error");
      return;
    }

    configNegocioCache = { ...configNegocioCache, ...cfg };
    aplicarSidebarBrand(configNegocioCache);
    toast("Listo, ya se ve en el sidebar", "success");

  } catch (error) {
    console.error("Error al guardar el sidebar:", error);
    toast("Error de conexión al guardar", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/** Loads the configured Drive folder (for product photo uploads) into the Configuración form */
function cargarDriveProductosForm(cfg) {
  const input = document.getElementById("cfgDriveCarpetaProductos");
  if (input) input.value = cfg.driveCarpetaProductosId || "";
}

/** Saves the Drive folder link/ID used for product photo uploads */
async function guardarDriveProductosForm() {
  const nombre = document.getElementById("cfgNombreLocal").value.trim();

  if (!nombre) {
    toast("Completá primero el nombre del local, arriba", "error");
    return;
  }

  const cfg = {
    nombre,
    driveCarpetaProductosId: document.getElementById("cfgDriveCarpetaProductos").value.trim()
  };

  const btn = document.getElementById("btnGuardarDriveProductos");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", ...cfg });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar", "error");
      return;
    }

    configNegocioCache = { ...configNegocioCache, ...cfg };
    toast("Carpeta de Drive guardada", "success");

  } catch (error) {
    console.error("Error al guardar la carpeta de Drive:", error);
    toast("Error de conexión al guardar", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/** Loads the configured Drive folder (for order PDF storage) into the Configuración form */
function cargarDrivePedidosForm(cfg) {
  const carpetaInput = document.getElementById("cfgDriveCarpetaPedidos");
  if (carpetaInput) carpetaInput.value = cfg.driveCarpetaPedidosId || "";

  const subtituloInput = document.getElementById("cfgPedidoPdfSubtitulo");
  if (subtituloInput) subtituloInput.value = cfg.pedidoPdfSubtitulo || "";

  const pieInput = document.getElementById("cfgPedidoPdfPie");
  if (pieInput) pieInput.value = cfg.pedidoPdfPie || "";
}

/** Loads the catalog public URL into the Configuración form, used to build price-QR links */
function cargarUrlCatalogoForm(cfg) {
  const input = document.getElementById("cfgUrlCatalogo");
  if (input) input.value = cfg.urlCatalogo || "";
}

/** Saves the catalog public URL */
async function guardarUrlCatalogoForm() {
  const nombre = document.getElementById("cfgNombreLocal").value.trim();

  if (!nombre) {
    toast("Completá primero el nombre del local, arriba", "error");
    return;
  }

  const cfg = {
    nombre,
    urlCatalogo: document.getElementById("cfgUrlCatalogo").value.trim().replace(/\/+$/, "") // sin / al final, evita //precio.html
  };

  const btn = document.getElementById("btnGuardarUrlCatalogo");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", ...cfg });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar", "error");
      return;
    }

    configNegocioCache = { ...configNegocioCache, ...cfg };
    toast("URL del catálogo guardada", "success");

  } catch (error) {
    console.error("Error al guardar la URL del catálogo:", error);
    toast("Error de conexión al guardar", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/** Saves both the Drive folder and the editable texts used by the order PDF */
async function guardarDrivePedidosForm() {
  const nombre = document.getElementById("cfgNombreLocal").value.trim();

  if (!nombre) {
    toast("Completá primero el nombre del local, arriba", "error");
    return;
  }

  const cfg = {
    nombre,
    driveCarpetaPedidosId: document.getElementById("cfgDriveCarpetaPedidos").value.trim(),
    pedidoPdfSubtitulo:    document.getElementById("cfgPedidoPdfSubtitulo").value.trim(),
    pedidoPdfPie:          document.getElementById("cfgPedidoPdfPie").value.trim()
  };

  const btn = document.getElementById("btnGuardarDrivePedidos");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", ...cfg });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar", "error");
      return;
    }

    configNegocioCache = { ...configNegocioCache, ...cfg };
    toast("Configuración del PDF de pedidos guardada", "success");

  } catch (error) {
    console.error("Error al guardar la carpeta de Drive:", error);
    toast("Error de conexión al guardar", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/**
 * Cambia el usuario/contraseña de acceso al panel. Requiere la
 * contraseña actual — el backend la valida antes de aplicar el cambio.
 * Por seguridad, este formulario nunca precarga el usuario/contraseña
 * vigentes (a diferencia de los demás formularios de Configuración).
 */
async function guardarCredencialesForm() {
  const passwordActual = document.getElementById("credPasswordActual").value;
  const nuevoUsuario = document.getElementById("credNuevoUsuario").value.trim();
  const nuevaPassword = document.getElementById("credNuevaPassword").value;

  if (!passwordActual) {
    toast("Ingresá tu contraseña actual para confirmar el cambio", "error");
    return;
  }

  if (!nuevoUsuario || !nuevaPassword) {
    toast("Completá el nuevo usuario y la nueva contraseña", "error");
    return;
  }

  if (nuevaPassword.length < 4) {
    toast("La nueva contraseña debe tener al menos 4 caracteres", "error");
    return;
  }

  const btn = document.getElementById("btnGuardarCredenciales");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({
      action: "guardarCredencialesAdmin",
      passwordActual,
      nuevoUsuario,
      nuevaPassword
    });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo cambiar el acceso", "error");
      return;
    }

    document.getElementById("credPasswordActual").value = "";
    document.getElementById("credNuevoUsuario").value = "";
    document.getElementById("credNuevaPassword").value = "";
    toast("Usuario y contraseña actualizados", "success");

  } catch (error) {
    console.error("Error al cambiar las credenciales:", error);
    toast("Error de conexión al guardar", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/**
 * Cambia la contraseña de acceso a stock.html. Requiere la contraseña
 * ACTUAL DEL PANEL ADMIN (no la de stock vieja) para autorizar el
 * cambio — quien está acá adentro ya demostró ser admin, no hace
 * falta pedirle que recuerde una segunda contraseña.
 */
async function guardarPasswordStockForm() {
  const passwordActualAdmin = document.getElementById("stockPasswordAdminActual").value;
  const nuevaPasswordStock = document.getElementById("stockPasswordNueva").value;

  if (!passwordActualAdmin) {
    toast("Ingresá tu contraseña del panel admin para confirmar el cambio", "error");
    return;
  }
  if (!nuevaPasswordStock || nuevaPasswordStock.length < 4) {
    toast("La nueva contraseña de stock debe tener al menos 4 caracteres", "error");
    return;
  }

  const btn = document.getElementById("btnGuardarPasswordStock");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({
      action: "guardarPasswordStock",
      passwordActualAdmin,
      nuevaPasswordStock
    });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo cambiar la contraseña de stock", "error");
      return;
    }

    document.getElementById("stockPasswordAdminActual").value = "";
    document.getElementById("stockPasswordNueva").value = "";
    toast("Contraseña de stock actualizada", "success");

  } catch (error) {
    console.error("Error al cambiar la contraseña de stock:", error);
    toast("Error de conexión al guardar", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/* ===================== APARIENCIA DEL CATÁLOGO WEB (banner + tema) ===================== */

const APARIENCIA_DEFAULT = {
  navbarTexto:     "Jireh Mayorista",
  navbarIcono:     "🏬",
  bannerTitulo:    "Mayorista Jireh",
  bannerSubtitulo: "Catálogo Mayorista Online",
  bannerImagen:    "",
  tema:            "navy",
  gradPersonalizado: false,
  gradA: "#241536",
  gradB: "#3a2856"
};

/**
 * Aplica el tema de color al panel admin (este mismo selector pinta
 * también el catálogo web — es un solo dato compartido en Sheets).
 */
function aplicarTemaAdmin(cfg) {
  const tema = (cfg.tema || APARIENCIA_DEFAULT.tema).toLowerCase();
  document.body.setAttribute("data-tema", tema);
}

/** Muestra u oculta los dos selectores de color del gradiente propio */
function toggleGradPersonalizado() {
  const activo = document.getElementById("cfgGradPersonalizado").checked;
  document.getElementById("cfgGradWrap").style.display = activo ? "" : "none";
}

/** Loads the saved banner/tema config into the "Apariencia" form (called when Configuración opens) */
function cargarAparienciaForm(cfg) {
  document.getElementById("cfgNavbarTexto").value     = cfg.navbarTexto     ?? APARIENCIA_DEFAULT.navbarTexto;
  document.getElementById("cfgNavbarIcono").value     = cfg.navbarIcono     ?? APARIENCIA_DEFAULT.navbarIcono;
  document.getElementById("cfgBannerTitulo").value    = cfg.bannerTitulo    ?? APARIENCIA_DEFAULT.bannerTitulo;
  document.getElementById("cfgBannerSubtitulo").value = cfg.bannerSubtitulo ?? APARIENCIA_DEFAULT.bannerSubtitulo;
  document.getElementById("cfgBannerImagen").value    = cfg.bannerImagen   ?? APARIENCIA_DEFAULT.bannerImagen;
  document.getElementById("cfgTema").value            = cfg.tema           || APARIENCIA_DEFAULT.tema;

  const gradActivo = cfg.gradPersonalizado ?? APARIENCIA_DEFAULT.gradPersonalizado;
  document.getElementById("cfgGradPersonalizado").checked = !!gradActivo;
  document.getElementById("cfgGradA").value = cfg.gradA || APARIENCIA_DEFAULT.gradA;
  document.getElementById("cfgGradB").value = cfg.gradB || APARIENCIA_DEFAULT.gradB;
  document.getElementById("cfgGradWrap").style.display = gradActivo ? "" : "none";

  // Pedido mínimo
  const cfgPedidoMinimoEl = document.getElementById("cfgPedidoMinimo");
  if (cfgPedidoMinimoEl && cfg.pedidoMinimo !== undefined) cfgPedidoMinimoEl.value = cfg.pedidoMinimo;

  // Popup promocional
  const popupActivo = document.getElementById("cfgPopupActivo");
  const popupImagen = document.getElementById("cfgPopupImagen");
  if (popupActivo) popupActivo.checked = !!cfg.popupActivo;
  if (popupImagen) popupImagen.value = cfg.popupImagen || "";
  // Mostrar preview si ya hay imagen guardada
  const popupPreviewEl = document.getElementById("popupImagenPreview");
  if (popupPreviewEl && cfg.popupImagen) {
    popupPreviewEl.innerHTML = `<img src="${cfg.popupImagen}" alt="" style="width:100%;height:100%;object-fit:contain;">`;
  }
}

async function guardarPedidoMinimoForm() {
  const input = document.getElementById("cfgPedidoMinimo");
  if (!input) return;

  const valor = Number(input.value);

  if (isNaN(valor) || valor < 0) {
    toast("Ingresá un monto válido para el pedido mínimo", "error");
    return;
  }

  const btn = document.getElementById("btnGuardarPedidoMinimo");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({
      action: "guardarConfiguracionNegocio",
      pedidoMinimo: valor
    });
    const response = await fetchConReintento(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar el pedido mínimo", "error");
      return;
    }

    configNegocioCache = { ...configNegocioCache, pedidoMinimo: valor };
    toast(`Pedido mínimo actualizado a $${valor.toLocaleString("es-AR")}`, "success");

  } catch (error) {
    console.error("Error al guardar el pedido mínimo:", error);
    toast("Error de conexión al guardar el pedido mínimo", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

function previsualizarPopup() {}  // legacy — ya no se usa

/** Lista las impresoras disponibles en Electron y las carga en el selector */
async function cargarListaImpresoras() {
  const sel = document.getElementById("cfgImpresoraSelector");
  if (!sel) return;

  const bridge = window.veekpos || window.posOffline;
  if (!bridge || typeof bridge.listarImpresoras !== "function") {
    sel.innerHTML = '<option value="">Solo disponible en la app de escritorio</option>';
    return;
  }

  sel.innerHTML = '<option value="">Cargando...</option>';
  try {
    const impresoras = await bridge.listarImpresoras();
    const guardada = localStorage.getItem("veekpos_impresora") || "";
    sel.innerHTML = '<option value="">— Predeterminada del sistema —</option>';
    impresoras.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name + (p.isDefault ? " ★" : "");
      if (p.name === guardada) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!guardada) sel.value = "";

    // Si había un nombre guardado pero ya no aparece en la lista actual
    // de impresoras, es la causa más común de que la impresión "en
    // teoría configurada" siga mostrando el diálogo — el sistema ya no
    // reconoce ese nombre exacto. Avisar para que el usuario la
    // vuelva a seleccionar.
    const actual = document.getElementById("cfgImpresoraActual");
    if (actual && guardada && !impresoras.some(p => p.name === guardada)) {
      actual.innerHTML = `⚠️ La impresora guardada ("${escapeHtml(guardada)}") ya no aparece en el sistema — volvé a seleccionarla y guardar.`;
      actual.style.color = "var(--red-600, #dc2626)";
    }
  } catch (e) {
    sel.innerHTML = '<option value="">Error al listar impresoras</option>';
  }
}

function guardarImpresoraSeleccionada() {
  const sel = document.getElementById("cfgImpresoraSelector");
  const nombre = sel ? sel.value : "";
  localStorage.setItem("veekpos_impresora", nombre);
  const actual = document.getElementById("cfgImpresoraActual");
  if (actual) actual.textContent = nombre ? `Impresora guardada: ${nombre}` : "Se usará la predeterminada del sistema.";
  toast(nombre ? `Impresora "${nombre}" guardada` : "Se usará la impresora predeterminada", "success");
}

function quitarImagenPopup() {
  document.getElementById("cfgPopupImagen").value = "";
  const preview = document.getElementById("popupImagenPreview");
  if (preview) preview.innerHTML = `<span class="pm-image-placeholder">Sin imagen</span>`;
  const status = document.getElementById("popupImagenStatus");
  if (status) { status.className = "pm-image-status"; status.textContent = ""; }
}

async function onSeleccionarImagenPopup(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("popupImagenStatus");
  const previewEl = document.getElementById("popupImagenPreview");

  if (!file.type.startsWith("image/")) {
    if (statusEl) { statusEl.className = "pm-image-status error"; statusEl.textContent = "Elegí un archivo de imagen (jpg, png, webp)."; }
    event.target.value = "";
    return;
  }

  // Preview local inmediata
  const localUrl = URL.createObjectURL(file);
  if (previewEl) previewEl.innerHTML = `<img src="${localUrl}" alt="" style="width:100%;height:100%;object-fit:contain;">`;
  if (statusEl) { statusEl.className = "pm-image-status uploading"; statusEl.textContent = "⏳ Optimizando imagen..."; }

  try {
    const { base64, tipoMime } = await comprimirImagenProducto(file);
    const pesoKB = Math.round((base64.length * 0.75) / 1024);

    if (statusEl) { statusEl.className = "pm-image-status uploading"; statusEl.textContent = `⏳ Subiendo a Drive... (${pesoKB}KB)`; }

    const response = await fetchAPI(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "subirImagenProducto", imagenBase64: base64, tipoMime, codigoProducto: "POPUP_PROMO" })
    }, { timeoutMs: 40000 }); // las imágenes pesan más y tardan más en subir — no es una mutación chica
    const data = await response.json();

    if (!data.success) {
      if (statusEl) { statusEl.className = "pm-image-status error"; statusEl.textContent = "⚠️ " + (data.message || "No se pudo subir la imagen."); }
      return;
    }

    document.getElementById("cfgPopupImagen").value = data.url;
    if (statusEl) { statusEl.className = "pm-image-status success"; statusEl.textContent = `✓ Imagen subida (${pesoKB}KB)`; }

  } catch (err) {
    console.error("Error al subir imagen popup:", err);
    if (statusEl) { statusEl.className = "pm-image-status error"; statusEl.textContent = "⚠️ Error de conexión."; }
  } finally {
    URL.revokeObjectURL(localUrl);
  }
}

async function subirImagenPopup() {}  // legacy

async function guardarPopupPromoForm() {
  const activo = document.getElementById("cfgPopupActivo")?.checked ? "SI" : "NO";
  const imagen = (document.getElementById("cfgPopupImagen")?.value || "").trim();
  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", popupImagen: imagen, popupActivo: activo });
    const res = await fetchAPI(API_URL + "?" + params.toString());
    const data = await res.json();
    if (data.success) toast("Popup guardado correctamente", "success");
    else toast(data.message || "Error al guardar", "error");
  } catch (err) {
    toast("Error de conexión", "error");
  }
}

async function quitarPopupPromo() {
  quitarImagenPopup();
  document.getElementById("cfgPopupActivo").checked = false;
  await guardarPopupPromoForm();
}

/**
 * Saves both the ticket-header fields AND the banner/tema fields together,
 * since both live in the same hoja CONFIGURACION and the backend expects
 * the full set of keys in one call to guardarConfiguracionNegocio.
 * El tema afecta a este mismo panel admin Y al catálogo web a la vez.
 */
async function guardarAparienciaForm() {
  const nombre = document.getElementById("cfgNombreLocal").value.trim();

  if (!nombre) {
    toast("Completá primero el nombre del local, arriba", "error");
    return;
  }

  const cfg = {
    nombre,
    subtitulo: document.getElementById("cfgSubtitulo").value.trim(),
    direccion: document.getElementById("cfgDireccion").value.trim(),
    telefono1: document.getElementById("cfgTelefono1").value.trim(),
    telefono2: document.getElementById("cfgTelefono2").value.trim(),
    pie:       document.getElementById("cfgPie").value.trim(),

    bannerTitulo:    document.getElementById("cfgBannerTitulo").value.trim(),
    bannerSubtitulo: document.getElementById("cfgBannerSubtitulo").value.trim(),
    bannerImagen:    document.getElementById("cfgBannerImagen").value.trim(),
    tema:            document.getElementById("cfgTema").value,
    gradPersonalizado: document.getElementById("cfgGradPersonalizado").checked,
    gradA:           document.getElementById("cfgGradA").value,
    gradB:           document.getElementById("cfgGradB").value,
    navbarTexto:     document.getElementById("cfgNavbarTexto").value.trim(),
    navbarIcono:     document.getElementById("cfgNavbarIcono").value.trim()
  };

  const btn = document.getElementById("btnGuardarApariencia");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", ...cfg });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar la apariencia", "error");
      return;
    }

    configNegocioCache = { ...configNegocioCache, ...cfg };
    aplicarTemaAdmin(configNegocioCache);
    toast("Apariencia guardada — ya se ve en el panel y en el catálogo", "success");

  } catch (error) {
    console.error("Error al guardar la apariencia:", error);
    toast("Error de conexión al guardar la apariencia", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/* ===================== BENEFICIOS DEL CATÁLOGO WEB (chips bajo el banner) ===================== */

const BENEFICIOS_DEFAULT = {
  beneficioWhatsappNumero: "5491140975795",
  beneficioInstagramUrl:   "",
  beneficioTelefono1:      "",
  beneficioTelefono2:      "",
  beneficioDireccion:      "",
  beneficioTextoLibre1:    "",
  beneficioTextoLibre2:    ""
};

/** Loads the saved "Beneficios" config into the form (called when Configuración opens) */
function cargarBeneficiosForm(cfg) {
  document.getElementById("cfgBeneficioWhatsapp").value  = cfg.beneficioWhatsappNumero ?? BENEFICIOS_DEFAULT.beneficioWhatsappNumero;
  document.getElementById("cfgBeneficioInstagram").value = cfg.beneficioInstagramUrl   ?? BENEFICIOS_DEFAULT.beneficioInstagramUrl;
  document.getElementById("cfgBeneficioTelefono1").value = cfg.beneficioTelefono1      ?? BENEFICIOS_DEFAULT.beneficioTelefono1;
  document.getElementById("cfgBeneficioTelefono2").value = cfg.beneficioTelefono2      ?? BENEFICIOS_DEFAULT.beneficioTelefono2;
  document.getElementById("cfgBeneficioDireccion").value = cfg.beneficioDireccion      ?? BENEFICIOS_DEFAULT.beneficioDireccion;
  document.getElementById("cfgBeneficioTexto1").value    = cfg.beneficioTextoLibre1    ?? BENEFICIOS_DEFAULT.beneficioTextoLibre1;
  document.getElementById("cfgBeneficioTexto2").value    = cfg.beneficioTextoLibre2    ?? BENEFICIOS_DEFAULT.beneficioTextoLibre2;
}

/** Reads the "Beneficios" form fields and saves them to the backend (hoja CONFIGURACION) */
async function guardarBeneficiosForm() {
  const nombre = document.getElementById("cfgNombreLocal").value.trim();

  if (!nombre) {
    toast("Completá primero el nombre del local, arriba", "error");
    return;
  }

  const whatsapp = document.getElementById("cfgBeneficioWhatsapp").value.trim();

  const cfg = {
    nombre,

    beneficioWhatsappNumero: whatsapp || BENEFICIOS_DEFAULT.beneficioWhatsappNumero,
    beneficioInstagramUrl:   document.getElementById("cfgBeneficioInstagram").value.trim(),
    beneficioTelefono1:      document.getElementById("cfgBeneficioTelefono1").value.trim(),
    beneficioTelefono2:      document.getElementById("cfgBeneficioTelefono2").value.trim(),
    beneficioDireccion:      document.getElementById("cfgBeneficioDireccion").value.trim(),
    beneficioTextoLibre1:    document.getElementById("cfgBeneficioTexto1").value.trim(),
    beneficioTextoLibre2:    document.getElementById("cfgBeneficioTexto2").value.trim()
  };

  const btn = document.getElementById("btnGuardarBeneficios");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", ...cfg });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudieron guardar los beneficios", "error");
      return;
    }

    configNegocioCache = { ...configNegocioCache, ...cfg };
    toast("Beneficios guardados — ya se ven en el catálogo", "success");

  } catch (error) {
    console.error("Error al guardar los beneficios:", error);
    toast("Error de conexión al guardar los beneficios", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/** Saves the rotating top-banner messages — one per line in the textarea, joined with newlines for the backend */
async function guardarBannerTopForm() {
  const bannerTopMensajes = document.getElementById("cfgBannerTopMensajes").value.trim();

  const btn = document.getElementById("btnGuardarBannerTop");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", nombre: configNegocioCache.nombre, bannerTopMensajes });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar el banner", "error");
      return;
    }

    configNegocioCache.bannerTopMensajes = bannerTopMensajes;
    toast("Banner superior guardado — ya se ve en el catálogo", "success");

  } catch (error) {
    console.error("Error al guardar el banner superior:", error);
    toast("Error de conexión al guardar el banner", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/** Saves the list of blocked shipping carriers — one per line, same pattern as the top-banner messages */
async function guardarTransportesNoDisponiblesForm() {
  const transportesNoDisponibles = document.getElementById("cfgTransportesNoDisponibles").value.trim();

  const btn = document.getElementById("btnGuardarTransportesNoDisponibles");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({ action: "guardarConfiguracionNegocio", nombre: configNegocioCache.nombre, transportesNoDisponibles });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudieron guardar los transportes", "error");
      return;
    }

    configNegocioCache.transportesNoDisponibles = transportesNoDisponibles;
    toast("Transportes bloqueados guardados — ya rige en el catálogo", "success");

  } catch (error) {
    console.error("Error al guardar los transportes no disponibles:", error);
    toast("Error de conexión al guardar los transportes", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/* ===================== TOASTS ===================== */

function toast(mensaje, tipo) {
  const stack = document.getElementById("toastStack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "toast-msg" + (tipo ? " " + tipo : "");
  const icon = tipo === "error" ? "⚠️" : tipo === "success" ? "✓" : "ℹ️";
  el.innerHTML = `<span>${icon}</span><span>${escapeHtml(mensaje)}</span>`;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.transition = "opacity .25s";
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 250);
  }, 2600);
}

/* ===================== METRICAS ===================== */

async function fetchConReintento(url, opciones, intentos) {
  intentos = intentos || 3;
  let ultimoError = null;

  for (let intento = 1; intento <= intentos; intento++) {
    try {
      const response = await fetch(url, opciones);
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response;
    } catch (error) {
      ultimoError = error;
      if (intento < intentos) {
        // Espera creciente: 600ms, 1200ms, 1800ms... da tiempo a que
        // se libere la ejecución concurrente de las otras cajas.
        await new Promise(r => setTimeout(r, 600 * intento));
      }
    }
  }
  throw ultimoError;
}

async function cargarMetricas() {
  const CACHE_KEY = "vpos_cache_metricas";
  const CACHE_TTL = 2 * 60 * 1000; // 2 minutos

  function aplicarMetricas(data) {
    actualizarElemento("pedidosNuevos",   data.pedidosNuevos  || 0);
    actualizarElemento("totalPedidos",    data.totalPedidos   || 0);
    actualizarElemento("productosActivos", data.productosActivos || 0);
    actualizarElemento("stockBajo",       data.stockBajo || 0);
    actualizarElemento("agotados",        data.agotados  || 0);
    actualizarElemento("clientesUnicos",  data.clientesUnicos || 0);
    if (data.masVendidoCantidad > 0) {
      actualizarElemento("cantidadMasVendidos", data.masVendidoCantidad + " uds · " + (data.masVendidoNombre || ""));
    } else {
      actualizarElemento("cantidadMasVendidos", "Ver ranking →");
    }
    const ventasHoyTotal = Number(data.ventasHoy || 0);
    const ventasMesTotal = Number(data.ventasMes || 0);
    actualizarElemento("ventasHoy",     "$" + ventasHoyTotal.toLocaleString("es-AR"));
    actualizarElemento("ventasMes",     "$" + ventasMesTotal.toLocaleString("es-AR"));
    actualizarElemento("ventasTotales", "$" + ventasMesTotal.toLocaleString("es-AR"));
    const tp = "$" + Math.round(data.ticketPromedio || 0).toLocaleString("es-AR");
    actualizarElemento("ticketPromedio", tp);
    const posHoy = Number(data.ventasPOSHoy || 0);
    const posMes = Number(data.ventasPOSMes || 0);
    actualizarElemento("ventasPOSHoy", "$" + posHoy.toLocaleString("es-AR"));
    actualizarElemento("ventasPOSMes", "$" + posMes.toLocaleString("es-AR"));
    const pedHoy = Number(data.ventasPedidosHoy || 0);
    const pedMes = Number(data.ventasPedidosMes || 0);
    actualizarElemento("ventasPedidosHoy", "$" + pedHoy.toLocaleString("es-AR"));
    actualizarElemento("ventasPedidosMes", "$" + pedMes.toLocaleString("es-AR"));
    actualizarElemento("posVentasHoyBanner",  "$" + posHoy.toLocaleString("es-AR"));
    actualizarElemento("posVentasMesBanner",  "$" + posMes.toLocaleString("es-AR"));
    actualizarElemento("posTicketPromBanner", tp);
    actualizarElemento("posTotalPedBanner",   data.totalVentasPOS || 0);
  }

  // Mostrar caché inmediatamente si existe
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const { ts, data } = JSON.parse(raw);
      aplicarMetricas(data);
      marcarActualizacionEnVivo();
      if (Date.now() - ts < CACHE_TTL) return; // fresco — no recargar
    }
  } catch(e) {}

  // Actualizar en background
  try {
    const response = await fetchAPI(API_URL + "?action=metricas");
    const data = await response.json();
    aplicarMetricas(data);
    marcarActualizacionEnVivo();
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch(e) {}
  } catch (error) {
    console.error("Error métricas:", error);
    marcarActualizacionEnVivo(true);
  }
}

/** Updates the "live" badge on the dashboard so users can see the data is fresh */
function marcarActualizacionEnVivo(fallo) {
  const badge = document.getElementById("posLiveBadge");
  if (!badge) return;
  const hora = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (fallo) {
    badge.classList.add("ps-badge-error");
    badge.innerHTML = `⚠️ Sin conexión`;
    return;
  }
  badge.classList.remove("ps-badge-error");
  badge.innerHTML = `📊 En vivo · ${hora}`;
  badge.classList.remove("pulse");
  void badge.offsetWidth;
  badge.classList.add("pulse");
}

/* ===================== POS VENTAS RECIENTES (dashboard) ===================== */

async function cargarVentasPOS() {
  try {
    const response = await fetchAPI(API_URL + "?action=ventasPOS");
    const data = await response.json();
    ventasPOSGlobal = data.ventas || [];
    renderVentasPOSRecientes(ventasPOSGlobal);
  } catch (error) {
    // Action may not exist yet on Apps Script — silently ignore
    console.warn("ventasPOS action not available:", error);
    renderVentasPOSRecientes([]);
  }
}

function renderVentasPOSRecientes(lista) {
  const tbody = document.getElementById("tablaPOSRecientes");
  if (!tbody) return;

  if (!lista || lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">No hay ventas del día aún</td></tr>`;
    return;
  }

  let html = "";
  lista.slice(0, 20).forEach(v => {
    const hora = v.FECHA ? new Date(v.FECHA).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "—";
    const items = v.ITEMS || v.DETALLE || "—";
    const pago  = v.FORMA_PAGO || v.PAGO || "—";
    const total = Number(v.TOTAL || 0).toLocaleString("es-AR");

    html += `
      <tr>
        <td class="mono">${escapeHtml(String(v.VENTA_ID || v.ID || "—"))}</td>
        <td>${hora}</td>
        <td>${escapeHtml(String(items))}</td>
        <td>${escapeHtml(String(pago))}</td>
        <td class="money">$${total}</td>
        <td>
          <button class="btn btn-sm btn-outline-secondary"
            onclick='imprimirVentaDesdeData(${JSON.stringify(v)})'>🖨️</button>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

/* ===================== VENTAS POS — HISTORIAL (sección dedicada) ===================== */

let ventasPOSHistorialGlobal = [];

/** Loads POS sales history for the date range selected in the filter inputs (defaults to last 60 days) */
async function cargarVentasPOSHistorial() {
  const tbody = document.getElementById("tablaVentasPOSHistorial");
  if (!tbody) return;

  const desdeInput = document.getElementById("vpDesde");
  const hastaInput = document.getElementById("vpHasta");

  if (desdeInput && !desdeInput.value) {
    const hace30 = new Date();
    hace30.setDate(hace30.getDate() - 30);
    desdeInput.value = hace30.toISOString().slice(0, 10);
  }
  if (hastaInput && !hastaInput.value) {
    hastaInput.value = new Date().toISOString().slice(0, 10);
  }

  const cacheKey = "ventasPOS_" + (desdeInput?.value || "") + "_" + (hastaInput?.value || "");
  const cached = cacheGet("ventasPOS");
  if (cached && cached.data?.key === cacheKey) {
    ventasPOSHistorialGlobal = cached.data.ventas;
    filtrarVentasPOSHistorial(); // respeta el filtro de forma de pago/estado/búsqueda activo, en vez de mostrar siempre todo
    if (!cached.stale) return;
  } else {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-3">Cargando ventas...</td></tr>`;
  }

  try {
    const params = new URLSearchParams({ action: "ventasPOSHistorial" });
    if (desdeInput && desdeInput.value) params.set("desde", desdeInput.value);
    if (hastaInput && hastaInput.value) params.set("hasta", hastaInput.value);

    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    ventasPOSHistorialGlobal = data.ventas || [];
    cacheSet("ventasPOS", { key: cacheKey, ventas: ventasPOSHistorialGlobal });
    filtrarVentasPOSHistorial(); // idem — no pisar el filtro activo con la lista completa

  } catch (error) {
    console.error("Error al cargar historial de ventas POS:", error);
    if (!cached) tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-3">Error al cargar el historial</td></tr>`;
  }
}

function renderVentasPOSHistorial(lista) {
  const tbody = document.getElementById("tablaVentasPOSHistorial");
  if (!tbody) return;

  if (!lista || lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-3">No hay ventas en el rango seleccionado</td></tr>`;
    return;
  }

  const CHUNK = 60;
  let idx = 0;
  tbody.innerHTML = "";

  const renderChunk = () => {
    const frag = document.createDocumentFragment();
    const fin = Math.min(idx + CHUNK, lista.length);
    for (; idx < fin; idx++) {
      const v = lista[idx];
      const fechaObj = v.FECHA ? new Date(v.FECHA) : null;
      const fecha = fechaObj ? fechaObj.toLocaleDateString("es-AR") : "—";
      const hora  = fechaObj ? fechaObj.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) : "—";
      const items = v.ITEMS || v.DETALLE || "—";
      const pago  = v.FORMA_PAGO || v.PAGO || "—";
      const total = Number(v.TOTAL || 0).toLocaleString("es-AR");
      const anulada = String(v.ANULADA || "").toUpperCase() === "SI";
      const motivo  = v.MOTIVO_ANULACION || "";
      const _vid = String(v.VENTA_ID || v.ID || "");
      _ventasMapPOS[_vid] = v;
      const tr = document.createElement("tr");
      if (anulada) tr.style.cssText = "background:#fff0f0;color:#b91c1c;";
      const badgeAnulada = anulada
        ? `<span class="badge bg-danger ms-1" style="font-size:10px;text-decoration:none;">ANULADA${motivo ? " · " + escapeHtml(motivo) : ""}</span>`
        : "";
      tr.innerHTML = `
        <td class="mono" style="${anulada ? 'text-decoration:line-through;' : ''}">${escapeHtml(String(v.VENTA_ID || v.ID || "—"))}${badgeAnulada}</td>
        <td>${fecha}</td><td>${hora}</td>
        <td>${escapeHtml(String(items))}</td>
        <td>${escapeHtml(String(pago))}</td>
        <td class="money" style="${anulada ? 'text-decoration:line-through;' : ''}">$${total}</td>
        <td>
          <button class="btn btn-sm btn-outline-secondary"
            onclick='imprimirVentaDesdeData(_ventasMapPOS[${JSON.stringify(_vid)}])' title="Reimprimir">🖨️ Reimprimir</button>
          <button class="btn btn-sm btn-outline-danger ms-1"
            onclick='eliminarVentaPOS(_ventasMapPOS[${JSON.stringify(_vid)}])'
            ${anulada ? 'disabled title="Ya anulada"' : 'title="Anular"'}>🗑️ Anular</button>
        </td>`;
      frag.appendChild(tr);
    }
    tbody.appendChild(frag);
    if (idx < lista.length) requestAnimationFrame(renderChunk);
  };
  requestAnimationFrame(renderChunk);
}

/**
 * Deletes a sale (and returns its stock) after confirmation. Receives
 * the full sale object (as rendered in the table) so the backend gets
 * the cart directly, without needing to re-read DETALLE_VENTAS.
 */
/** Muestra un modal para ingresar el motivo de anulación */
function eliminarVentaPOS(venta) {
  const ventaId = venta.VENTA_ID || venta.ID;

  // Si ya está anulada, no hacer nada
  if (String(venta.ANULADA || "").toUpperCase() === "SI") {
    toast("Esta venta ya está anulada", "error");
    return;
  }

  // Guardar la venta en variable global para usarla al confirmar
  window._ventaParaAnular = venta;

  // Limpiar y mostrar modal
  document.getElementById("motivoAnulacionInput").value = "";
  document.getElementById("motivoAnulacionVentaId").textContent = ventaId;
  document.getElementById("btnConfirmarAnulacion").disabled = false;
  document.getElementById("btnConfirmarAnulacion").textContent = "Anular venta";
  document.getElementById("modalAnulacionBackdrop").classList.add("show");
  setTimeout(() => document.getElementById("motivoAnulacionInput").focus(), 100);
}

function cerrarModalAnulacion() {
  document.getElementById("modalAnulacionBackdrop").classList.remove("show");
  window._ventaParaAnular = null;
}

async function confirmarAnulacionVenta() {
  const venta = window._ventaParaAnular;
  if (!venta) return;

  const motivoInput = document.getElementById("motivoAnulacionInput");
  const motivoError = document.getElementById("motivoAnulacionError");
  const motivo = motivoInput.value.trim();
  if (!motivo) {
    motivoInput.style.borderColor = "var(--red-500)";
    if (motivoError) motivoError.style.display = "block";
    motivoInput.focus();
    return;
  }
  motivoInput.style.borderColor = "";
  if (motivoError) motivoError.style.display = "none";

  const btn = document.getElementById("btnConfirmarAnulacion");
  btn.disabled = true;
  btn.textContent = "Anulando...";

  try {
    const params = new URLSearchParams({
      action: "eliminarVenta",
      ventaId: venta.VENTA_ID || venta.ID,
      carrito: venta.CARRITO || "[]",
      motivo: motivo
    });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo anular la venta", "error");
      btn.disabled = false;
      btn.textContent = "Anular venta";
      return;
    }

    toast("Venta anulada — sigue en el historial pero ya no cuenta en caja", "success");
    cerrarModalAnulacion();
    cargarVentasPOSHistorial();
    productosPOS = [];

  } catch (error) {
    console.error("Error al anular venta:", error);
    toast("Error de conexión al anular la venta", "error");
    btn.disabled = false;
    btn.textContent = "Anular venta";
  }
}

/** Client-side filter by sale id or payment method, over the already-loaded historial */
function filtrarVentasPOSHistorial() {
  const termino   = (document.getElementById("vpBuscar")?.value || "").toLowerCase().trim();
  const formaPago = (document.getElementById("vpFormaPago")?.value || "").toUpperCase();
  const estado    = (document.getElementById("vpEstado")?.value || "");

  const filtradas = ventasPOSHistorialGlobal.filter(v => {
    const id     = String(v.VENTA_ID || v.ID || "").toLowerCase();
    const items  = String(v.ITEMS || v.DETALLE || "").toLowerCase();
    const pago   = String(v.FORMA_PAGO || v.PAGO || "").toUpperCase().trim();
    const anulada = String(v.ANULADA || "").toUpperCase() === "SI";

    if (termino && !id.includes(termino) && !items.includes(termino)) return false;
    if (formaPago && pago !== formaPago) return false;
    if (estado === "activas"  &&  anulada) return false;
    if (estado === "anuladas" && !anulada) return false;
    return true;
  });

  renderVentasPOSHistorial(filtradas);
}

/* ===================== NAVEGACION ===================== */

// Recuerda cuándo se cargó cada sección por última vez, para no volver a
// pedirle al backend lo mismo si el cajero entra y sale de una sección
// en pocos segundos (ej: mirar Pedidos, volver al POS, volver a Pedidos).
// El timer de 15s de arriba sigue refrescando la sección activa con
// normalidad; esto solo evita pedidos duplicados al navegar.
const ULTIMA_CARGA_SECCION = {};
const VENCIMIENTO_CACHE_MS = 3 * 60 * 1000; // 3 minutos

function cargarSiVencido(clave, fn) {
  const ahora = Date.now();
  const ultima = ULTIMA_CARGA_SECCION[clave] || 0;
  if (ahora - ultima < VENCIMIENTO_CACHE_MS) return; // todavía fresco, no repetir
  ULTIMA_CARGA_SECCION[clave] = ahora;
  fn();
}

function mostrarSeccion(id) {
  document.querySelectorAll(".seccion").forEach(sec => { sec.style.display = "none"; });

  const seccion = document.getElementById(id);
  if (seccion) seccion.style.display = "block";

  // Sync sidebar links
  document.querySelectorAll("#navLinks a").forEach(a => {
    a.classList.toggle("active", a.getAttribute("data-target") === id);
  });

  // Sync bottom nav links
  document.querySelectorAll("#bottomNavLinks a").forEach(a => {
    a.classList.toggle("active", a.getAttribute("data-target") === id);
  });

  if (id === "pedidos")   cargarSiVencido("pedidos", cargarPedidos);
  if (id === "productos") cargarSiVencido("productos", cargarProductos);
  if (id === "ventasPOS") cargarSiVencido("ventasPOS", cargarVentasPOSHistorial);
  if (id === "configuracion") {
    cargarConfigNegocioForm();
    actualizarEstadoUSBPrint();
    // En Electron: mostrar tarjetas específicas de escritorio
    if (typeof window.veekpos !== "undefined" || typeof window.posOffline !== "undefined") {
      const bridge = window.veekpos || window.posOffline;
      // Tarjeta impresora
      const tImpresora = document.getElementById("cardImpresoraPOS");
      if (tImpresora) {
        tImpresora.style.display = "block";
        if (typeof cargarListaImpresoras === "function") cargarListaImpresoras();
        const guardada = localStorage.getItem("veekpos_impresora") || "";
        const actual = document.getElementById("cfgImpresoraActual");
        if (actual) actual.textContent = guardada
          ? `Impresora guardada: ${guardada}`
          : "Sin impresora guardada — se usará la predeterminada del sistema.";
      }
      // Tarjeta conexión API
      const tConexion = document.getElementById("cardConexionNegocio");
      if (tConexion) {
        tConexion.style.display = "block";
        // bridge.obtenerApiUrl?.() por sí solo solo protege el LLAMADO
        // a la función — si no existe, da undefined, y encadenar
        // .then()/.catch() sin su propio "?." revienta con un error
        // real (Cannot read properties of undefined). Como esta
        // función no está expuesta todavía desde preload.js, esto
        // cortaba la ejecución acá y las tarjetas de Mercado Pago y
        // licencia que venían DESPUÉS en este mismo bloque nunca
        // llegaban a mostrarse.
        const promesaUrl = bridge.obtenerApiUrl?.();
        if (promesaUrl && typeof promesaUrl.then === "function") {
          promesaUrl.then(url => {
            const el = document.getElementById("conexionNegocioUrlActual");
            if (el) el.textContent = url ? "Conectada a: " + url : "No hay URL configurada.";
            const input = document.getElementById("conexionNegocioUrl");
            if (input && url) input.value = url;
          }).catch(() => {});
        }
      }
      // Tarjeta licencia
      if (typeof mostrarEstadoLicenciaEnConfig === "function") mostrarEstadoLicenciaEnConfig();
      // Tarjeta multicaja — OCULTA a propósito: el guardado de esta
      // config (actualizarVisibilidadCampoNombreCaja / guardarConfigRed)
      // nunca se terminó de implementar, y la función de red local en
      // sí (el servidor HTTP que compartiría stock/ventas entre varias
      // cajas) tampoco está construida del lado de Electron. Mostrar
      // este formulario llevaba a un error real al tocarlo — mejor no
      // ofrecer una función que en los hechos no hace nada.
      // const tRed = document.getElementById("cardMultiCajaRed");
      // if (tRed) tRed.style.display = "block";
      // Tarjeta MercadoPago
      const tMp = document.getElementById("cardMercadoPago");
      if (tMp) {
        tMp.style.display = "block";
        if (typeof mostrarEstadoMercadoPagoEnConfig === "function") mostrarEstadoMercadoPagoEnConfig();
      }
    }
  }

  if (id === "pos") {
    asegurarProductosPOS().then(renderPosGrid);
    setTimeout(() => {
      const input = document.getElementById("posBusqueda");
      if (input) input.focus();
    }, 80);
  }

  if (id === "cierreCaja") {
    const selector = document.getElementById("ccFechaSelector");
    if (selector && !selector.value) {
      const ayer = new Date();
      ayer.setDate(ayer.getDate() - 1);
      selector.value = ayer.toISOString().slice(0, 10);
    }
    cargarResumenCierreCaja(selector ? selector.value : null);
  }
  if (id === "movimientosCaja") cargarMovimientosCajaHoy();
  if (id === "reportes")   cargarSiVencido("reportes", cargarTodosLosReportes);
}

/* ===================== PEDIDOS ===================== */

/* =========================================================
   CACHÉ LOCALSTORAGE GENÉRICO — stale-while-revalidate
   Muestra datos cacheados al instante mientras actualiza
   en segundo plano. TTL configurable por sección.
========================================================= */
const CACHE_TTL_SECCIONES = {
  pedidos:   5 * 60 * 1000,  // 5 min
  clientes:  5 * 60 * 1000,  // 5 min
  ventasPOS: 3 * 60 * 1000,  // 3 min
};

function invalidarCache(...claves) {
  claves.forEach(c => {
    try { localStorage.removeItem("vpos_cache_" + c); } catch(e) {}
    delete ULTIMA_CARGA_SECCION[c];
  });
}

/* =====================================================
   COLA DE VENTAS PENDIENTES (sin conexión)
   Si guardarVenta falla por un corte de conexión, la venta ya se le
   mostró y (si el cajero eligió imprimir) ya se imprimió al cliente
   — no hay vuelta atrás con eso. Lo único que puede fallar es que la
   fila todavía no llegó a VENTAS_LOCAL. Esta cola guarda esa venta en
   el navegador (localStorage) y la reintenta sola en cuanto vuelve la
   conexión, usando el mismo clienteVentaId — que el backend reconoce
   para no duplicarla aunque el primer intento sí hubiera llegado a
   guardarse y solo se haya perdido la respuesta.
===================================================== */

const CLAVE_COLA_VENTAS = "vpos_cola_ventas_pendientes";

function _leerColaVentasPendientes() {
  try { return JSON.parse(localStorage.getItem(CLAVE_COLA_VENTAS) || "[]"); }
  catch(e) { return []; }
}

function _guardarColaVentasPendientes(cola) {
  try { localStorage.setItem(CLAVE_COLA_VENTAS, JSON.stringify(cola)); } catch(e) {}
  actualizarBadgeVentasPendientes(cola.length);
}

function encolarVentaPendiente(venta) {
  const cola = _leerColaVentasPendientes();
  cola.push(venta);
  _guardarColaVentasPendientes(cola);
}

/** Muestra/oculta un aviso discreto de cuántas ventas todavía no se subieron al servidor */
function actualizarBadgeVentasPendientes(cantidad) {
  let badge = document.getElementById("badgeVentasPendientes");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "badgeVentasPendientes";
    badge.style.cssText = "position:fixed;bottom:14px;right:14px;z-index:9999;background:var(--amber-500,#f59e0b);color:#fff;padding:8px 14px;border-radius:20px;font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.25);cursor:pointer;display:none;";
    badge.onclick = () => sincronizarVentasPendientes(true);
    document.body.appendChild(badge);
  }
  if (cantidad > 0) {
    badge.textContent = `📴 ${cantidad} venta${cantidad === 1 ? "" : "s"} sin sincronizar — tocar para reintentar`;
    badge.style.display = "block";
  } else {
    badge.style.display = "none";
  }
}

let _sincronizandoVentasPendientes = false;

/** Reintenta subir cada venta encolada, en orden, una por vez (no en paralelo — si el servidor está lento, mandar 10 a la vez lo empeora).
 *  manual=true cuando lo dispara el usuario (tocando el aviso) — ahí sí se avisa si sigue sin poder subir nada; en los reintentos
 *  automáticos de fondo (cada 30s, o al reconectar) no, para no repetir el mismo error cada rato mientras dure el corte. */
async function sincronizarVentasPendientes(manual) {
  if (_sincronizandoVentasPendientes) return;
  const cola = _leerColaVentasPendientes();
  if (cola.length === 0) return;

  _sincronizandoVentasPendientes = true;
  const pendientes = [];

  for (const venta of cola) {
    try {
      const response = await fetchAPI(
        API_URL,
        {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify({
            action: "guardarVenta",
            total: venta.total,
            formaPago: venta.formaPago,
            observaciones: venta.observaciones || "",
            carrito: venta.carrito,
            clienteVentaId: venta.clienteVentaId
          })
        },
        { timeoutMs: 15000 }
      );
      const data = await response.json();
      if (!data.success) pendientes.push(venta); // el servidor respondió pero rechazó la venta — se mantiene en cola para revisar
    } catch (error) {
      pendientes.push(venta); // seguía sin conexión — se mantiene en cola, se reintenta en el próximo ciclo
    }
  }

  _guardarColaVentasPendientes(pendientes);
  _sincronizandoVentasPendientes = false;

  const subieron = cola.length - pendientes.length;
  if (subieron > 0) {
    toast(`✅ ${subieron} venta${subieron === 1 ? "" : "s"} pendiente${subieron === 1 ? "" : "s"} sincronizada${subieron === 1 ? "" : "s"}`, "success");
    invalidarCache("ventasPOS");
    cargarMetricas();
  } else if (pendientes.length > 0 && manual) {
    // Sigue habiendo ventas sin subir — antes esto no avisaba nada,
    // así que tocar el botón "no hacía nada" visible aunque en
    // realidad sí lo había intentado y seguía fallando. Esto solo se
    // avisa cuando el usuario lo pidió a propósito (no en cada
    // reintento automático de fondo, para no repetir el mismo error
    // cada 30s mientras dure el corte).
    toast(`Todavía sin conexión — ${pendientes.length} venta${pendientes.length === 1 ? "" : "s"} pendiente${pendientes.length === 1 ? "" : "s"} de subir`, "error");
  }
}

// Reintentar apenas el navegador detecta que volvió la conexión, y
// además cada 30s como red de respaldo (el evento "online" del
// navegador no siempre es 100% confiable para saber si hay internet
// real, solo que hay una interfaz de red activa).
window.addEventListener("online", sincronizarVentasPendientes);
setInterval(sincronizarVentasPendientes, 30000);

function cacheGet(clave) {
  try {
    const raw = localStorage.getItem("vpos_cache_" + clave);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    return { data, stale: Date.now() - ts > (CACHE_TTL_SECCIONES[clave] || 5 * 60 * 1000) };
  } catch(e) { return null; }
}

function cacheSet(clave, data) {
  try {
    localStorage.setItem("vpos_cache_" + clave, JSON.stringify({ ts: Date.now(), data }));
  } catch(e) {}
}

async function cargarPedidos() {
  // Mostrar caché al instante si existe
  const cached = cacheGet("pedidos");
  if (cached) {
    pedidosGlobal = cached.data;
    filtrarPedidos();
    if (!cached.stale) return; // fresco, no hace falta recargar
  }
  try {
    const response = await fetchAPI(API_URL + "?action=pedidos");
    const data = await response.json();
    if (!data.pedidos) return;

    // Si no cambió nada respecto de lo que ya se está mostrando, no
    // hace falta destruir y reconstruir toda la lista — eso es lo que
    // hacía "saltar" la pantalla al principio cada vez que el polling
    // de 15s se disparaba, aunque no hubiera pedidos nuevos.
    const firma = p => p.PEDIDO_ID + "|" + p.ESTADO + "|" + p.COBRADO + "|" + p.FORMA_PAGO_COBRO + "|" + p.TOTAL;
    const cambio = !pedidosGlobal
      || pedidosGlobal.length !== data.pedidos.length
      || pedidosGlobal.some((p, i) => firma(p) !== firma(data.pedidos[i]));

    pedidosGlobal = data.pedidos;
    cacheSet("pedidos", pedidosGlobal);
    _avisoPedidosCaido = false; // se pudo actualizar bien — resetea el aviso para el próximo corte
    if (cambio) filtrarPedidos();
  } catch (error) {
    console.error("Error pedidos:", error);
    // Solo se avisa la primera vez que falla, no en cada intento del
    // polling de 15s — si la conexión está mal por un rato, un toast
    // nuevo cada 15s sería más molesto que informativo.
    if (!_avisoPedidosCaido) {
      toast("No se pudieron actualizar los pedidos — revisá tu conexión", "error");
      _avisoPedidosCaido = true;
    }
  }
}

/** Fuerza recarga de pedidos borrando el caché primero */
function recargarPedidos() {
  invalidarCache("pedidos");
  delete ULTIMA_CARGA_SECCION["pedidos"];
  cargarPedidos();
}

function recargarVentasPOSHistorial() {
  invalidarCache("ventasPOS");
  delete ULTIMA_CARGA_SECCION["ventasPOS"];
  cargarVentasPOSHistorial();
}

async function cambiarEstado(pedidoId, estado) {
  try {
    const response = await fetch(
      API_URL +
      "?action=actualizarEstado" +
      "&pedidoId=" + encodeURIComponent(pedidoId) +
      "&estado="   + encodeURIComponent(estado)
    );
    const data = await response.json();
    if (!data.success) { toast("No se pudo actualizar el pedido", "error"); return; }
    // Actualizar en memoria sin recargar todo
    const p = pedidosGlobal.find(x => x.PEDIDO_ID === pedidoId);
    if (p) { p.ESTADO = estado; invalidarCache("pedidos"); filtrarPedidos(); }
    toast("Estado actualizado", "success");
  } catch (error) {
    console.error(error);
    toast("Error de conexión", "error");
  }
}

/**
 * Maneja el checkbox "Cobrado" de un pedido. Solo dispara la llamada
 * al backend cuando YA hay una forma de pago elegida — si todavía no
 * se eligió, simplemente habilita el desplegable y espera a que el
 * usuario la complete (eso lo dispara cambiarFormaPagoPedido). Esto
 * evita mandar "cobrado=SI" sin forma de pago, que el backend
 * rechazaría de todas formas.
 */
async function cambiarCobradoPedido(pedidoId, marcado) {
  const selectFormaPago = document.getElementById(`formaPago-${pedidoId}`);

  if (!marcado) {
    selectFormaPago.disabled = true;
    selectFormaPago.value = "";
    await aplicarCobroPedido(pedidoId, false, "");
    return;
  }

  selectFormaPago.disabled = false;

  const formaPagoElegida = selectFormaPago.value;
  if (!formaPagoElegida) {
    toast("Elegí la forma de pago para terminar de marcarlo como cobrado", "error");
    return; // se queda tildado y con el desplegable habilitado, esperando la forma de pago
  }

  await aplicarCobroPedido(pedidoId, true, formaPagoElegida);
}

/** Maneja el desplegable de forma de pago — si el checkbox ya está tildado, aplica el cambio al elegir */
async function cambiarFormaPagoPedido(pedidoId, formaPago) {
  const checkbox = document.getElementById(`cobrado-${pedidoId}`);
  if (!checkbox.checked) return; // todavía no se tildó "Cobrado", no hace nada hasta que se tilde
  if (!formaPago) return;
  await aplicarCobroPedido(pedidoId, true, formaPago);
}

/** Llama al backend para marcar/desmarcar el pedido como cobrado en caja, y refresca la lista */
const _pedidosEnProceso = new Set(); // evita doble cobro del mismo pedido

async function aplicarCobroPedido(pedidoId, cobrado, formaPago) {
  if (_pedidosEnProceso.has(pedidoId)) return; // ya procesando
  _pedidosEnProceso.add(pedidoId);

  // Deshabilitar los botones de ese pedido visualmente
  document.querySelectorAll(`.pedido-pago-btns[data-pedido="${pedidoId}"] button`)
    .forEach(b => b.disabled = true);

  try {
    const response = await fetch(
      API_URL +
      "?action=marcarPedidoCobrado" +
      "&pedidoId=" + encodeURIComponent(pedidoId) +
      "&cobrado=" + (cobrado ? "SI" : "NO") +
      "&formaPago=" + encodeURIComponent(formaPago || "")
    );
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo actualizar el cobro del pedido", "error");
      return;
    }

    // Actualizar en memoria para respuesta inmediata
    const p = pedidosGlobal.find(x => x.PEDIDO_ID === pedidoId);
    if (p) {
      p.COBRADO = cobrado ? "SI" : "NO";
      p.FORMA_PAGO_COBRO = formaPago || "";
      invalidarCache("pedidos");
      filtrarPedidos();
    }

    toast(cobrado
      ? `Pedido cobrado con ${formaPago} — ya suma al cierre de caja`
      : "Pedido desmarcado — ya no suma al cierre de caja", "success");

  } catch (error) {
    console.error("Error al marcar el pedido como cobrado:", error);
    toast("Error de conexión al actualizar el pedido", "error");
  } finally {
    _pedidosEnProceso.delete(pedidoId);
  }
}

function filtrarPedidos() {
  const texto = document.getElementById("buscarPedido").value.toLowerCase();
  const estadoFiltro = (document.getElementById("filtroPedidoEstado")?.value || "").toUpperCase();
  const filtrados = pedidosGlobal.filter(p => {
    const coincideTexto =
      String(p.PEDIDO_ID || "").toLowerCase().includes(texto) ||
      String(p.CLIENTE   || "").toLowerCase().includes(texto) ||
      String(p.DNI       || "").toLowerCase().includes(texto);
    const coincideEstado = !estadoFiltro || String(p.ESTADO || "").toUpperCase() === estadoFiltro;
    return coincideTexto && coincideEstado;
  });
  renderPedidos(filtrados);
}

const ESTADO_ICONO_PEDIDO = { NUEVO: "🆕", PREPARANDO: "⚙️", ENVIADO: "📦", CANCELADO: "❌" };

let pedidoDetalleActual = null;

async function abrirDetallePedido(pedidoId) {
  document.getElementById("pedidoDetalleBody").innerHTML = `<div class="text-center text-muted py-4">Cargando...</div>`;
  document.getElementById("pedidoDetalleModalBackdrop").classList.add("show");

  try {
    const response = await fetchAPI(API_URL + "?action=getDetallePedido&pedidoId=" + encodeURIComponent(pedidoId));
    const data = await response.json();
    if (!data.success) { toast(data.message || "No se pudo cargar el pedido", "error"); cerrarModalDetallePedido(); return; }

    const { pedido, detalle } = data;
    pedidoDetalleActual = { pedido, detalle };

    // Botón imprimir: si hay PDF en Drive lo abre, si no genera el A4
    const btnImprimir = document.querySelector("#pedidoDetalleModalBackdrop .btn-success");
    if (btnImprimir) {
      if (pedido.PDF_URL) {
        btnImprimir.textContent = "📄 Ver PDF del pedido";
        btnImprimir.onclick = () => window.open(pedido.PDF_URL, "_blank");
      } else {
        btnImprimir.textContent = "Imprimir pedido (A4)";
        btnImprimir.onclick = imprimirNotaPedidoA4;
      }
    }

    // Mostrar/ocultar botón etiqueta según estado
    const btnEtiqueta = document.getElementById("btnImprimirEtiquetaDetalle");
    if (btnEtiqueta) btnEtiqueta.style.display = pedido.ESTADO === "PREPARANDO" ? "inline-flex" : "none";

    // Editar ítems: solo mientras el pedido sigue en NUEVO — una vez
    // que pasa a Preparando ya se descontó stock, y editar ahí
    // complicaría tener que devolver/redescontar con más margen de error.
    const btnEditarItems = document.getElementById("btnEditarItemsPedido");
    if (btnEditarItems) btnEditarItems.style.display = pedido.ESTADO === "NUEVO" ? "inline-flex" : "none";

    const simbolo = String(pedido.MONEDA || "ARS").toUpperCase() === "USD" ? "US$" : "$";
    const filas = detalle.map(item => `
      <tr>
        <td style="padding:6px 0;">${item.cantidad}x ${escapeHtml(item.PRODUCTO)}</td>
        <td style="padding:6px 0; text-align:right; font-family:var(--font-mono);">${simbolo}${(item.PRECIO * item.cantidad).toLocaleString("es-AR")}</td>
      </tr>`).join("");

    document.getElementById("pedidoDetalleBody").innerHTML = `
      <div class="config-preview-hint mb-3">
        <span class="ic">${ESTADO_ICONO_PEDIDO[pedido.ESTADO] || "📦"}</span>
        Pedido <strong>${escapeHtml(pedido.PEDIDO_ID)}</strong> — Estado: <strong>${escapeHtml(pedido.ESTADO)}</strong>
      </div>
      <div class="mb-2"><strong style="font-size:15px;">${escapeHtml(pedido.CLIENTE)}</strong>${pedido.DNI ? ` · DNI/CUIT: ${escapeHtml(pedido.DNI)}` : ""}</div>
      ${pedido.TELEFONO ? `<div class="mb-1" style="font-size:13px;color:var(--slate-500);">📞 ${escapeHtml(pedido.TELEFONO)}</div>` : ""}
      ${pedido.DIRECCION ? `<div class="mb-1" style="font-size:13px;color:var(--slate-500);">📍 ${escapeHtml(pedido.DIRECCION)}${pedido.LOCALIDAD ? ", " + escapeHtml(pedido.LOCALIDAD) : ""}${pedido.PROVINCIA ? ", " + escapeHtml(pedido.PROVINCIA) : ""}${pedido.CODIGO_POSTAL ? " (CP " + escapeHtml(pedido.CODIGO_POSTAL) + ")" : ""}</div>` : ""}
      ${pedido.EMPRESA ? `<div class="mb-3" style="font-size:13px;color:var(--slate-500);">🚚 ${escapeHtml(pedido.EMPRESA)}</div>` : `<div class="mb-3"></div>`}
      <table style="width:100%; border-collapse:collapse; font-size:13.5px;">
        <tbody>${filas}</tbody>
        <tfoot>
          ${Number(pedido.DESCUENTO || 0) > 0 ? `
          <tr style="border-top:1px solid var(--slate-200);">
            <td style="padding-top:8px; color:var(--slate-500);">Subtotal</td>
            <td style="padding-top:8px; text-align:right; font-family:var(--font-mono); color:var(--slate-500);">${simbolo}${Number(pedido.SUBTOTAL || pedido.TOTAL || 0).toLocaleString("es-AR")}</td>
          </tr>
          <tr>
            <td style="padding-top:4px; color:var(--red-500); font-weight:700;">Descuento${pedido.DESCUENTO_ETIQUETA ? " (" + pedido.DESCUENTO_ETIQUETA + ")" : ""}</td>
            <td style="padding-top:4px; text-align:right; font-family:var(--font-mono); color:var(--red-500); font-weight:700;">-${simbolo}${Number(pedido.DESCUENTO).toLocaleString("es-AR")}</td>
          </tr>` : ""}
          <tr style="border-top:2px solid var(--slate-200);">
            <td style="padding-top:10px;"><strong>Total</strong></td>
            <td style="padding-top:10px; text-align:right; font-family:var(--font-mono);"><strong>${simbolo}${Number(pedido.TOTAL || 0).toLocaleString("es-AR")}</strong></td>
          </tr>
        </tfoot>
      </table>`;

  } catch (error) {
    console.error("Error al abrir detalle de pedido:", error);
    toast("Error al cargar el detalle del pedido", "error");
    cerrarModalDetallePedido();
  }
}

function cerrarModalDetallePedido() {
  document.getElementById("pedidoDetalleModalBackdrop").classList.remove("show");
  pedidoDetalleActual = null;
  _carritoEdicionPedido = null;
}

/* ===================== EDITAR ÍTEMS DE UN PEDIDO (solo estado NUEVO) ===================== */

let _carritoEdicionPedido = null; // copia de trabajo mientras se edita — no toca pedidoDetalleActual hasta guardar

function activarEdicionItemsPedido() {
  if (!pedidoDetalleActual) return;
  // Copia de trabajo — si cancela, pedidoDetalleActual queda intacto
  _carritoEdicionPedido = pedidoDetalleActual.detalle.map(item => ({ ...item }));
  renderEdicionItemsPedido();
}

function cancelarEdicionItemsPedido() {
  _carritoEdicionPedido = null;
  abrirDetallePedido(pedidoDetalleActual.pedido.PEDIDO_ID); // vuelve a la vista normal, con los datos tal cual estaban
}

function renderEdicionItemsPedido() {
  const pedido = pedidoDetalleActual.pedido;
  const simbolo = String(pedido.MONEDA || "ARS").toUpperCase() === "USD" ? "US$" : "$";

  const filas = _carritoEdicionPedido.map((item, idx) => `
    <tr>
      <td style="padding:5px 4px;">
        <input type="number" min="1" step="1" value="${item.cantidad}" class="form-control form-control-sm" style="width:64px;"
          onchange="_edicionPedidoCambiarCampo(${idx}, 'cantidad', this.value)">
      </td>
      <td style="padding:5px 4px; font-size:13px;">${escapeHtml(item.PRODUCTO)}</td>
      <td style="padding:5px 4px;">
        <input type="number" min="0" step="1" value="${item.PRECIO}" class="form-control form-control-sm" style="width:90px;"
          onchange="_edicionPedidoCambiarCampo(${idx}, 'PRECIO', this.value)">
      </td>
      <td style="padding:5px 4px; text-align:right; font-family:var(--font-mono); font-size:13px;">${simbolo}${((Number(item.PRECIO) || 0) * (Number(item.cantidad) || 0)).toLocaleString("es-AR")}</td>
      <td style="padding:5px 4px;">
        <button type="button" class="btn btn-outline-danger btn-sm" title="Quitar" onclick="_edicionPedidoQuitarItem(${idx})">🗑️</button>
      </td>
    </tr>`).join("");

  const subtotal = _carritoEdicionPedido.reduce((acc, i) => acc + (Number(i.PRECIO) || 0) * (Number(i.cantidad) || 0), 0);
  const descuento = Number(pedido.DESCUENTO || 0);
  const total = Math.max(0, subtotal - descuento);

  document.getElementById("pedidoDetalleBody").innerHTML = `
    <div class="config-preview-hint mb-3">
      <span class="ic">✏️</span> Editando ítems del pedido <strong>${escapeHtml(pedido.PEDIDO_ID)}</strong> — solo se puede mientras está en NUEVO.
    </div>
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead>
        <tr style="color:var(--slate-500); font-size:11.5px;">
          <td style="padding:0 4px 4px;">Cant.</td>
          <td style="padding:0 4px 4px;">Producto</td>
          <td style="padding:0 4px 4px;">Precio</td>
          <td style="padding:0 4px 4px; text-align:right;">Subtotal</td>
          <td></td>
        </tr>
      </thead>
      <tbody>${filas}</tbody>
    </table>

    <div class="mt-3 mb-2" style="position:relative;">
      <div class="d-flex gap-2 align-items-center">
        <input type="text" id="edicionPedidoBuscarProducto" class="form-control form-control-sm" placeholder="🔍 Código o nombre del producto a agregar..."
          autocomplete="off" oninput="_edicionPedidoActualizarResultados()" onkeydown="if(event.key==='Enter'){event.preventDefault(); _edicionPedidoAgregarProducto();}">
        <button type="button" class="btn btn-outline-primary btn-sm" style="white-space:nowrap;" onclick="_edicionPedidoAgregarProducto()">+ Agregar</button>
      </div>
      <div id="edicionPedidoResultados" class="edicion-pedido-resultados" style="display:none;"></div>
    </div>

    <table style="width:100%; border-collapse:collapse; font-size:13.5px; margin-top:10px;">
      <tfoot>
        ${descuento > 0 ? `
        <tr style="border-top:1px solid var(--slate-200);">
          <td colspan="4" style="padding-top:8px; color:var(--slate-500);">Subtotal</td>
          <td style="padding-top:8px; text-align:right; font-family:var(--font-mono); color:var(--slate-500);">${simbolo}${subtotal.toLocaleString("es-AR")}</td>
        </tr>
        <tr>
          <td colspan="4" style="padding-top:4px; color:var(--red-500); font-weight:700;">Descuento${pedido.DESCUENTO_ETIQUETA ? " (" + pedido.DESCUENTO_ETIQUETA + ")" : ""}</td>
          <td style="padding-top:4px; text-align:right; font-family:var(--font-mono); color:var(--red-500); font-weight:700;">-${simbolo}${descuento.toLocaleString("es-AR")}</td>
        </tr>` : ""}
        <tr style="border-top:2px solid var(--slate-200);">
          <td colspan="4" style="padding-top:10px;"><strong>Nuevo total</strong></td>
          <td style="padding-top:10px; text-align:right; font-family:var(--font-mono);"><strong>${simbolo}${total.toLocaleString("es-AR")}</strong></td>
        </tr>
      </tfoot>
    </table>

    <div class="d-flex justify-content-end gap-2 mt-3">
      <button type="button" class="btn btn-outline-secondary btn-sm" onclick="cancelarEdicionItemsPedido()">Cancelar</button>
      <button type="button" class="btn btn-success btn-sm" id="btnGuardarEdicionItemsPedido" onclick="guardarEdicionItemsPedido()">💾 Guardar cambios</button>
    </div>`;
}

function _edicionPedidoCambiarCampo(idx, campo, valor) {
  const n = Number(valor);
  if (isNaN(n) || n < 0 || (campo === "cantidad" && n < 1)) { renderEdicionItemsPedido(); return; }
  _carritoEdicionPedido[idx][campo] = n;
  renderEdicionItemsPedido();
}

function _edicionPedidoQuitarItem(idx) {
  if (_carritoEdicionPedido.length <= 1) {
    toast("El pedido no puede quedar sin productos — editalo o cancelalo en vez de vaciarlo", "error");
    return;
  }
  _carritoEdicionPedido.splice(idx, 1);
  renderEdicionItemsPedido();
}

let _productoElegidoEdicionPedido = null; // el producto que quedó seleccionado al hacer clic en un resultado de la lista

function _edicionPedidoActualizarResultados() {
  const input = document.getElementById("edicionPedidoBuscarProducto");
  const texto = input.value.trim().toLowerCase();
  const cont = document.getElementById("edicionPedidoResultados");

  // Si el texto cambió después de haber elegido un producto de la
  // lista, esa selección ya no es válida (el cajero puede estar
  // buscando otra cosa) — se limpia hasta que vuelva a elegir.
  _productoElegidoEdicionPedido = null;

  if (!texto || texto.length < 2) { cont.style.display = "none"; cont.innerHTML = ""; return; }

  const fuente = (productosAdminGlobal && productosAdminGlobal.length ? productosAdminGlobal : productosPOS) || [];
  const coincidencias = fuente
    .filter(p => String(p.CODIGO).toLowerCase().includes(texto) || String(p.PRODUCTO).toLowerCase().includes(texto))
    .slice(0, 15);

  if (coincidencias.length === 0) {
    cont.innerHTML = `<div class="edicion-pedido-resultado-vacio">Sin resultados</div>`;
    cont.style.display = "block";
    return;
  }

  cont.innerHTML = coincidencias.map((p, idx) => `
    <div class="edicion-pedido-resultado-item" onclick="_edicionPedidoElegirResultado(${idx})">
      <span class="epr-codigo">${escapeHtml(p.CODIGO)}</span>
      <span class="epr-nombre">${escapeHtml(p.PRODUCTO)}</span>
      <span class="epr-precio">$${Number(p.PRECIO || 0).toLocaleString("es-AR")}</span>
    </div>`).join("");

  // Se guardan las coincidencias actuales para que el clic (que solo
  // manda el índice) sepa a qué producto corresponde cada fila.
  _resultadosEdicionPedidoActuales = coincidencias;

  cont.style.display = "block";
}

let _resultadosEdicionPedidoActuales = [];

function _edicionPedidoElegirResultado(idx) {
  const producto = _resultadosEdicionPedidoActuales[idx];
  if (!producto) return;

  _productoElegidoEdicionPedido = producto;
  document.getElementById("edicionPedidoBuscarProducto").value = `${producto.CODIGO} — ${producto.PRODUCTO}`;
  document.getElementById("edicionPedidoResultados").style.display = "none";

  _edicionPedidoAgregarProducto();
}

// Cierra la lista de resultados si se toca en cualquier otro lado del modal
document.addEventListener("click", (e) => {
  const cont = document.getElementById("edicionPedidoResultados");
  const input = document.getElementById("edicionPedidoBuscarProducto");
  if (!cont || cont.style.display === "none") return;
  if (e.target === input || cont.contains(e.target)) return;
  cont.style.display = "none";
});

function _edicionPedidoAgregarProducto() {
  const input = document.getElementById("edicionPedidoBuscarProducto");
  const texto = input.value.trim();
  if (!texto) return;

  // Si se hizo clic en un resultado de la lista, ya sabemos exactamente
  // qué producto es (sin depender de volver a parsear el texto escrito).
  let producto = _productoElegidoEdicionPedido;

  if (!producto) {
    const codigoEscrito = texto.split(" — ")[0].trim().toLowerCase();
    const fuente = (productosAdminGlobal && productosAdminGlobal.length ? productosAdminGlobal : productosPOS) || [];
    producto = fuente.find(p => String(p.CODIGO).toLowerCase() === codigoEscrito)
      || fuente.find(p => String(p.PRODUCTO).toLowerCase() === texto.toLowerCase());
  }

  if (!producto) { toast("No se encontró ese producto — elegilo de la lista de resultados", "error"); return; }

  const existente = _carritoEdicionPedido.find(i => String(i.CODIGO) === String(producto.CODIGO));
  if (existente) {
    existente.cantidad++;
  } else {
    _carritoEdicionPedido.push({
      CODIGO: producto.CODIGO,
      PRODUCTO: producto.PRODUCTO,
      cantidad: 1,
      PRECIO: Number(producto.PRECIO) || 0
    });
  }

  input.value = "";
  _productoElegidoEdicionPedido = null;
  renderEdicionItemsPedido();
}

async function guardarEdicionItemsPedido() {
  if (!_carritoEdicionPedido || _carritoEdicionPedido.length === 0) return;

  const pedidoId = pedidoDetalleActual.pedido.PEDIDO_ID;
  const btn = document.getElementById("btnGuardarEdicionItemsPedido");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Guardando...";

  try {
    // Por POST, con el carrito en el body — mismo motivo que en
    // ventas/pedidos grandes: por GET, con todo en la URL, un pedido
    // con muchos ítems puede superar lo que Apps Script acepta.
    const response = await fetchAPI(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "editarItemsPedido",
        pedidoId,
        carrito: _carritoEdicionPedido
      })
    }, { timeoutMs: 30000 });
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudieron guardar los cambios", "error");
      return;
    }

    if (data.pdfError) {
      toast(data.message, "error");
    } else {
      toast("Ítems del pedido actualizados", "success");
    }

    _carritoEdicionPedido = null;
    invalidarCache("pedidos");
    cargarPedidos(); // refresca el total en la lista de atrás también
    abrirDetallePedido(pedidoId); // vuelve a la vista normal con los datos ya guardados

  } catch (error) {
    console.error("Error al editar ítems del pedido:", error);
    toast("Error de conexión al guardar los cambios", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

function imprimirEtiquetaDesdeDetalle() {
  if (!pedidoDetalleActual) return;
  const p = pedidoDetalleActual.pedido;
  imprimirEtiquetaEnvio({
    pedidoId: p.PEDIDO_ID, cliente: p.CLIENTE, telefono: p.TELEFONO || "",
    direccion: p.DIRECCION || "", localidad: p.LOCALIDAD || "", provincia: p.PROVINCIA || "",
    codigoPostal: p.CODIGO_POSTAL || p.CODIGOPOSTAL || "", dni: p.DNI || "", transporte: p.EMPRESA || ""
  });
}

function imprimirNotaPedidoA4() {
  if (!pedidoDetalleActual) return;
  const { pedido, detalle } = pedidoDetalleActual;
  const simbolo = String(pedido.MONEDA || "ARS").toUpperCase() === "USD" ? "US$" : "$";
  const ahora = new Date().toLocaleString("es-AR");
  const fechaPedido = pedido.FECHA ? new Date(pedido.FECHA).toLocaleDateString("es-AR") : "—";

  const filasItems = detalle.map(item => `
    <tr>
      <td style="padding:6px; border:1px solid #ddd; font-family:monospace; font-size:9pt;">${escapeHtml(item.CODIGO || "")}</td>
      <td style="padding:6px; border:1px solid #ddd;">${escapeHtml(item.PRODUCTO)}</td>
      <td style="padding:6px; border:1px solid #ddd; text-align:center;">${item.cantidad}</td>
      <td style="padding:6px; border:1px solid #ddd; text-align:right;">${simbolo}${Number(item.PRECIO).toLocaleString("es-AR")}</td>
      <td style="padding:6px; border:1px solid #ddd; text-align:right;">${simbolo}${(item.PRECIO * item.cantidad).toLocaleString("es-AR")}</td>
    </tr>`).join("");

  const filaDoc = (label, valor) => valor
    ? `<tr><td style="padding:4px 8px; font-size:7pt; font-weight:700; text-transform:uppercase; color:#555; width:32mm; vertical-align:top;">${label}:</td><td style="padding:4px 8px; font-size:11pt; font-weight:700;">${escapeHtml(valor)}</td></tr>`
    : "";

  const cobradoStr = String(pedido.COBRADO || "").toUpperCase() === "SI"
    ? `<div style="margin-top:4mm; font-size:11pt; color:#16a34a; font-weight:700;">Cobrado${pedido.FORMA_PAGO_COBRO ? " — " + escapeHtml(pedido.FORMA_PAGO_COBRO) : ""}</div>`
    : `<div style="margin-top:4mm; font-size:11pt; color:#d32f2f; font-weight:700;">Pendiente de cobro</div>`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif; width:190mm; margin:10mm auto; padding:8mm; box-sizing:border-box; border:2px solid #000; border-radius:4mm;">
      <div style="text-align:center; margin-bottom:6mm;">
        <div style="font-size:20pt; font-weight:900;">Jireh Mayorista</div>
      </div>
      <div style="background:#0b1633; color:#fff; text-align:center; padding:4mm; border-radius:2mm; margin-bottom:6mm;">
        <div style="font-size:14pt; font-weight:900; letter-spacing:2px;">NOTA DE PEDIDO</div>
        <div style="font-size:11pt; font-weight:700;">${escapeHtml(pedido.PEDIDO_ID)} — ${fechaPedido}</div>
      </div>
      <table style="width:100%; border-collapse:collapse; font-size:11pt; margin-bottom:6mm;">
        ${filaDoc("Cliente", pedido.CLIENTE)}
        ${filaDoc("Teléfono", pedido.TELEFONO)}
        ${filaDoc("Dirección", [pedido.DIRECCION, pedido.LOCALIDAD, pedido.PROVINCIA].filter(Boolean).join(", "))}
        ${filaDoc("CP", pedido.CODIGO_POSTAL || pedido.CODIGOPOSTAL)}
        ${filaDoc("DNI/CUIT", pedido.DNI)}
        ${filaDoc("Transporte", pedido.EMPRESA)}
        ${filaDoc("Estado", pedido.ESTADO)}
      </table>
      <table style="width:100%; border-collapse:collapse; font-size:11pt;">
        <thead>
          <tr style="background:#f4f4f4;">
            <th style="padding:6px; text-align:left; border:1px solid #ddd;">Código</th>
            <th style="padding:6px; text-align:left; border:1px solid #ddd;">Producto</th>
            <th style="padding:6px; text-align:center; border:1px solid #ddd;">Cant.</th>
            <th style="padding:6px; text-align:right; border:1px solid #ddd;">Precio</th>
            <th style="padding:6px; text-align:right; border:1px solid #ddd;">Subtotal</th>
          </tr>
        </thead>
        <tbody>${filasItems}</tbody>
        <tfoot>
          ${Number(pedido.DESCUENTO || 0) > 0 ? `
          <tr>
            <td colspan="4" style="padding:6px; text-align:right; border:1px solid #ddd; color:#555;">Subtotal</td>
            <td style="padding:6px; text-align:right; border:1px solid #ddd; color:#555;">${simbolo}${Number(pedido.SUBTOTAL || pedido.TOTAL || 0).toLocaleString("es-AR")}</td>
          </tr>
          <tr>
            <td colspan="4" style="padding:6px; text-align:right; border:1px solid #ddd; color:#d32f2f; font-weight:700;">Descuento${pedido.DESCUENTO_ETIQUETA ? " (" + pedido.DESCUENTO_ETIQUETA + ")" : ""}</td>
            <td style="padding:6px; text-align:right; border:1px solid #ddd; color:#d32f2f; font-weight:700;">-${simbolo}${Number(pedido.DESCUENTO).toLocaleString("es-AR")}</td>
          </tr>` : ""}
          <tr>
            <td colspan="4" style="padding:8px; text-align:right; border:1px solid #ddd;"><strong>TOTAL</strong></td>
            <td style="padding:8px; text-align:right; border:1px solid #ddd;"><strong>${simbolo}${Number(pedido.TOTAL || 0).toLocaleString("es-AR")}</strong></td>
          </tr>
        </tfoot>
      </table>
      ${cobradoStr}
      <div style="text-align:center; font-size:8pt; color:#aaa; margin-top:4mm;">Impreso el ${ahora}</div>
    </div>`;

  const area = document.getElementById("etiquetasPrintArea");
  area.innerHTML = html;
  setTimeout(() => window.print(), 120);
}

/**
 * Normaliza un número de teléfono argentino al formato internacional
 * que requiere wa.me (sin +, sin espacios, con código de país).
 * Maneja: 011XXXXXXXX, 15XXXXXXXX, 9XXXXXXXX, 54911XXXXXXXX, etc.
 */
function normalizarTelefonoWA(tel) {
  if (!tel) return null;

  // Quita todo lo que no sea dígito
  let num = String(tel).replace(/\D/g, "");

  // Si ya empieza con 54 y tiene 13 dígitos → ya está listo
  if (num.startsWith("54") && num.length === 13) return num;

  // Si empieza con 54 pero le falta el 9 de celular (5411XXXXXXXX → 54911XXXXXXXX)
  if (num.startsWith("54") && num.length === 12) return "549" + num.slice(2);

  // Quita el 0 inicial de área si lo tiene (0351... → 351...)
  if (num.startsWith("0")) num = num.slice(1);

  // Quita el 15 de celular si lo tiene después del área (351158... → 35158...)
  // Área argentina: 2-4 dígitos, luego el número. El 15 aparece en posición variable.
  // Estrategia: si el número tiene exactamente 10 dígitos (área 2-4 + número 6-8)
  // lo armamos directo. Si tiene 11, probablemente tenga el 15 incluido.
  if (num.length === 11 && num.charAt(2) === "1" && num.charAt(3) === "5") {
    num = num.slice(0, 2) + num.slice(4); // quita el 15 tras el área de 2 dígitos
  } else if (num.length === 11 && num.charAt(3) === "1" && num.charAt(4) === "5") {
    num = num.slice(0, 3) + num.slice(5); // quita el 15 tras el área de 3 dígitos
  } else if (num.length === 11 && num.charAt(4) === "1" && num.charAt(5) === "5") {
    num = num.slice(0, 4) + num.slice(6); // quita el 15 tras el área de 4 dígitos
  }

  // Agrega código de país Argentina + 9 de celular
  // (WA Argentina requiere 549 + área + número = 13 dígitos total)
  if (num.length === 10) return "549" + num;
  if (num.length === 8)  return "5491" + num; // número corto sin área, asume GBA

  return null; // no se pudo normalizar — el botón no se muestra
}

/** Genera el mensaje de WhatsApp según el estado del pedido */
function mensajeWhatsAppPorEstado(estado, pedidoId, cliente, total, pdfUrl) {
  const totalStr = "$" + Number(total || 0).toLocaleString("es-AR");
  const linkPdf = pdfUrl ? `\n\nComprobante de pedido: ${pdfUrl}` : "";
  switch(estado) {
    case "NUEVO":
      return `Hola ${cliente}! Recibimos tu pedido ${pedidoId} por ${totalStr}.\n\nPara confirmar tu pedido, realizá la transferencia a:\nAlias: jireholga\nNombre: Olga Carbajal Alvis\n\nUna vez realizado el pago, envianos el comprobante por este medio para que podamos empezar a preparar tu pedido. Gracias por elegirnos!${linkPdf}`;
    case "PREPARANDO":
      return `Hola ${cliente}! Tu pedido ${pedidoId} por ${totalStr} ya esta siendo preparado. En cuanto este listo te avisamos. Gracias por tu compra!${linkPdf}`;
    case "ENVIADO":
      return `Hola ${cliente}! Tu pedido ${pedidoId} por ${totalStr} ya fue enviado y esta en camino. Pronto lo tenes en tus manos!${linkPdf}`;
    default:
      return null;
  }
}

let _renderGenPedidos = 0; // evita que un render viejo (todavía terminando sus chunks) escriba encima de uno más nuevo

function renderPedidos(listaOriginal) {
  const container = document.getElementById("tablaPedidos");
  if (!container) return;

  // Se ordena una COPIA, más nuevo primero — nunca a "lista" en sí ni
  // a pedidosGlobal, porque cargarPedidos() compara el orden crudo del
  // backend contra el anterior para saber si hubo cambios (y así
  // evitar redibujar cuando no hace falta). Si acá se ordenara el
  // array real, esa comparación dejaría de funcionar y volvería el
  // salto de pantalla en cada actualización.
  const lista = [...listaOriginal].sort((a, b) => new Date(b.FECHA) - new Date(a.FECHA));

  const miGen = ++_renderGenPedidos;

  // Guarda dónde estaba parado el usuario para restaurarlo después de
  // reconstruir la lista — sin esto, cada refresco hacía "saltar" la
  // pantalla al principio aunque el usuario estuviera leyendo un
  // pedido más abajo.
  const scrollContainer = container.closest(".seccion") || container.parentElement;
  const scrollTopPrevio = scrollContainer ? scrollContainer.scrollTop : 0;

  if (lista.length === 0) {
    container.innerHTML = `<div class="text-center text-muted py-5" style="font-size:14px;">No se encontraron pedidos</div>`;
    return;
  }

  const estadoClase = { NUEVO:"nuevo", PREPARANDO:"preparando", ENVIADO:"enviado", CANCELADO:"cancelado" };
  const estadoIcono = { NUEVO:"🆕", PREPARANDO:"⚙️", ENVIADO:"📦", CANCELADO:"❌" };

  const CHUNK = 15;
  let idx = 0;
  container.innerHTML = "";

  const renderChunk = () => {
    if (miGen !== _renderGenPedidos) return; // superado por un render más nuevo — no seguir escribiendo
    const frag = document.createDocumentFragment();
    const fin = Math.min(idx + CHUNK, lista.length);
    for (; idx < fin; idx++) {
      const p = lista[idx];
      const claseEstado = estadoClase[p.ESTADO] || "";
      const estaCobrado = String(p.COBRADO || "").toUpperCase() === "SI";
      const formaPagoActual = String(p.FORMA_PAGO_COBRO || "");
      const estadosConWA = ["NUEVO", "PREPARANDO", "ENVIADO"];
      const telefono = String(p.TELEFONO || "").trim();
      const numeroWA = normalizarTelefonoWA(telefono);
      const mensajeWA = mensajeWhatsAppPorEstado(p.ESTADO, p.PEDIDO_ID, p.CLIENTE, p.TOTAL, p.PDF_URL);
      // Si el teléfono no tiene ningún dígito, no hay nada que mandar
      // — ahí sí no tiene sentido mostrar el botón. Pero si HAY
      // dígitos y solo falló el reconocimiento del formato (área rara,
      // como pasa con algunos números fijos o de localidades chicas),
      // se muestra igual con el mejor intento posible (los dígitos tal
      // cual, con el prefijo de Argentina) en vez de ocultarlo del
      // todo sin avisar — antes esto desaparecía en silencio y no
      // había forma de saber por qué.
      const soloDigitos = telefono.replace(/\D/g, "");
      const numeroWAConFallback = numeroWA || (soloDigitos ? "54" + soloDigitos.replace(/^0+/, "") : null);
      const esNumeroDudoso = !numeroWA && !!numeroWAConFallback;
      const btnWA = (estadosConWA.includes(p.ESTADO) && numeroWAConFallback && mensajeWA)
        ? `<a href="https://wa.me/${numeroWAConFallback}?text=${encodeURIComponent(mensajeWA)}" target="_blank" class="btn btn-success btn-sm" title="${esNumeroDudoso ? "Verificá el teléfono antes de mandar — el formato no se reconoció con seguridad" : "Notificar por WhatsApp"}">📲 WhatsApp${esNumeroDudoso ? " ⚠️" : ""}</a>`
        : "";
      const badgeCobrado = estaCobrado
        ? `<span class="pedido-cobrado-badge">✓ Cobrado <span class="pedido-cobrado-forma">${formaPagoActual}</span></span>` : "";
      const selectCobrado = estaCobrado
        ? `<div class="pedido-cobrado-controles">
             <span class="pedido-cobrado-badge">✓ Cobrado</span>
             <span class="pedido-cobrado-forma">${formaPagoActual}</span>
             <button class="btn btn-outline-danger btn-sm" style="font-size:11px;padding:2px 8px;"
               onclick="aplicarCobroPedido('${p.PEDIDO_ID}', false, '')">Desmarcar</button>
           </div>`
        : `<div class="pedido-pago-btns" data-pedido="${p.PEDIDO_ID}">
             <span style="font-size:11px;font-weight:600;color:var(--slate-500);">Cobrar con:</span>
             <button class="pedido-pago-btn" onclick="aplicarCobroPedido('${p.PEDIDO_ID}', true, 'EFECTIVO')">💵 Efectivo</button>
             <button class="pedido-pago-btn" onclick="aplicarCobroPedido('${p.PEDIDO_ID}', true, 'TRANSFERENCIA')">📲 Transfer.</button>
             <button class="pedido-pago-btn" onclick="aplicarCobroPedido('${p.PEDIDO_ID}', true, 'TARJETA')">💳 Tarjeta</button>
           </div>`;
      const tmp = document.createElement("div");
      tmp.innerHTML = `<div class="pedido-card estado-${claseEstado}">
        <div class="pedido-card-top">
          <div>
            <div class="pedido-card-id">${escapeHtml(p.PEDIDO_ID)}</div>
            <div class="pedido-card-cliente">${escapeHtml(p.CLIENTE)}${p.EMPRESA ? ` <span style="font-weight:500;color:var(--slate-500);font-size:13px;">· 🚚 ${escapeHtml(p.EMPRESA)}</span>` : ""}</div>
            ${p.DIRECCION ? `<div class="pedido-card-dir">📍 ${escapeHtml(p.DIRECCION)}${p.LOCALIDAD ? ", " + escapeHtml(p.LOCALIDAD) : ""}</div>` : ""}
            <div class="pedido-card-fecha">📅 ${new Date(p.FECHA).toLocaleDateString("es-AR", {day:"2-digit", month:"2-digit", year:"numeric"})}</div>
          </div>
          <div class="text-end">
            <div class="pedido-card-total">$${Number(p.TOTAL || 0).toLocaleString("es-AR")}</div>
            <div class="mt-1"><span class="pedido-estado-badge ${claseEstado}">${estadoIcono[p.ESTADO] || ""} ${escapeHtml(p.ESTADO)}</span></div>
            ${badgeCobrado ? `<div class="mt-1">${badgeCobrado}</div>` : ""}
          </div>
        </div>
        <div class="pedido-card-controls">
          <select class="form-select form-select-sm" style="max-width:160px;" onchange="cambiarEstado('${p.PEDIDO_ID}',this.value)">
            <option value="NUEVO"      ${p.ESTADO==="NUEVO"?"selected":""}>🆕 Nuevo</option>
            <option value="PREPARANDO" ${p.ESTADO==="PREPARANDO"?"selected":""}>⚙️ Preparando</option>
            <option value="ENVIADO"    ${p.ESTADO==="ENVIADO"?"selected":""}>📦 Enviado</option>
            <option value="CANCELADO"  ${p.ESTADO==="CANCELADO"?"selected":""}>❌ Cancelado</option>
          </select>
          ${btnWA}
          ${selectCobrado}
          <button class="btn btn-outline-secondary btn-sm ms-auto" onclick="abrirDetallePedido('${p.PEDIDO_ID}')">Ver / Reimprimir</button>
        </div>
      </div>`;
      frag.appendChild(tmp.firstElementChild);
    }
    container.appendChild(frag);
    if (idx < lista.length) {
      requestAnimationFrame(renderChunk);
    } else if (scrollContainer) {
      // Recién al terminar de reconstruir toda la lista se restaura el
      // scroll — hacerlo antes dejaría al contenedor más bajo de lo
      // que todavía existe en el DOM.
      scrollContainer.scrollTop = scrollTopPrevio;
    }
  };

  requestAnimationFrame(renderChunk);
}

/* ===================== PRODUCTOS (tabla admin) ===================== */

async function cargarProductos() {
  // 1. Mostrar desde caché instantáneamente si existe y es fresco
  const CACHE_KEY = "vpos_cache_productosAdmin";
  const CACHE_TTL = 5 * 60 * 1000; // 5 minutos
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const { ts, data } = JSON.parse(raw);
      if (data && data.length > 0) {
        productosAdminGlobal = data;
        poblarFiltroCategoriasProductos();
        filtrarProductos();
        // Si el caché es fresco, no recargar del server
        if (Date.now() - ts < CACHE_TTL) return;
        // Si está vencido, actualizar en segundo plano sin bloquear
        _actualizarProductosAdminEnBackground(CACHE_KEY);
        return;
      }
    }
  } catch(e) {}

  // 2. Sin caché: mostrar skeleton y cargar del server
  const tbody = document.getElementById("tablaProductos");
  if (tbody) tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">Cargando productos...</td></tr>`;
  await _actualizarProductosAdminEnBackground(CACHE_KEY);
}

async function actualizarCatalogoProductosManual() {
  try { localStorage.removeItem("vpos_cache_productosAdmin"); } catch(e) {}
  productosAdminGlobal = [];
  toast("Actualizando productos...", "success");
  await cargarProductos();
}

async function _actualizarProductosAdminEnBackground(cacheKey) {
  try {
    const response = await fetchAPI(API_URL + "?action=productosAdmin");
    const data = await response.json();
    if (!data.productos) return;
    productosAdminGlobal = data.productos;
    try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: data.productos })); } catch(e) {}
    poblarFiltroCategoriasProductos();
    filtrarProductos();
  } catch (error) {
    console.error("Error productos:", error);
    toast("No se pudieron actualizar los productos — revisá tu conexión", "error");
  }
}

let _renderGenProductos = 0; // evita que un render viejo (todavía completando sus chunks) mezcle filas con uno más nuevo

function renderTablaProductos(lista) {
  const tbody = document.getElementById("tablaProductos");
  if (!tbody) return;

  const miGen = ++_renderGenProductos;

  if (!lista || lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted py-4">No se encontraron productos</td></tr>`;
    return;
  }

  // Renderizar en chunks para no bloquear el hilo principal
  // con 829 productos generando DOM de golpe
  const CHUNK = 80;
  let idx = 0;
  tbody.innerHTML = "";

  const renderChunk = () => {
    // Si mientras este render todavía estaba completando sus chunks
    // (varios requestAnimationFrame seguidos) el usuario tipeó de
    // nuevo y arrancó un render más nuevo, este viejo tiene que
    // abandonar en vez de seguir agregando filas — si no, sus filas
    // (de una búsqueda vieja) terminan mezcladas con las del render
    // nuevo, o incluso apareciendo solas después de que el nuevo ya
    // había limpiado y llenado la tabla. Esto era lo que hacía que la
    // búsqueda "no mostrara bien los resultados hasta volver a escribir".
    if (miGen !== _renderGenProductos) return;

    const frag = document.createDocumentFragment();
    const fin = Math.min(idx + CHUNK, lista.length);

    for (; idx < fin; idx++) {
      const p = lista[idx];
      const publicado = String(p.PUBLICADO || "").toUpperCase() === "SI";
      const stock = Number(p.STOCK || 0);
      const stockBadge = stock < 0
        ? `<span class="tile-stock negativo" title="Se vendió sin tener stock cargado">${stock}</span>`
        : stock === 0
        ? `<span class="tile-stock out">Sin stock</span>`
        : (stock <= 5 ? `<span class="tile-stock low">${stock}</span>` : stock);

      const imagenUrl = p.IMAGEN ? String(p.IMAGEN).trim() : "";
      const fotoHtml = imagenUrl
        ? `<img src="${escapeHtml(imagenUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='🛒';">`
        : "🛒";

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><input type="checkbox" class="check-producto-etiqueta" value="${escapeHtml(p.CODIGO)}" onchange="actualizarSeleccionEtiquetas()"></td>
        <td><div class="tabla-producto-thumb">${fotoHtml}</div></td>
        <td class="mono">${escapeHtml(p.CODIGO)}</td>
        <td>${escapeHtml(p.PRODUCTO)}</td>
        <td>${escapeHtml(p.CATEGORIA || "—")}</td>
        <td class="money">$${Number(p.PRECIO || 0).toLocaleString("es-AR")}</td>
        <td>${stockBadge}</td>
        <td><span class="badge ${publicado ? "bg-success" : "bg-secondary"}">${publicado ? "Publicado" : "Oculto"}</span></td>
        <td>
          <button class="btn btn-outline-success btn-sm btn-accion-producto" onclick="abrirModalStock('${escapeHtml(p.CODIGO)}')" title="Sumar stock">📦 Stock</button>
          <button class="btn btn-primary btn-sm btn-accion-producto ms-2" onclick="editarProducto('${escapeHtml(p.CODIGO)}')">Editar</button>
          <button class="btn btn-danger btn-sm btn-accion-producto ms-2" onclick="eliminarProducto('${escapeHtml(p.CODIGO)}')">Eliminar</button>
        </td>`;
      frag.appendChild(tr);
    }

    tbody.appendChild(frag);

    if (idx < lista.length) {
      // Ceder control al browser entre chunks para que no congele la UI
      requestAnimationFrame(renderChunk);
    } else {
      // Fin del render — actualizar estado de checkboxes
      const checkTodos = document.getElementById("checkTodosProductos");
      if (checkTodos) checkTodos.checked = false;
      actualizarSeleccionEtiquetas();
    }
  };

  requestAnimationFrame(renderChunk);
}

/** Fills the category <select> filter with the distinct categories currently in use */
function poblarFiltroCategoriasProductos() {
  const select = document.getElementById("filtroCategoriaProductos");
  if (!select) return;

  const valorActual = select.value;
  const categorias = [...new Set(
    productosAdminGlobal.map(p => String(p.CATEGORIA || "").trim()).filter(Boolean)
  )].sort();

  select.innerHTML = `<option value="">Todas las categorías</option>` +
    categorias.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");

  // Preserve the user's selection across refreshes when still valid
  if (categorias.includes(valorActual)) select.value = valorActual;
}

/** Client-side filter by name/code (text) and category (select), over the already-loaded product list */
function filtrarProductos() {
  const inputBuscar = document.getElementById("buscarProducto");
  const selectCategoria = document.getElementById("filtroCategoriaProductos");
  const selectEstado = document.getElementById("filtroEstadoProducto");

  // Normalizar: minúsculas + sin acentos para búsqueda más precisa
  const normalizar = t => String(t || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

  const termino = normalizar(inputBuscar ? inputBuscar.value : "");
  const categoria = selectCategoria ? selectCategoria.value : "";
  const estado = selectEstado ? selectEstado.value : "";

  let filtrados = productosAdminGlobal;

  if (termino) {
    filtrados = filtrados.filter(p => {
      const codigo = normalizar(p.CODIGO);
      const nombre = normalizar(p.PRODUCTO);
      const cat    = normalizar(p.CATEGORIA);
      return codigo.includes(termino) || nombre.includes(termino) || cat.includes(termino);
    });
  }

  if (categoria) {
    filtrados = filtrados.filter(p => String(p.CATEGORIA || "").trim() === categoria);
  }

  if (estado === "sin_imagen") {
    filtrados = filtrados.filter(p => !String(p.IMAGEN || "").trim());
  } else if (estado === "sin_stock") {
    filtrados = filtrados.filter(p => Number(p.STOCK ?? 0) <= 0);
  } else if (estado === "stock_negativo") {
    // Productos que se vendieron sin tener stock cargado (el POS ya
    // permite hacerlo) — sirve para encontrarlos rápido y actualizar
    // el stock real cuando llegue mercadería o se corrija la carga.
    filtrados = filtrados.filter(p => Number(p.STOCK ?? 0) < 0);
  } else if (estado === "sin_imagen_y_stock") {
    filtrados = filtrados.filter(p => !String(p.IMAGEN || "").trim() && Number(p.STOCK ?? 0) <= 0);
  }

  renderTablaProductos(filtrados);
}

/**
 * Versión con demora de filtrarProductos, usada SOLO por el tecleo en
 * el buscador (onkeyup) — el cambio de categoría (onchange del
 * <select>) y la carga inicial siguen llamando a filtrarProductos()
 * directo, sin demora, porque ahí no hay riesgo de redibujar la
 * tabla completa en cada tecla.
 */
const filtrarProductosConDemora = debounce(filtrarProductos, 150);

/* ===================== PRODUCTOS — ALTA / EDICIÓN (modal) ===================== */

let productosAdminGlobal = [];

/** Opens the modal in "create" mode */
function nuevoProducto() {
  document.getElementById("productModalTitle").textContent = "+ Nuevo Producto";
  document.getElementById("pmCodigoOriginal").value = "";
  document.getElementById("pmCodigo").value = "";
  document.getElementById("pmCodigo").disabled = false;
  document.getElementById("pmNombre").value = "";
  document.getElementById("pmCategoria").value = "";
  document.getElementById("pmPrecio").value = "";
  document.getElementById("pmStock").value = "";
  document.getElementById("pmImagen").value = "";
  document.getElementById("pmImagenArchivo").value = "";
  document.getElementById("pmImagenPreview").innerHTML = "🖼️";
  document.getElementById("pmImagenStatus").textContent = "";
  document.getElementById("pmImagenStatus").className = "pm-image-status";
  document.getElementById("pmPublicado").checked = true;
  document.getElementById("pmDestacado").checked = false;
  document.getElementById("pmOferta").checked = false;

  document.getElementById("pmVentaPorCaja").checked = false;
  document.getElementById("pmCodigoCaja").value = "";
  document.getElementById("pmUnidadesPorCaja").value = "";
  document.getElementById("pmPrecioCaja").value = "";
  document.getElementById("pmCajaWrap").style.display = "none";

  poblarCategoriasDatalist();
  document.getElementById("productModalBackdrop").classList.add("show");
  setTimeout(() => document.getElementById("pmNombre").focus(), 80);
}

/** Opens the modal in "edit" mode, pre-filled with the product's current data */
function editarProducto(codigo) {
  const p = productosAdminGlobal.find(x => String(x.CODIGO) === String(codigo));
  if (!p) { toast("No se encontró el producto para editar", "error"); return; }

  document.getElementById("productModalTitle").textContent = "✏️ Editar Producto";
  document.getElementById("pmCodigoOriginal").value = p.CODIGO;
  document.getElementById("pmCodigo").value = p.CODIGO;
  document.getElementById("pmNombre").value = p.PRODUCTO || "";
  document.getElementById("pmCategoria").value = p.CATEGORIA || "";
  document.getElementById("pmPrecio").value = Number(p.PRECIO || 0);
  document.getElementById("pmStock").value = Number(p.STOCK || 0);
  document.getElementById("pmImagen").value = p.IMAGEN || "";
  document.getElementById("pmImagenArchivo").value = "";
  document.getElementById("pmImagenStatus").textContent = "";
  document.getElementById("pmImagenStatus").className = "pm-image-status";
  document.getElementById("pmPublicado").checked = String(p.PUBLICADO || "").toUpperCase() === "SI";
  document.getElementById("pmDestacado").checked = String(p.DESTACADO || "").toUpperCase() === "SI";
  document.getElementById("pmOferta").checked = String(p.OFERTA || "").toUpperCase() === "SI";

  const tieneVentaPorCaja = !!(p.CODIGO_CAJA && String(p.CODIGO_CAJA).trim());
  document.getElementById("pmVentaPorCaja").checked = tieneVentaPorCaja;
  document.getElementById("pmCodigoCaja").value = p.CODIGO_CAJA || "";
  document.getElementById("pmUnidadesPorCaja").value = p.UNIDADES_POR_CAJA || "";
  document.getElementById("pmPrecioCaja").value = p.PRECIO_CAJA || "";
  document.getElementById("pmCajaWrap").style.display = tieneVentaPorCaja ? "" : "none";

  actualizarPreviewImagenProducto();
  poblarCategoriasDatalist();
  document.getElementById("productModalBackdrop").classList.add("show");
}

/** Muestra/oculta los campos de código/unidades/precio de caja */
function toggleVentaPorCaja() {
  const activo = document.getElementById("pmVentaPorCaja").checked;
  document.getElementById("pmCajaWrap").style.display = activo ? "" : "none";
}

function cerrarModalProducto() {
  document.getElementById("productModalBackdrop").classList.remove("show");
}

/* ===================== AGREGAR STOCK (entrada de mercadería) ===================== */

/** Opens the "Agregar Stock" modal pre-filled with the product's current data */
function abrirModalStock(codigo) {
  const p = productosAdminGlobal.find(x => String(x.CODIGO) === String(codigo));
  if (!p) { toast("No se encontró el producto", "error"); return; }

  document.getElementById("smCodigo").value = p.CODIGO;
  document.getElementById("smNombre").textContent = p.PRODUCTO || "—";
  document.getElementById("smCodigoLabel").textContent = p.CODIGO;
  const stockActual = Number(p.STOCK || 0);
  document.getElementById("smStockActual").textContent = stockActual.toLocaleString("es-AR");
  document.getElementById("smStockActual").dataset.valor = stockActual;
  document.getElementById("smCantidad").value = "";

  const imagenUrl = p.IMAGEN ? String(p.IMAGEN).trim() : "";
  document.getElementById("smFoto").innerHTML = imagenUrl
    ? `<img src="${escapeHtml(imagenUrl)}" alt="" onerror="this.parentElement.innerHTML='🛒';">`
    : "🛒";

  const resultadoEl = document.getElementById("smResultado");
  resultadoEl.classList.remove("show");

  document.getElementById("stockModalBackdrop").classList.add("show");
  setTimeout(() => document.getElementById("smCantidad").focus(), 80);
}

function cerrarModalStock() {
  document.getElementById("stockModalBackdrop").classList.remove("show");
}

/** Live preview: shows "stock actual + cantidad = stock nuevo" as the user types */
function actualizarPreviewStock() {
  const actual = Number(document.getElementById("smStockActual").dataset.valor || 0);
  const cantidad = Number(document.getElementById("smCantidad").value || 0);
  const resultadoEl = document.getElementById("smResultado");

  if (!cantidad || cantidad <= 0) {
    resultadoEl.classList.remove("show");
    return;
  }

  const nuevo = actual + cantidad;
  resultadoEl.innerHTML = `<span>Nuevo stock</span><strong>${actual.toLocaleString("es-AR")} + ${cantidad.toLocaleString("es-AR")} = ${nuevo.toLocaleString("es-AR")}</strong>`;
  resultadoEl.classList.add("show");
}

/** Sends the stock addition to the backend (sumarStockProducto) */
async function confirmarAgregarStock() {
  const codigo = document.getElementById("smCodigo").value.trim();
  const cantidad = document.getElementById("smCantidad").value;

  if (!cantidad || Number(cantidad) <= 0) {
    toast("Ingresá una cantidad válida, mayor a 0", "error");
    return;
  }

  const btn = document.getElementById("btnConfirmarStock");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Guardando...";

  try {
    const params = new URLSearchParams({
      action: "sumarStockProducto",
      codigo: codigo,
      cantidad: cantidad
    });

    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo sumar el stock", "error");
      return;
    }

    toast(`Stock actualizado: ${data.stockAnterior.toLocaleString("es-AR")} → ${data.stockNuevo.toLocaleString("es-AR")}`, "success");
    cerrarModalStock();
    cargarProductos();

    // Refresh in-memory POS catalog too, so the new stock shows up right away
    productosPOS = [];

  } catch (error) {
    console.error("Error al sumar stock:", error);
    toast("Error de conexión al sumar el stock", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

/** Live preview of the image URL pasted into the product modal */
function actualizarPreviewImagenProducto() {
  const url = document.getElementById("pmImagen").value.trim();
  const preview = document.getElementById("pmImagenPreview");
  if (!preview) return;
  if (!url) { preview.innerHTML = "🖼️"; return; }
  preview.innerHTML = `<img src="${escapeHtml(url)}" alt="" onerror="this.parentElement.innerHTML='⚠️';">`;
}

/**
 * Redimensiona y comprime una imagen en el navegador antes de subirla,
 * para que una foto de celular de varios MB no tarde una eternidad en
 * subir ni ocupe espacio de más en Drive. Devuelve siempre JPEG
 * (excepto si el original es más chico que el límite, en cuyo caso ni
 * vale la pena recomprimir).
 *
 * Estrategia: redimensiona al lado mayor = LADO_MAXIMO_PX, y si con
 * calidad inicial sigue pesando más que PESO_OBJETIVO_KB, vuelve a
 * comprimir con menos calidad (hasta MAX_INTENTOS veces). Nunca rechaza
 * la imagen — en el peor caso, sube la versión más liviana que logró.
 */
async function comprimirImagenProducto(file) {

  const LADO_MAXIMO_PX   = 900;
  const PESO_OBJETIVO_KB = 700;
  const CALIDADES        = [0.82, 0.7, 0.55, 0.4]; // intentos sucesivos, de mejor a peor calidad

  const imagen = await new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error("No se pudo leer la imagen seleccionada"));
    img.src = URL.createObjectURL(file);
  });

  let { width, height } = imagen;
  if (width > LADO_MAXIMO_PX || height > LADO_MAXIMO_PX) {
    if (width >= height) {
      height = Math.round(height * (LADO_MAXIMO_PX / width));
      width  = LADO_MAXIMO_PX;
    } else {
      width  = Math.round(width * (LADO_MAXIMO_PX / height));
      height = LADO_MAXIMO_PX;
    }
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // si el original tenía transparencia (ej. PNG), JPEG no la soporta
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(imagen, 0, 0, width, height);
  URL.revokeObjectURL(imagen.src);

  let ultimoBase64 = null;

  for (const calidad of CALIDADES) {
    const base64 = await new Promise(resolve => {
      canvas.toBlob(blob => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(blob);
      }, "image/jpeg", calidad);
    });

    ultimoBase64 = base64;
    const pesoKB = Math.round((base64.length * 0.75) / 1024);
    if (pesoKB <= PESO_OBJETIVO_KB) break; // ya entra cómodo, no hace falta seguir bajando calidad
  }

  return { base64: ultimoBase64, tipoMime: "image/jpeg" };
}

/** Handles the file picker: compresses the chosen image, then uploads it to Drive */
async function onSeleccionarArchivoImagenProducto(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const statusEl = document.getElementById("pmImagenStatus");

  if (!file.type.startsWith("image/")) {
    if (statusEl) { statusEl.className = "pm-image-status error"; statusEl.textContent = "Elegí un archivo de imagen (jpg, png, webp)."; }
    event.target.value = "";
    return;
  }

  // Tope de seguridad sobre el archivo original: una foto de celular normal
  // pesa 2-8MB. Más que esto probablemente sea un error de selección
  // (video, RAW, etc.) — se rechaza antes de gastar tiempo procesándolo.
  const TAMANO_ORIGINAL_MAXIMO_MB = 20;
  if (file.size > TAMANO_ORIGINAL_MAXIMO_MB * 1024 * 1024) {
    if (statusEl) { statusEl.className = "pm-image-status error"; statusEl.textContent = `⚠️ El archivo pesa demasiado (máx. ${TAMANO_ORIGINAL_MAXIMO_MB}MB). Elegí una foto más liviana.`; }
    event.target.value = "";
    return;
  }

  // Local preview inmediata, mientras se comprime y sube en segundo plano
  const localUrl = URL.createObjectURL(file);
  const preview = document.getElementById("pmImagenPreview");
  if (preview) preview.innerHTML = `<img src="${localUrl}" alt="">`;

  if (statusEl) { statusEl.className = "pm-image-status uploading"; statusEl.textContent = "⏳ Optimizando imagen..."; }

  try {
    const pesoOriginalKB = Math.round(file.size / 1024);
    const { base64, tipoMime } = await comprimirImagenProducto(file);
    const pesoFinalKB = Math.round((base64.length * 0.75) / 1024); // estimación: base64 pesa ~33% más que los bytes reales

    if (statusEl) {
      statusEl.className = "pm-image-status uploading";
      statusEl.textContent = pesoFinalKB < pesoOriginalKB
        ? `⏳ Subiendo a Drive... (${pesoOriginalKB}KB → ${pesoFinalKB}KB)`
        : "⏳ Subiendo a Drive...";
    }

    const codigoProducto = document.getElementById("pmCodigo").value.trim() || document.getElementById("pmCodigoOriginal").value.trim();

    const response = await fetchAPI(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight CORS contra Apps Script
      body: JSON.stringify({
        action: "subirImagenProducto",
        imagenBase64: base64,
        tipoMime: tipoMime,
        codigoProducto: codigoProducto
      })
    }, { timeoutMs: 40000 }); // las imágenes pesan más y tardan más en subir — no es una mutación chica

    const data = await response.json();

    if (!data.success) {
      if (statusEl) { statusEl.className = "pm-image-status error"; statusEl.textContent = "⚠️ " + (data.message || "No se pudo subir la imagen."); }
      return;
    }

    document.getElementById("pmImagen").value = data.url;
    if (statusEl) { statusEl.className = "pm-image-status success"; statusEl.textContent = `✓ Imagen subida (${pesoFinalKB}KB)`; }

  } catch (error) {
    console.error("Error al subir imagen de producto:", error);
    if (statusEl) { statusEl.className = "pm-image-status error"; statusEl.textContent = "⚠️ Error de conexión al subir la imagen."; }
  } finally {
    URL.revokeObjectURL(localUrl);
  }
}

/** Fills the category <datalist> with the distinct categories already in use */
function poblarCategoriasDatalist() {
  const datalist = document.getElementById("pmCategoriasList");
  if (!datalist) return;
  const categorias = [...new Set(
    productosAdminGlobal.map(p => String(p.CATEGORIA || "").trim()).filter(Boolean)
  )].sort();
  datalist.innerHTML = categorias.map(c => `<option value="${escapeHtml(c)}"></option>`).join("");
}

/** Saves the product form — creates a new product or updates an existing one */
async function guardarProductoForm() {
  const codigoOriginal = document.getElementById("pmCodigoOriginal").value.trim();
  const codigo   = document.getElementById("pmCodigo").value.trim();
  const nombre   = document.getElementById("pmNombre").value.trim();
  const categoria = document.getElementById("pmCategoria").value.trim();
  const precio   = document.getElementById("pmPrecio").value;
  const stock    = document.getElementById("pmStock").value;
  const imagen   = document.getElementById("pmImagen").value.trim();
  const publicado = document.getElementById("pmPublicado").checked ? "SI" : "NO";
  const destacado  = document.getElementById("pmDestacado").checked ? "SI" : "NO";
  const oferta     = document.getElementById("pmOferta").checked ? "SI" : "NO";

  const ventaPorCaja = document.getElementById("pmVentaPorCaja").checked;
  const codigoCaja = ventaPorCaja ? document.getElementById("pmCodigoCaja").value.trim() : "";
  const unidadesPorCaja = ventaPorCaja ? document.getElementById("pmUnidadesPorCaja").value : "";
  const precioCaja = ventaPorCaja ? document.getElementById("pmPrecioCaja").value : "";

  if (!nombre) { toast("El nombre del producto es obligatorio", "error"); return; }
  if (precio === "" || Number(precio) < 0) { toast("Ingresá un precio válido", "error"); return; }
  if (ventaPorCaja && (!codigoCaja || !unidadesPorCaja || Number(unidadesPorCaja) < 1 || precioCaja === "")) {
    toast("Completá código, unidades y precio de la caja (o desactivá la venta por caja)", "error");
    return;
  }

  const esEdicion = !!codigoOriginal;
  const btn = document.getElementById("btnGuardarProducto");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Guardando...";

  try {
    const params = new URLSearchParams({
      action: esEdicion ? "actualizarProducto" : "guardarProducto",
      CODIGO: codigo,
      PRODUCTO: nombre,
      CATEGORIA: categoria,
      PRECIO: precio || 0,
      STOCK: stock || 0,
      IMAGEN: imagen,
      PUBLICADO: publicado,
      DESTACADO: destacado,
      OFERTA: oferta,
      CODIGO_CAJA: codigoCaja,
      UNIDADES_POR_CAJA: unidadesPorCaja || 0,
      PRECIO_CAJA: precioCaja || 0
    });
    if (esEdicion) params.set("codigoOriginal", codigoOriginal);

    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar el producto", "error");
      return;
    }

    toast(esEdicion ? "Producto actualizado" : "Producto creado", "success");
    cerrarModalProducto();
    cargarProductos();

    // Refresh in-memory POS catalog too, so the new/edited product shows up right away
    productosPOS = [];

  } catch (error) {
    console.error("Error al guardar producto:", error);
    toast("Error de conexión al guardar el producto", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

/** Deletes a product after confirmation */
/**
 * Pide confirmación con modal propio antes de eliminar un producto.
 * IMPORTANTE: antes esto usaba window.confirm(), pero confirm()/alert()
 * son diálogos nativos síncronos que, en Electron, pueden dejar el
 * foco de teclado roto en la ventana después de cerrarse — el input
 * de texto deja de responder hasta recargar. Por eso en todo el panel
 * se usa este patrón de modal propio en vez de confirm() nativo.
 */
function eliminarProducto(codigo) {
  window._codigoProductoParaEliminar = codigo;

  const backdrop = document.getElementById("modalEliminarProdBackdrop");
  const texto = document.getElementById("modalEliminarProdTexto");
  if (texto) texto.textContent = `¿Eliminar el producto "${codigo}"? Esta acción no se puede deshacer.`;
  if (backdrop) backdrop.classList.add("show");
}

function cerrarModalEliminarProd() {
  const backdrop = document.getElementById("modalEliminarProdBackdrop");
  if (backdrop) backdrop.classList.remove("show");
  window._codigoProductoParaEliminar = null;
}

async function eliminarProductoForm() {
  const codigo = window._codigoProductoParaEliminar;
  cerrarModalEliminarProd();
  if (!codigo) return;

  try {
    const params = new URLSearchParams({ action: "eliminarProducto", codigo });
    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo eliminar el producto", "error");
      return;
    }

    toast("Producto eliminado", "success");
    cargarProductos();
    productosPOS = [];

  } catch (error) {
    console.error("Error al eliminar producto:", error);
    toast("Error de conexión al eliminar el producto", "error");
  }
}

/* ===================== CLIENTES ===================== */

let clientesGlobal = [];
let _avisoClientesCaido = false; // evita repetir el toast de error de conexión en cada ciclo del polling

/** Refresca manualmente la tabla de clientes desde el backend, con feedback visual en el botón */
async function actualizarClientesForm() {
  const btn = document.getElementById("btnActualizarClientes");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Actualizando...";

  try {
    invalidarCache("clientes"); // forzar datos frescos, no la copia cacheada
    await cargarClientesDesdeBackend();
    toast("Clientes actualizados", "success");
  } catch (error) {
    console.error("Error al actualizar clientes:", error);
    toast("Error de conexión al actualizar", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

async function cargarClientesDesdeBackend() {
  const cached = cacheGet("clientes");
  if (cached) {
    clientesGlobal = cached.data;
    filtrarClientes();
    if (!cached.stale) return;
  }
  try {
    const response = await fetchAPI(API_URL + "?action=clientesConCredito");
    const data = await response.json();
    if (!data.clientes) return;
    clientesGlobal = data.clientes;
    cacheSet("clientes", clientesGlobal);
    _avisoClientesCaido = false; // se pudo actualizar bien — resetea el aviso para el próximo corte
    filtrarClientes();
  } catch (error) {
    console.error("Error clientes:", error);
    if (!_avisoClientesCaido) {
      toast("No se pudieron actualizar los clientes — revisá tu conexión", "error");
      _avisoClientesCaido = true;
    }
  }
}

// Cache separado para el selector de pedidos (incluye dirección y todos los campos)
let _clientesPedidoCache = [];
async function cargarClientesParaPedido() {
  if (_clientesPedidoCache.length > 0) return _clientesPedidoCache;
  try {
    const response = await fetchAPI(API_URL + "?action=todosClientes");
    const data = await response.json();
    _clientesPedidoCache = data.clientes || [];
    return _clientesPedidoCache;
  } catch (e) {
    return [];
  }
}

let _renderGenClientes = 0; // mismo guard que en Productos/Pedidos: evita que un render viejo escriba encima de uno nuevo

function renderTablaClientes(lista) {
  const cont = document.getElementById("tablaClientes");
  if (!cont) return;

  const miGen = ++_renderGenClientes;

  if (!lista || lista.length === 0) {
    cont.innerHTML = `<div class="text-center text-muted py-5" style="font-size:14px;">No se encontraron clientes</div>`;
    return;
  }

  // Render en chunks para no congelar con listas grandes
  const CHUNK_CLI = 25;
  let idxCli = 0;
  cont.innerHTML = "";
  const renderChunkCli = () => {
    if (miGen !== _renderGenClientes) return; // superado por un render más nuevo
    const frag = document.createDocumentFragment();
    const fin = Math.min(idxCli + CHUNK_CLI, lista.length);
    for (; idxCli < fin; idxCli++) {
      const c = lista[idxCli];
    const esCredito = String(c.A_CREDITO || "").toUpperCase() === "SI";
    const saldoArs = Number(c.SALDO_PENDIENTE_ARS || 0);
    const saldoUsd = Number(c.SALDO_PENDIENTE_USD || 0);
    const tieneSaldo = esCredito && (saldoArs > 0 || saldoUsd > 0);

    // Borde color: rojo si tiene deuda, verde si es crédito sin deuda, azul por defecto
    const bordeClase = tieneSaldo ? "cliente-card-deuda" : (esCredito ? "cliente-card-credito" : "");

    // Saldo
    let saldoHtml = "";
    if (esCredito) {
      const partes = [];
      if (saldoArs > 0) partes.push(`<span style="color:var(--red-500);font-weight:700;">$${saldoArs.toLocaleString("es-AR")}</span>`);
      if (saldoUsd > 0) partes.push(`<span style="color:var(--red-500);font-weight:700;">US$${saldoUsd.toLocaleString("es-AR")}</span>`);
      saldoHtml = partes.length > 0
        ? `<span class="cliente-dato-label">Saldo</span> ${partes.join(" · ")}`
        : `<span class="cliente-dato-label">Saldo</span> <span class="text-muted" style="font-size:12px;">Sin deuda</span>`;
    }

    const botones = c.CLIENTE_ID
      ? `<button class="btn btn-outline-secondary btn-sm" onclick="abrirModalDetalleCliente('${escapeHtml(c.CLIENTE_ID)}')">Ver cuenta</button>
         <button class="btn btn-warning btn-sm" onclick="abrirModalDeudaExtraDirecto('${escapeHtml(c.CLIENTE_ID)}', '${escapeHtml(c.NOMBRE || c.CLIENTE)}')">+ Deuda</button>
         <button class="btn btn-primary btn-sm" onclick="abrirModalEditarCliente('${escapeHtml(c.CLIENTE_ID)}')">Editar</button>
         <button class="btn btn-danger btn-sm" onclick="eliminarClienteForm('${escapeHtml(c.CLIENTE_ID)}', '${escapeHtml(c.NOMBRE)}')">Eliminar</button>`
      : `<button class="btn btn-outline-success btn-sm" onclick="marcarClienteDesdeHistorialACredito('${escapeHtml(c.DNI)}')">Marcar a crédito</button>`;

      const cardHtml = `
    <div class="pedido-card ${bordeClase}">
      <div class="pedido-card-top">
        <div style="flex:1; min-width:0;">
          <div class="pedido-card-id">${escapeHtml(c.DNI || "")}</div>
          <div class="pedido-card-cliente">
            ${escapeHtml(c.NOMBRE || c.CLIENTE)}
            ${c.ALIAS ? `<span style="font-weight:500;color:var(--slate-500);font-size:13px;">· ${escapeHtml(c.ALIAS)}</span>` : ""}
          </div>
          <div class="pedido-card-dir" style="margin-top:4px; display:flex; flex-wrap:wrap; gap:10px;">
            ${c.EMPRESA   ? `<span>🚚 ${escapeHtml(c.EMPRESA)}</span>` : ""}
            ${c.TELEFONO  ? `<span>📞 ${escapeHtml(c.TELEFONO)}</span>` : ""}
            ${c.DIRECCION ? `<span>📍 ${escapeHtml(c.DIRECCION)}</span>` : ""}
          </div>
        </div>
        <div class="text-end" style="flex-shrink:0;">
          <div class="pedido-card-total" style="font-size:15px;">$${Number(c.TOTAL_COMPRADO || c.TOTAL || 0).toLocaleString("es-AR")}</div>
          <div style="font-size:11px;color:var(--slate-500);margin-top:1px;">${c.PEDIDOS || 0} pedido${c.PEDIDOS !== 1 ? "s" : ""}</div>
          <div class="mt-1">
            ${esCredito
              ? `<span class="pedido-estado-badge preparando">A crédito</span>`
              : `<span class="pedido-estado-badge" style="background:var(--slate-100);color:var(--slate-500);">Contado</span>`}
          </div>
          ${tieneSaldo ? `<div class="mt-1" style="font-size:12px;">${saldoHtml}</div>` : ""}
        </div>
      </div>
      <div class="pedido-card-controls">
        ${botones}
      </div>
    </div>`;
      const div = document.createElement("div");
      div.innerHTML = cardHtml;
      frag.appendChild(div.firstElementChild);
    }
    cont.appendChild(frag);
    if (idxCli < lista.length) requestAnimationFrame(renderChunkCli);
  };
  requestAnimationFrame(renderChunkCli);
}

/** Filters the already-loaded client list by name, alias, empresa, or DNI — no new backend call. Also applies the "solo crédito" checkbox. */
function filtrarClientes() {
  const input = document.getElementById("buscarCliente");
  const soloCredito = document.getElementById("filtroSoloCredito");
  const termino = (input ? input.value : "").toLowerCase().trim();

  let filtrados = clientesGlobal;

  if (termino) {
    filtrados = filtrados.filter(c => {
      const nombre = String(c.NOMBRE || c.CLIENTE || "").toLowerCase();
      const alias = String(c.ALIAS || "").toLowerCase();
      const empresa = String(c.EMPRESA || "").toLowerCase();
      const dni = String(c.DNI || "").toLowerCase();
      return nombre.includes(termino) || alias.includes(termino) || empresa.includes(termino) || dni.includes(termino);
    });
  }

  if (soloCredito && soloCredito.checked) {
    filtrados = filtrados.filter(c => String(c.A_CREDITO || "").toUpperCase() === "SI");
  }

  renderTablaClientes(filtrados);
}

/**
 * Wrapper público: mantiene el nombre que ya usan el menú y el timer de
 * fondo, pero evita pedir de nuevo al backend si se llamó hace menos de
 * VENCIMIENTO_CACHE_MS (ej: el cajero entra y sale de Clientes seguido).
 */
function cargarClientes() {
  cargarSiVencido("clientes", cargarClientesDesdeBackend);
}

/* ===================== CLIENTES — ALTA Y CRÉDITO ===================== */

function abrirModalNuevoCliente() {
  document.getElementById("clClienteIdEditando").value = "";
  document.getElementById("clienteModalTitulo").textContent = "+ Nuevo Cliente";
  document.getElementById("clACreditoWrap").style.display = "block";
  document.getElementById("clNombre").value = "";
  document.getElementById("clAlias").value = "";
  document.getElementById("clDni").value = "";
  document.getElementById("clTelefono").value = "";
  document.getElementById("clEmpresa").value = "";
  document.getElementById("clDireccion").value = "";
  document.getElementById("clACredito").checked = false;
  document.getElementById("clienteModalBackdrop").classList.add("show");
}

/** Opens the same client modal, pre-filled for editing — now also shows the "a crédito" checkbox, pre-checked with the client's current value, so it can be toggled directly from here */
function abrirModalEditarCliente(clienteId) {
  const cliente = clientesGlobal.find(c => String(c.CLIENTE_ID) === String(clienteId));
  if (!cliente) { toast("No se encontró el cliente", "error"); return; }

  document.getElementById("clClienteIdEditando").value = clienteId;
  document.getElementById("clienteModalTitulo").textContent = "✏️ Editar Cliente";
  document.getElementById("clACreditoWrap").style.display = "block";
  document.getElementById("clNombre").value = cliente.NOMBRE || "";
  document.getElementById("clAlias").value = cliente.ALIAS || "";
  document.getElementById("clDni").value = cliente.DNI || "";
  document.getElementById("clTelefono").value = cliente.TELEFONO || "";
  document.getElementById("clEmpresa").value = cliente.EMPRESA || "";
  document.getElementById("clDireccion").value = cliente.DIRECCION || "";
  document.getElementById("clACredito").checked = String(cliente.A_CREDITO || "").toUpperCase() === "SI";
  document.getElementById("clienteModalBackdrop").classList.add("show");
}

function cerrarModalNuevoCliente() {
  document.getElementById("clienteModalBackdrop").classList.remove("show");
}

let guardandoCliente = false;

async function guardarNuevoCliente() {
  if (guardandoCliente) return; // evita doble click mientras la petición anterior sigue en vuelo
  guardandoCliente = true;

  const nombre = document.getElementById("clNombre").value.trim();
  if (!nombre) {
    toast("Ingresá el nombre del cliente", "error");
    guardandoCliente = false;
    return;
  }

  const clienteIdEditando = document.getElementById("clClienteIdEditando").value.trim();
  const editando = !!clienteIdEditando;

  const btn = document.getElementById("btnGuardarNuevoCliente");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Guardando...";

  try {
    const cuerpo = editando
      ? {
          action: "editarCliente",
          clienteId: clienteIdEditando,
          nombre,
          alias: document.getElementById("clAlias").value.trim(),
          dni: document.getElementById("clDni").value.trim(),
          telefono: document.getElementById("clTelefono").value.trim(),
          empresa: document.getElementById("clEmpresa").value.trim(),
          direccion: document.getElementById("clDireccion").value.trim(),
          aCredito: document.getElementById("clACredito").checked ? "SI" : "NO"
        }
      : {
          action: "crearCliente",
          nombre,
          alias: document.getElementById("clAlias").value.trim(),
          dni: document.getElementById("clDni").value.trim(),
          telefono: document.getElementById("clTelefono").value.trim(),
          empresa: document.getElementById("clEmpresa").value.trim(),
          direccion: document.getElementById("clDireccion").value.trim(),
          aCredito: document.getElementById("clACredito").checked ? "SI" : "NO"
        };

    const response = await fetchAPI(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(cuerpo)
    });
    const data = await response.json();

    if (!data.success) {
      toast(data.message || (editando ? "No se pudo editar el cliente" : "No se pudo crear el cliente"), "error");
      return;
    }

    toast(editando ? "Cliente actualizado" : "Cliente creado", "success");
    cerrarModalNuevoCliente();
    invalidarCache("clientes"); // si no, la caché de 5 min sigue mostrando el dato viejo
    await cargarClientesDesdeBackend();

  } catch (error) {
    console.error("Error al crear cliente:", error);
    toast("Error de conexión al crear el cliente", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
    guardandoCliente = false;
  }
}

/** Used from the "Marcar a crédito" button on a client that only exists in the PEDIDOS-derived ranking (not yet in CLIENTES) */
async function marcarClienteDesdeHistorialACredito(dni) {
  /* confirm eliminado — acción creando un cliente nuevo, recuperable */

  try {
    const response = await fetchAPI(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "crearClienteDesdeHistorialYMarcarCredito", dni })
    });
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo marcar a crédito", "error");
      return;
    }

    toast("Cliente marcado a crédito", "success");
    invalidarCache("clientes");
    cargarClientesDesdeBackend();

  } catch (error) {
    console.error("Error al marcar cliente a crédito:", error);
    toast("Error de conexión", "error");
  }
}

/** Deletes a client — only removes the CLIENTES row, never touches their past PEDIDOS or PAGOS_CREDITO history */
async function eliminarClienteForm(clienteId, nombre) {
  const cliente = clientesGlobal.find(c => String(c.CLIENTE_ID) === String(clienteId));
  const tieneSaldo = cliente && (Number(cliente.SALDO_PENDIENTE_ARS || 0) > 0 || Number(cliente.SALDO_PENDIENTE_USD || 0) > 0);

  const mensaje = tieneSaldo
    ? `⚠️ "${nombre}" todavía tiene saldo pendiente. ¿Eliminar igual su ficha de cliente? (sus pedidos y pagos pasados NO se borran, solo deja de aparecer en esta lista como cliente)`
    : `¿Eliminar al cliente "${nombre}"? Sus pedidos y pagos pasados no se borran, solo su ficha de cliente.`;

  /* confirm eliminado */

  try {
    const response = await fetchAPI(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ action: "eliminarCliente", clienteId })
    });
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo eliminar el cliente", "error");
      return;
    }

    toast("Cliente eliminado", "success");
    invalidarCache("clientes");
    cargarClientesDesdeBackend();

  } catch (error) {
    console.error("Error al eliminar cliente:", error);
    toast("Error de conexión al eliminar el cliente", "error");
  }
}

let detalleClienteDatosActuales = null;

async function abrirModalDetalleCliente(clienteId) {
  document.getElementById("detalleClienteModalBackdrop").classList.add("show");
  document.getElementById("detalleClienteNombre").textContent = "Cargando...";
  document.getElementById("pagoMonto").value = "";
  document.getElementById("pagoObservaciones").value = "";
  document.getElementById("pagoMonedaPago").value = "ARS";
  document.getElementById("pagoPrioridad").value = "ARS";
  document.getElementById("pagoTipoCambio").value = "";
  document.getElementById("pagoTipoCambioWrap").style.display = "none";
  const btnPago = document.getElementById("btnRegistrarPago");
  if (btnPago) { btnPago.disabled = false; btnPago.textContent = "💾 Registrar pago"; }
  detalleClienteIdActual = clienteId;

  try {
    const response = await fetchAPI(API_URL + "?action=detalleClienteCredito&clienteId=" + encodeURIComponent(clienteId));
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo cargar el cliente", "error");
      cerrarModalDetalleCliente();
      return;
    }

    detalleClienteDatosActuales = data;

    document.getElementById("detalleClienteNombre").textContent =
      data.cliente.ALIAS ? `${data.cliente.NOMBRE} (${data.cliente.ALIAS})` : data.cliente.NOMBRE;

    const esCredito = String(data.cliente.A_CREDITO || "").toUpperCase() === "SI";

    document.getElementById("cardAvisoNoCredito").style.display = esCredito ? "none" : "block";
    document.getElementById("cardFormularioPago").style.display = esCredito ? "block" : "none";

    if (esCredito) {
      // Cliente a crédito: los números son una deuda real, vienen
      // calculados del backend (ya restan los pagos registrados).
      document.getElementById("detalleClienteTotalCompradoArs").textContent = "$" + Number(data.totalCompradoArs).toLocaleString("es-AR");
      document.getElementById("detalleClienteTotalPagadoArs").textContent = "$" + Number(data.totalPagadoArs).toLocaleString("es-AR");
      document.getElementById("detalleClienteSaldoArs").textContent = "$" + Number(data.saldoPendienteArs).toLocaleString("es-AR");

      document.getElementById("detalleClienteTotalCompradoUsd").textContent = "US$" + Number(data.totalCompradoUsd).toLocaleString("es-AR");
      document.getElementById("detalleClienteTotalPagadoUsd").textContent = "US$" + Number(data.totalPagadoUsd).toLocaleString("es-AR");
      document.getElementById("detalleClienteSaldoUsd").textContent = "US$" + Number(data.saldoPendienteUsd).toLocaleString("es-AR");
    } else {
      // Cliente NO a crédito: sus pedidos fueron compras al contado.
      // El total comprado es solo informativo (no es deuda), y el
      // saldo pendiente siempre es $0 — nunca debe nada.
      let totalArsInformativo = 0, totalUsdInformativo = 0;
      (data.pedidos || []).forEach(p => {
        if (String(p.MONEDA || "ARS").toUpperCase() === "USD") totalUsdInformativo += Number(p.TOTAL || 0);
        else totalArsInformativo += Number(p.TOTAL || 0);
      });

      document.getElementById("detalleClienteTotalCompradoArs").textContent = "$" + totalArsInformativo.toLocaleString("es-AR");
      document.getElementById("detalleClienteTotalPagadoArs").textContent = "$" + totalArsInformativo.toLocaleString("es-AR");
      document.getElementById("detalleClienteSaldoArs").textContent = "$0";

      document.getElementById("detalleClienteTotalCompradoUsd").textContent = "US$" + totalUsdInformativo.toLocaleString("es-AR");
      document.getElementById("detalleClienteTotalPagadoUsd").textContent = "US$" + totalUsdInformativo.toLocaleString("es-AR");
      document.getElementById("detalleClienteSaldoUsd").textContent = "US$0";
    }

    const pedidosTbody = document.getElementById("detalleClientePedidosTabla");
    pedidosTbody.innerHTML = data.pedidos.length === 0
      ? `<tr><td colspan="4" class="text-center text-muted">Sin pedidos</td></tr>`
      : data.pedidos.map(p => {
          const moneda = String(p.MONEDA || "ARS").toUpperCase();
          const simbolo = moneda === "USD" ? "US$" : "$";
          return `
          <tr>
            <td>${p.FECHA ? new Date(p.FECHA).toLocaleDateString("es-AR") : "—"}</td>
            <td class="money">${simbolo}${Number(p.TOTAL || 0).toLocaleString("es-AR")}</td>
            <td>${moneda}${moneda === "USD" && p.TIPO_CAMBIO ? ` (TC ${p.TIPO_CAMBIO})` : ""}</td>
            <td>${escapeHtml(p.ESTADO || "")}</td>
          </tr>`;
        }).join("");

    const pagosTbody = document.getElementById("detalleClientePagosTabla");
    pagosTbody.innerHTML = data.pagos.length === 0
      ? `<tr><td colspan="6" class="text-center text-muted">Sin pagos registrados todavía</td></tr>`
      : data.pagos.map(pago => `
          <tr>
            <td>${pago.FECHA ? new Date(pago.FECHA).toLocaleDateString("es-AR") : "—"}</td>
            <td class="money">${String(pago.MONEDA_PAGO || "ARS").toUpperCase() === "USD" ? "US$" : "$"}${Number(pago.MONTO_PAGO || 0).toLocaleString("es-AR")}</td>
            <td class="money">${Number(pago.MONTO_APLICADO_ARS || 0) > 0 ? "$" + Number(pago.MONTO_APLICADO_ARS).toLocaleString("es-AR") : "—"}</td>
            <td class="money">${Number(pago.MONTO_APLICADO_USD || 0) > 0 ? "US$" + Number(pago.MONTO_APLICADO_USD).toLocaleString("es-AR") : "—"}</td>
            <td>${escapeHtml(pago.FORMA_PAGO || "")}</td>
            <td>${escapeHtml(pago.OBSERVACIONES || "")}</td>
          </tr>`).join("");

    // Deudas extra
    const deudasExtra = data.deudasExtra || [];
    const deudasWrap = document.getElementById("deudaExtraTablaWrap");
    const deudasTbody = document.getElementById("detalleClienteDeudasExtraTabla");
    if (deudasExtra.length > 0) {
      deudasWrap.style.display = "block";
      deudasTbody.innerHTML = deudasExtra.map(d => {
        const simbolo = String(d.MONEDA || "ARS").toUpperCase() === "USD" ? "US$" : "$";
        return `<tr>
          <td>${d.FECHA ? new Date(d.FECHA).toLocaleDateString("es-AR") : "—"}</td>
          <td>${escapeHtml(String(d.MONEDA || "ARS").toUpperCase())}</td>
          <td class="money">${simbolo}${Number(d.MONTO || 0).toLocaleString("es-AR")}</td>
          <td>${escapeHtml(d.CONCEPTO || "")}</td>
        </tr>`;
      }).join("");
    } else {
      deudasWrap.style.display = "none";
    }

  } catch (error) {
    console.error("Error al cargar el detalle del cliente:", error);
    toast("Error de conexión al cargar el cliente", "error");
  }
}

function cerrarModalDetalleCliente() {
  document.getElementById("detalleClienteModalBackdrop").classList.remove("show");
  detalleClienteIdActual = null;
  detalleClienteDatosActuales = null;
}

let deudaExtraClienteId = null;

function abrirModalDeudaExtraDirecto(clienteId, nombre) {
  deudaExtraClienteId = clienteId;
  document.getElementById("deudaExtraModalNombre").textContent = nombre;
  document.getElementById("deudaExtraModalMonto").value = "";
  document.getElementById("deudaExtraModalMoneda").value = "ARS";
  document.getElementById("deudaExtraModalConcepto").value = "";
  const btnDeuda = document.getElementById("btnRegistrarDeudaExtra");
  if (btnDeuda) { btnDeuda.disabled = false; btnDeuda.textContent = "💾 Registrar deuda"; }
  document.getElementById("deudaExtraModalBackdrop").classList.add("show");
  setTimeout(() => document.getElementById("deudaExtraModalMonto").focus(), 100);
}

function cerrarModalDeudaExtra() {
  document.getElementById("deudaExtraModalBackdrop").classList.remove("show");
  deudaExtraClienteId = null;
}

async function registrarDeudaExtraForm() {
  if (!deudaExtraClienteId) return;

  const monto = Number(document.getElementById("deudaExtraModalMonto").value);
  if (!monto || monto <= 0) { toast("Ingresá un monto válido", "error"); return; }

  const moneda = document.getElementById("deudaExtraModalMoneda").value;
  const concepto = document.getElementById("deudaExtraModalConcepto").value.trim();
  if (!concepto) { toast("El concepto es obligatorio", "error"); return; }

  const btn = document.getElementById("btnRegistrarDeudaExtra");
  if (btn) { btn.disabled = true; btn.textContent = "Registrando..."; }

  try {
    const response = await fetchAPI(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "crearDeudaExtra",
        clienteId: deudaExtraClienteId,
        monto,
        moneda,
        concepto
      })
    });
    const data = await response.json();
    if (!data.success) {
      toast(data.message || "No se pudo registrar la deuda", "error");
      if (btn) { btn.disabled = false; btn.textContent = "💾 Registrar deuda"; }
      return;
    }
    toast("Deuda registrada correctamente", "success");
    cerrarModalDeudaExtra();
    invalidarCache("clientes");
    cargarClientesDesdeBackend();
  } catch (error) {
    console.error("Error al registrar deuda extra:", error);
    toast("Error de conexión al registrar la deuda", "error");
    if (btn) { btn.disabled = false; btn.textContent = "💾 Registrar deuda"; }
  }
}

function toggleFormDeudaExtra() {
  const form = document.getElementById("deudaExtraForm");
  const icon = document.getElementById("deudaExtraToggleIcon");
  const visible = form.style.display !== "none";
  form.style.display = visible ? "none" : "block";
  icon.textContent = visible ? "▼ Expandir" : "▲ Cerrar";
}

/** Shows the exchange-rate field only when the payment currency and the priority currency differ — that's the only case where a conversion is actually needed */
function actualizarVisibilidadTipoCambioPago() {
  const monedaPago = document.getElementById("pagoMonedaPago").value;
  const prioridad = document.getElementById("pagoPrioridad").value;
  document.getElementById("pagoTipoCambioWrap").style.display = monedaPago !== prioridad ? "block" : "none";
}

async function registrarPagoCreditoForm() {
  if (!detalleClienteIdActual) return;

  const monto = Number(document.getElementById("pagoMonto").value);
  if (!monto || monto <= 0) { toast("Ingresá un monto válido", "error"); return; }

  const monedaPago = document.getElementById("pagoMonedaPago").value;
  const prioridad = document.getElementById("pagoPrioridad").value;
  const tipoCambio = document.getElementById("pagoTipoCambio").value.trim();

  if (monedaPago !== prioridad && (!tipoCambio || Number(tipoCambio) <= 0)) {
    toast("Ingresá el tipo de cambio para convertir entre pesos y dólares", "error");
    return;
  }

  const btn = document.getElementById("btnRegistrarPago");
  if (btn) { btn.disabled = true; btn.textContent = "Registrando..."; }

  try {
    const response = await fetchAPI(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action: "registrarPagoCredito",
        clienteId: detalleClienteIdActual,
        monto,
        monedaPago,
        prioridad,
        tipoCambio: tipoCambio || "",
        formaPago: document.getElementById("pagoFormaPago").value,
        observaciones: document.getElementById("pagoObservaciones").value.trim(),
        cajero: (sessionStorage.getItem("vendedor") || "ADMIN")
      })
    });
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo registrar el pago", "error");
      if (btn) { btn.disabled = false; btn.textContent = "💾 Registrar pago"; }
      return;
    }

    toast("Pago registrado", "success");
    // Invalidar caché para que cierre de caja, movimientos y la lista
    // de clientes (saldo actualizado) muestren datos frescos
    const hoy = new Date().toISOString().slice(0, 10);
    try { localStorage.removeItem("vpos_cache_movimientos_" + hoy); } catch(e) {}
    try { localStorage.removeItem("vpos_cache_cierre_" + hoy); } catch(e) {}
    try { localStorage.removeItem("vpos_cache_cierre_ayer"); } catch(e) {}
    invalidarCache("clientes");
    abrirModalDetalleCliente(detalleClienteIdActual);
    cargarClientesDesdeBackend();

  } catch (error) {
    console.error("Error al registrar el pago:", error);
    toast("Error de conexión al registrar el pago", "error");
    if (btn) { btn.disabled = false; btn.textContent = "💾 Registrar pago"; }
  }
}

let detalleClienteIdActual = null;

/**
 * Genera un informe A4 (no térmico) con el resumen de cuenta del
 * cliente que está abierto en el modal de detalle — saldos por
 * moneda, detalle de pedidos, y detalle de pagos. Reutiliza
 * #etiquetasPrintArea, el mismo contenedor que ya usa el sistema
 * para imprimir en A4 (las etiquetas de producto usan el mismo
 * mecanismo, ver imprimirEtiquetas).
 */
function imprimirInformeCliente() {
  if (!detalleClienteDatosActuales) { toast("Esperá a que termine de cargar el cliente", "error"); return; }

  const data = detalleClienteDatosActuales;
  const cliente = data.cliente;
  const fechaHoy = new Date().toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit", year: "numeric" });

  const filasPedidos = data.pedidos.length === 0
    ? `<tr><td colspan="4" style="text-align:center; color:#888;">Sin pedidos</td></tr>`
    : data.pedidos.map(p => {
        const moneda = String(p.MONEDA || "ARS").toUpperCase();
        const simbolo = moneda === "USD" ? "US$" : "$";
        return `<tr>
          <td>${p.FECHA ? new Date(p.FECHA).toLocaleDateString("es-AR") : "—"}</td>
          <td style="text-align:right;">${simbolo}${Number(p.TOTAL || 0).toLocaleString("es-AR")}</td>
          <td>${moneda}</td>
          <td>${escapeHtml(p.ESTADO || "")}</td>
        </tr>`;
      }).join("");

  const filasPagos = data.pagos.length === 0
    ? `<tr><td colspan="5" style="text-align:center; color:#888;">Sin pagos registrados</td></tr>`
    : data.pagos.map(pago => `<tr>
        <td>${pago.FECHA ? new Date(pago.FECHA).toLocaleDateString("es-AR") : "—"}</td>
        <td style="text-align:right;">${String(pago.MONEDA_PAGO || "ARS").toUpperCase() === "USD" ? "US$" : "$"}${Number(pago.MONTO_PAGO || 0).toLocaleString("es-AR")}</td>
        <td style="text-align:right;">${Number(pago.MONTO_APLICADO_ARS || 0) > 0 ? "$" + Number(pago.MONTO_APLICADO_ARS).toLocaleString("es-AR") : "—"}</td>
        <td style="text-align:right;">${Number(pago.MONTO_APLICADO_USD || 0) > 0 ? "US$" + Number(pago.MONTO_APLICADO_USD).toLocaleString("es-AR") : "—"}</td>
        <td>${escapeHtml(pago.FORMA_PAGO || "")}</td>
      </tr>`).join("");

  const html = `
    <div style="font-family:Arial, sans-serif; color:#1a1a1a; padding:10mm;">
      <h2 style="margin:0 0 4px;">${escapeHtml((configNegocioCache && configNegocioCache.nombre) || "Informe de cuenta")}</h2>
      <div style="color:#666; font-size:12px; margin-bottom:18px;">Informe de cuenta corriente — generado el ${fechaHoy}</div>

      <div style="border:1px solid #ddd; border-radius:8px; padding:12px 16px; margin-bottom:18px;">
        <strong>${escapeHtml(cliente.NOMBRE)}</strong>${cliente.ALIAS ? ` (${escapeHtml(cliente.ALIAS)})` : ""}<br>
        ${cliente.DNI ? `DNI/CUIT: ${escapeHtml(cliente.DNI)}<br>` : ""}
        ${cliente.TELEFONO ? `Tel: ${escapeHtml(cliente.TELEFONO)}<br>` : ""}
        ${cliente.DIRECCION ? `Dirección: ${escapeHtml(cliente.DIRECCION)}` : ""}
      </div>

      <table style="width:100%; border-collapse:collapse; margin-bottom:18px;">
        <tr style="background:#f4f4f4;">
          <th style="padding:8px; text-align:left; border:1px solid #ddd;"></th>
          <th style="padding:8px; text-align:right; border:1px solid #ddd;">Comprado</th>
          <th style="padding:8px; text-align:right; border:1px solid #ddd;">Pagado</th>
          <th style="padding:8px; text-align:right; border:1px solid #ddd;">Saldo</th>
        </tr>
        <tr>
          <td style="padding:8px; border:1px solid #ddd;"><strong>Pesos (ARS)</strong></td>
          <td style="padding:8px; text-align:right; border:1px solid #ddd;">$${Number(data.totalCompradoArs).toLocaleString("es-AR")}</td>
          <td style="padding:8px; text-align:right; border:1px solid #ddd;">$${Number(data.totalPagadoArs).toLocaleString("es-AR")}</td>
          <td style="padding:8px; text-align:right; border:1px solid #ddd; font-weight:bold;">$${Number(data.saldoPendienteArs).toLocaleString("es-AR")}</td>
        </tr>
        <tr>
          <td style="padding:8px; border:1px solid #ddd;"><strong>Dólares (USD)</strong></td>
          <td style="padding:8px; text-align:right; border:1px solid #ddd;">US$${Number(data.totalCompradoUsd).toLocaleString("es-AR")}</td>
          <td style="padding:8px; text-align:right; border:1px solid #ddd;">US$${Number(data.totalPagadoUsd).toLocaleString("es-AR")}</td>
          <td style="padding:8px; text-align:right; border:1px solid #ddd; font-weight:bold;">US$${Number(data.saldoPendienteUsd).toLocaleString("es-AR")}</td>
        </tr>
      </table>

      <h4 style="margin:0 0 8px;">Pedidos</h4>
      <table style="width:100%; border-collapse:collapse; margin-bottom:18px; font-size:13px;">
        <tr style="background:#f4f4f4;">
          <th style="padding:6px; text-align:left; border:1px solid #ddd;">Fecha</th>
          <th style="padding:6px; text-align:right; border:1px solid #ddd;">Total</th>
          <th style="padding:6px; text-align:left; border:1px solid #ddd;">Moneda</th>
          <th style="padding:6px; text-align:left; border:1px solid #ddd;">Estado</th>
        </tr>
        ${filasPedidos}
      </table>

      <h4 style="margin:0 0 8px;">Pagos</h4>
      <table style="width:100%; border-collapse:collapse; font-size:13px;">
        <tr style="background:#f4f4f4;">
          <th style="padding:6px; text-align:left; border:1px solid #ddd;">Fecha</th>
          <th style="padding:6px; text-align:right; border:1px solid #ddd;">Pago</th>
          <th style="padding:6px; text-align:right; border:1px solid #ddd;">Aplicado ARS</th>
          <th style="padding:6px; text-align:right; border:1px solid #ddd;">Aplicado USD</th>
          <th style="padding:6px; text-align:left; border:1px solid #ddd;">Forma</th>
        </tr>
        ${filasPagos}
      </table>
    </div>
  `;

  document.getElementById("etiquetasPrintArea").innerHTML = html;

  setTimeout(() => {
    window.print();
  }, 100);
}

/**
 * Imprime una etiqueta de envío A4 para un pedido en estado PREPARANDO.
 * Usa el mismo #etiquetasPrintArea que el resto de las impresiones A4.
 * Incluye un código de barras Code128 con el número de pedido, generado
 * con JsBarcode (ya cargado en el panel).
 */
function imprimirEtiquetaEnvio(datos) {
  const { pedidoId, cliente, telefono, direccion, localidad, provincia, codigoPostal, dni, transporte } = datos;

  const cpStr = codigoPostal ? `  CP:${codigoPostal}` : "";
  const localidadStr = [localidad, cpStr].filter(Boolean).join("").trim();

  const html = `
    <div style="
      font-family: Arial, Helvetica, sans-serif;
      width: 190mm;
      min-height: 130mm;
      margin: 10mm auto;
      padding: 8mm;
      box-sizing: border-box;
      border: 2px solid #000;
      border-radius: 4mm;
      page-break-inside: avoid;
    ">

      <!-- Franja frágil / cabecera -->
      <div style="background:#d32f2f; color:#fff; text-align:center; padding:6mm 4mm; border-radius:2mm; margin-bottom:6mm;">
        <div style="font-size:18pt; font-weight:900; letter-spacing:2px; text-transform:uppercase;">POR FAVOR</div>
        <div style="font-size:11pt; font-weight:700; letter-spacing:4px; text-transform:uppercase;">MANEJESE CON CUIDADO</div>
        <div style="font-size:26pt; font-weight:900; letter-spacing:6px; margin:4px 0;">FRAGIL</div>
        <div style="font-size:11pt; font-weight:700; letter-spacing:3px;">== GRACIAS ==</div>
      </div>

      <!-- Datos del destinatario -->
      <table style="width:100%; border-collapse:collapse; font-size:13pt;">
        <tr>
          <td style="font-size:7pt; font-weight:700; text-transform:uppercase; color:#555; width:28mm; vertical-align:top; padding-top:4px;">Nombre:</td>
          <td style="font-size:16pt; font-weight:900; text-transform:uppercase; letter-spacing:1px;">${escapeHtml(cliente)}</td>
        </tr>
        ${telefono ? `<tr>
          <td style="font-size:7pt; font-weight:700; text-transform:uppercase; color:#555; padding-top:4px;">Teléfono:</td>
          <td style="font-size:14pt; font-weight:700;">${escapeHtml(telefono)}</td>
        </tr>` : ""}
        ${direccion ? `<tr>
          <td style="font-size:7pt; font-weight:700; text-transform:uppercase; color:#555; padding-top:4px;">Dirección:</td>
          <td style="font-size:14pt; font-weight:700; text-transform:uppercase;">${escapeHtml(direccion)}</td>
        </tr>` : ""}
        ${localidadStr ? `<tr>
          <td style="font-size:7pt; font-weight:700; text-transform:uppercase; color:#555; padding-top:4px;">Localidad:</td>
          <td style="font-size:14pt; font-weight:700; text-transform:uppercase;">${escapeHtml(localidadStr)}</td>
        </tr>` : ""}
        ${provincia ? `<tr>
          <td style="font-size:7pt; font-weight:700; text-transform:uppercase; color:#555; padding-top:4px;">Provincia:</td>
          <td style="font-size:14pt; font-weight:700; text-transform:uppercase;">${escapeHtml(provincia)}</td>
        </tr>` : ""}
        ${dni ? `<tr>
          <td style="font-size:7pt; font-weight:700; text-transform:uppercase; color:#555; padding-top:4px;">DNI:</td>
          <td style="font-size:14pt; font-weight:700;">${escapeHtml(dni)}</td>
        </tr>` : ""}
        ${transporte ? `<tr>
          <td style="font-size:7pt; font-weight:700; text-transform:uppercase; color:#555; padding-top:4px;">Transporte:</td>
          <td style="font-size:14pt; font-weight:700; text-transform:uppercase;">${escapeHtml(transporte)}</td>
        </tr>` : ""}
      </table>

      <!-- Código de barras con número de pedido -->
      <div style="margin-top:6mm; text-align:center; border-top:1px solid #ddd; padding-top:4mm;">
        <svg id="barcode-etiqueta-${pedidoId.replace(/[^a-zA-Z0-9]/g,'_')}"></svg>
      </div>

    </div>
  `;

  const area = document.getElementById("etiquetasPrintArea");
  area.innerHTML = html;

  // Generar el código de barras después de que el DOM esté listo
  setTimeout(() => {
    const svgId = `barcode-etiqueta-${pedidoId.replace(/[^a-zA-Z0-9]/g,'_')}`;
    const svgEl = document.getElementById(svgId);
    if (svgEl && typeof JsBarcode !== "undefined") {
      JsBarcode(svgEl, pedidoId, {
        format: "CODE128",
        width: 2.5,
        height: 60,
        displayValue: true,
        fontSize: 14,
        margin: 8,
        textMargin: 4
      });
    }
    window.print();
  }, 150);
}

/* ===================== STOCK BAJO / AGOTADOS / MAS VENDIDOS ===================== */

async function cargarStockBajo() {
  mostrarSeccion("stockBajoProductos");
  try {
    // Reusar productos ya cacheados si están disponibles
    let productos = productosPOS.length > 0 ? productosPOS : null;
    if (!productos) {
      const response = await fetchAPI(API_URL + "?action=productos");
      const data = await response.json();
      productos = data.productos || [];
    }
    let html = "";
    const filtrados = productos.filter(p => { const s = Number(p.STOCK || 0); return s > 0 && s <= 5; });
    if (filtrados.length === 0) {
      html = `<tr><td colspan="3" class="text-center text-muted py-4">Sin productos con stock bajo 🎉</td></tr>`;
    }
    filtrados.forEach(p => {
      html += `<tr><td class="mono">${escapeHtml(p.CODIGO)}</td><td>${escapeHtml(p.PRODUCTO)}</td><td>${p.STOCK}</td></tr>`;
    });
    document.getElementById("tablaStockBajo").innerHTML = html;
  } catch (error) {
    console.error("Error stock bajo:", error);
  }
}

async function cargarAgotados() {
  mostrarSeccion("productosAgotados");
  try {
    let productos = productosPOS.length > 0 ? productosPOS : null;
    if (!productos) {
      const response = await fetchAPI(API_URL + "?action=productos");
      const data = await response.json();
      productos = data.productos || [];
    }
    let html = "";
    const filtrados = productos.filter(p => Number(p.STOCK || 0) === 0);
    if (filtrados.length === 0) {
      html = `<tr><td colspan="3" class="text-center text-muted py-4">No hay productos agotados 🎉</td></tr>`;
    }
    filtrados.forEach(p => {
      html += `<tr><td class="mono">${escapeHtml(p.CODIGO)}</td><td>${escapeHtml(p.PRODUCTO)}</td><td>0</td></tr>`;
    });
    document.getElementById("tablaAgotados").innerHTML = html;
  } catch (error) {
    console.error("Error agotados:", error);
  }
}

async function cargarMasVendidos() {
  try {
    const response = await fetchAPI(API_URL + "?action=masVendidos");
    const data = await response.json();
    let html = "";
    (data.productos || []).forEach(p => {
      html += `<tr><td class="mono">${p.CODIGO}</td><td>${p.PRODUCTO}</td><td>${p.VENDIDOS}</td></tr>`;
    });
    document.getElementById("tablaMasVendidos").innerHTML = html;
  } catch (error) {
    console.error("Error más vendidos:", error);
  }
}

/* ===================================================================
   PUNTO DE VENTA
=================================================================== */

let productosPOS    = [];
const _ventasMapPOS = {}; // mapa ventaId → objeto venta, para evitar JSON en onclick
let ticketPOS        = [];
let categoriaActivaPOS = "TODAS";
let formaPagoPOS    = "EFECTIVO";
let ultimoCodigoAgregadoPOS = null; // usado por el atajo +/- de cantidad
let posTileFocusIdx  = -1;          // índice de la tarjeta con foco de teclado en el grid

// Descuento aplicado al ticket actual
let descuentoTipoPOS   = "PORCENTAJE"; // "PORCENTAJE" | "MONTO"
let descuentoValorPOS  = 0;            // valor ingresado (ej: 10 para 10%, o 500 para $500)
let descuentoActivoPOS = false;

/** Limpia el caché de productos del POS y recarga desde el backend */
async function actualizarCatalogoPOSManual() {
  try { localStorage.removeItem("veekpos_productos_cache"); } catch(e) {}
  productosPOS = [];
  toast("Actualizando catálogo...", "success");
  await asegurarProductosPOS();
  toast("Catálogo actualizado", "success");
}

async function asegurarProductosPOS() {
  if (productosPOS.length > 0) return;

  const CACHE_KEY = "veekpos_productos_cache";
  const CACHE_TTL = 10 * 60 * 1000;
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const { ts, productos } = JSON.parse(cached);
      if (Date.now() - ts < CACHE_TTL && productos.length > 0) {
        productosPOS = productos;
        construirCategoriasPOS();
        renderPosGrid();
        _actualizarCacheProductosPOS(CACHE_KEY);
        return;
      }
    }
  } catch(e) {}

  await _actualizarCacheProductosPOS(CACHE_KEY);
}

async function _actualizarCacheProductosPOS(cacheKey) {
  try {
    const response = await fetchAPI(API_URL + "?action=productos");
    const data = await response.json();
    const productos = data.productos || [];
    localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), productos }));
    if (JSON.stringify(productos.map(p => p.CODIGO + p.STOCK)) !==
        JSON.stringify(productosPOS.map(p => p.CODIGO + p.STOCK))) {
      productosPOS = productos;
      construirCategoriasPOS();
      renderPosGrid();
    } else {
      productosPOS = productos;
    }
  } catch(e) {
    console.error("Error actualizando caché de productos POS:", e);
  }
}

function construirCategoriasPOS() {
  const cont = document.getElementById("posCategorias");
  if (!cont) return;

  // Permite desplazar las categorías con la rueda normal del mouse
  // (vertical), sin necesidad de Shift+rueda ni de arrastrar — se
  // agrega una sola vez, porque este <div> no se recrea entre
  // llamadas (solo cambia su innerHTML más abajo).
  if (!cont.dataset.wheelListo) {
    cont.addEventListener("wheel", (e) => {
      if (e.deltaY === 0) return; // ya es un scroll horizontal nativo (trackpad), no interferir
      e.preventDefault();
      cont.scrollLeft += e.deltaY;
    });
    cont.dataset.wheelListo = "1";
  }

  const categorias = new Set();
  productosPOS.forEach(p => { if (p.CATEGORIA) categorias.add(String(p.CATEGORIA).trim()); });
  if (categorias.size === 0) { cont.innerHTML = ""; return; }
  let html = `<div class="cat-chip active" data-cat="TODAS" onclick="filtrarCategoriaPOS('TODAS', this)">Todas</div>`;
  categorias.forEach(c => {
    html += `<div class="cat-chip" data-cat="${escapeHtml(c)}" onclick="filtrarCategoriaPOS('${escapeHtml(c)}', this)">${escapeHtml(c)}</div>`;
  });
  cont.innerHTML = html;
}

function filtrarCategoriaPOS(cat, el) {
  categoriaActivaPOS = cat;
  posTileFocusIdx = -1;
  document.querySelectorAll(".cat-chip").forEach(c => c.classList.remove("active"));
  if (el) el.classList.add("active");
  renderPosGrid();
}

/* ---- product grid ---- */

function renderPosGrid(filtroTexto) {
  const grid = document.getElementById("posProductGrid");
  if (!grid) return;

  let lista = productosPOS;
  if (categoriaActivaPOS && categoriaActivaPOS !== "TODAS") {
    lista = lista.filter(p => String(p.CATEGORIA || "").trim() === categoriaActivaPOS);
  }
  if (filtroTexto) {
    const normalizar = t => String(t || "").toLowerCase()
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const texto = normalizar(filtroTexto);
    lista = lista.filter(p =>
      normalizar(p.CODIGO).includes(texto) ||
      normalizar(p.PRODUCTO).includes(texto) ||
      normalizar(p.CATEGORIA).includes(texto)
    );
  }

  if (lista.length === 0) {
    grid.innerHTML = `
      <div class="pos-empty-state" style="grid-column:1/-1;">
        <div class="ic">🔍</div>
        <strong>Sin resultados</strong>
        <span>Probá con otro código o nombre</span>
      </div>`;
    return;
  }

  let html = "";
  const visibleList = lista.slice(0, 60);

  visibleList.forEach((p, idx) => {
    const stock     = p.STOCK !== undefined ? Number(p.STOCK) : null;
    const agotado   = stock !== null && stock <= 0;
    const stockBajo = stock !== null && stock > 0 && stock <= 5;

    let stockBadge = "";
    if (agotado)        stockBadge = `<span class="tile-stock out">Sin stock</span>`;
    else if (stockBajo) stockBadge = `<span class="tile-stock low">Stock: ${stock}</span>`;
    else if (stock !== null) stockBadge = `<span class="tile-stock ok">Stock: ${stock}</span>`;

    const cat = p.CATEGORIA ? escapeHtml(String(p.CATEGORIA).trim()) : "";
    const imagenUrl = p.IMAGEN ? String(p.IMAGEN).trim() : "";

    html += `
      <div
        class="product-tile"
        role="button"
        tabindex="0"
        data-idx="${idx}">
        <div class="tile-photo">
          ${imagenUrl
            ? `<img src="${escapeHtml(imagenUrl)}" alt="" loading="lazy" onerror="this.parentElement.innerHTML='🛒';">`
            : "🛒"}
        </div>
        <div class="tile-info">
          <span class="tile-code">${escapeHtml(p.CODIGO)}</span>
          <span class="tile-name">${escapeHtml(p.PRODUCTO)}</span>
          ${cat ? `<span class="tile-cat">${cat}</span>` : ""}
        </div>
        <div class="tile-right">
          <span class="tile-price">$${Number(p.PRECIO || 0).toLocaleString("es-AR")}</span>
          ${stockBadge}
        </div>
        <button type="button" class="tile-edit" data-idx="${idx}" title="Editar precio y stock" onclick="event.stopPropagation(); abrirEdicionRapidaPOS('${escapeHtml(p.CODIGO)}');">✏️</button>
        ${Number(p.UNIDADES_POR_CAJA) > 0 ? `<button type="button" class="tile-caja" title="Agregar 1 caja (${p.UNIDADES_POR_CAJA} uds) a $${Number(p.PRECIO_CAJA || 0).toLocaleString("es-AR")}" onclick="event.stopPropagation(); agregarCajaAlTicket(productosPOS.find(x => String(x.CODIGO)==='${escapeHtml(p.CODIGO)}'));">📦x${p.UNIDADES_POR_CAJA}</button>` : ""}
        <span class="tile-add">+</span>
      </div>`;
  });

  grid.innerHTML = html;

  grid.querySelectorAll(".product-tile[data-idx]").forEach(tile => {
    const idx     = Number(tile.getAttribute("data-idx"));
    const producto = visibleList[idx];
    if (producto) {
      tile.dataset.codigo = producto.CODIGO;
      tile.addEventListener("click", () => agregarProductoPOS(producto.CODIGO));
      tile.addEventListener("keydown", e => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); agregarProductoPOS(producto.CODIGO); }
      });
    }
  });
}

/** Filtra la grilla del POS en tiempo real mientras se escribe (oninput) */
function onPosInput(e) {
  posTileFocusIdx = -1;
  renderPosGridConDemora(e.target.value.trim());
}

function onPosInputKeyup(e) {
  const input = e.target;
  if (e.key === "Enter") {
    const valor = input.value.trim();
    if (valor !== "") {
      agregarProductoPorCodigo(valor);
      input.value = "";
      renderPosGrid();
    }
    return;
  }
  // Las teclas no-Enter ya las maneja onPosInput (oninput)
  // Solo actualizamos el índice de foco por si se usaron flechas
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    posTileFocusIdx = -1;
    renderPosGridConDemora(input.value.trim());
  }
}

const renderPosGridConDemora = debounce(renderPosGrid, 150);

/* ---- adding items ---- */

async function agregarProductoPorCodigo(codigo) {
  codigo = String(codigo).trim();
  if (codigo === "") return;
  await asegurarProductosPOS();

  const producto = productosPOS.find(p => String(p.CODIGO).trim().toLowerCase() === codigo.toLowerCase());
  if (producto) { agregarProductoPOS(producto.CODIGO); return; }

  // No matcheó el código unitario — probar si es el código de la caja/bulto cerrado
  const productoPorCaja = productosPOS.find(p =>
    String(p.CODIGO_CAJA || "").trim().toLowerCase() === codigo.toLowerCase() && Number(p.UNIDADES_POR_CAJA) > 0
  );
  if (productoPorCaja) { agregarCajaAlTicket(productoPorCaja); return; }

  toast(`Producto no encontrado: ${codigo}`, "error");
}

/**
 * Agrega al ticket una "caja" (bulto cerrado) de un producto que se
 * vende también por unidad — mismo CODIGO real (para que el stock se
 * descuente del mismo lugar de siempre), pero como línea aparte
 * (marcada con _esCaja) porque el precio por unidad equivalente es
 * distinto al de venderlo suelto.
 */
function agregarCajaAlTicket(producto) {
  const unidades = Number(producto.UNIDADES_POR_CAJA) || 1;
  const precioCaja = Number(producto.PRECIO_CAJA) || 0;
  const precioUnitarioEquivalente = precioCaja / unidades;

  const existente = ticketPOS.find(item => String(item.CODIGO).trim() === String(producto.CODIGO).trim() && item._esCaja);
  if (existente) {
    existente.cantidad += unidades;
  } else {
    ticketPOS.push({
      CODIGO: producto.CODIGO,
      PRODUCTO: `${producto.PRODUCTO} (caja x${unidades})`,
      cantidad: unidades,
      PRECIO: precioUnitarioEquivalente,
      _esCaja: true
    });
  }
  renderTicketPOS();
  toast(`+1 caja de ${producto.PRODUCTO} (${unidades} uds) — $${precioCaja.toLocaleString("es-AR")}`, "success");
}

/**
 * Edición rápida de precio y stock desde el mismo grid del POS — sin
 * tener que ir a la sección Productos. Se preservan categoría,
 * imagen, publicado, destacado y oferta tal cual estaban: la acción
 * del backend (actualizarProducto) sobreescribe TODO el producto, así
 * que si no se mandaran esos valores existentes quedarían borrados.
 */
let _codigoEdicionRapidaPOS = null;

function abrirEdicionRapidaPOS(codigo) {
  const producto = productosPOS.find(p => String(p.CODIGO).trim() === String(codigo).trim());
  if (!producto) { toast("Producto no encontrado", "error"); return; }

  _codigoEdicionRapidaPOS = codigo;
  document.getElementById("erpNombreProducto").textContent = producto.PRODUCTO;
  document.getElementById("erpCodigo").value = producto.CODIGO;
  document.getElementById("erpPrecio").value = producto.PRECIO ?? 0;
  document.getElementById("erpStock").value = producto.STOCK ?? 0;
  document.getElementById("modalEdicionRapidaPOSBackdrop").classList.add("show");
}

function cerrarEdicionRapidaPOS() {
  document.getElementById("modalEdicionRapidaPOSBackdrop").classList.remove("show");
  _codigoEdicionRapidaPOS = null;
}

async function guardarEdicionRapidaPOS() {
  const codigoOriginal = _codigoEdicionRapidaPOS;
  if (!codigoOriginal) return;

  const producto = productosPOS.find(p => String(p.CODIGO).trim() === String(codigoOriginal).trim());
  if (!producto) { toast("Producto no encontrado", "error"); cerrarEdicionRapidaPOS(); return; }

  const codigoNuevo = document.getElementById("erpCodigo").value.trim();
  const precio = document.getElementById("erpPrecio").value;
  const stock  = document.getElementById("erpStock").value;

  if (!codigoNuevo) { toast("El código no puede quedar vacío", "error"); return; }
  if (precio === "" || Number(precio) < 0) { toast("Ingresá un precio válido", "error"); return; }
  if (stock === "") { toast("Ingresá un stock válido", "error"); return; }

  // Si cambiaron el código, chequeo local rápido para avisar antes de
  // mandarlo — el backend igual lo vuelve a validar (por si otra
  // persona creó ese código justo en el medio).
  if (codigoNuevo !== codigoOriginal && productosPOS.some(p => String(p.CODIGO).trim() === codigoNuevo)) {
    toast(`Ya existe otro producto con el código "${codigoNuevo}"`, "error");
    return;
  }

  const btn = document.getElementById("btnGuardarEdicionRapidaPOS");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Guardando...";

  try {
    // Se mandan TODOS los campos del producto (no solo código/precio/
    // stock), preservando lo que ya tenía — incluyendo el precio por
    // caja, que este modal no permite editar pero tampoco debe borrar.
    const params = new URLSearchParams({
      action: "actualizarProducto",
      codigoOriginal: producto.CODIGO,
      CODIGO: codigoNuevo,
      PRODUCTO: producto.PRODUCTO,
      CATEGORIA: producto.CATEGORIA || "",
      PRECIO: precio,
      STOCK: stock,
      IMAGEN: producto.IMAGEN || "",
      PUBLICADO: producto.PUBLICADO || "SI",
      DESTACADO: producto.DESTACADO || "NO",
      OFERTA: producto.OFERTA || "NO",
      CODIGO_CAJA: producto.CODIGO_CAJA || "",
      UNIDADES_POR_CAJA: producto.UNIDADES_POR_CAJA || 0,
      PRECIO_CAJA: producto.PRECIO_CAJA || 0
    });

    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo actualizar el producto", "error");
      return;
    }

    // Actualiza en memoria al instante — no hace falta esperar a
    // recargar todo el catálogo para ver el cambio reflejado
    producto.CODIGO = codigoNuevo;
    producto.PRECIO = Number(precio);
    producto.STOCK = Number(stock);
    // Si el producto editado ya estaba en el ticket actual, el código
    // ahí también tiene que actualizarse — si no, quedaría apuntando
    // a un código que ya no existe más en productosPOS.
    const itemEnTicket = ticketPOS.find(i => String(i.CODIGO).trim() === String(codigoOriginal).trim());
    if (itemEnTicket) itemEnTicket.CODIGO = codigoNuevo;

    renderPosGrid(document.getElementById("posBusqueda")?.value.trim() || "");
    if (itemEnTicket) renderTicketPOS();

    toast("Producto actualizado", "success");
    cerrarEdicionRapidaPOS();
    invalidarCache("productosAdmin");

  } catch (error) {
    console.error("Error en edición rápida de producto:", error);
    toast("Error de conexión al actualizar el producto", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

function agregarProductoPOS(codigo) {
  codigo = String(codigo).trim();
  const producto = productosPOS.find(p => String(p.CODIGO).trim() === codigo);
  if (!producto) { toast("Producto no encontrado", "error"); return; }
  const stock = producto.STOCK !== undefined ? Number(producto.STOCK) : null;
  if (stock !== null && stock <= 0) {
    // Antes esto bloqueaba la venta directamente. Ahora se permite —
    // hay negocios que venden sobre pedido, o el stock cargado no
    // siempre está perfectamente al día — pero se avisa para que
    // quede claro que se está vendiendo sin stock disponible.
    toast(`${producto.PRODUCTO} no tiene stock cargado — se agrega igual`, "error");
  }

  const existente = ticketPOS.find(item => String(item.CODIGO).trim() === codigo);
  if (existente) {
    existente.cantidad++;
  } else {
    ticketPOS.push({ CODIGO: producto.CODIGO, PRODUCTO: producto.PRODUCTO, PRECIO: Number(producto.PRECIO || 0), cantidad: 1 });
  }
  renderTicketPOS();
  flashTile(codigo);
  mostrarUltimoEscaneado(producto);
  ultimoCodigoAgregadoPOS = codigo;
  scrollTicketAlProducto(codigo);

  const input = document.getElementById("posBusqueda");
  if (input) { input.value = ""; input.focus(); }
}

/** Scrolls the ticket list so the row for this product is visible (used when adding/incrementing it) */
function scrollTicketAlProducto(codigo) {
  const fila = document.querySelector(`.ticket-row[data-codigo="${cssEscape(codigo)}"]`);
  if (fila) fila.scrollIntoView({ block: "end", behavior: "smooth" });
}

/** Updates the "last scanned product" panel with its photo, name, code and price */
function mostrarUltimoEscaneado(producto) {
  const panel = document.getElementById("scanResultPanel");
  if (!panel) return;

  const thumb = document.getElementById("scanResultThumb");
  const imagenUrl = producto.IMAGEN ? String(producto.IMAGEN).trim() : "";

  if (thumb) {
    thumb.innerHTML = imagenUrl
      ? `<img src="${escapeHtml(imagenUrl)}" alt="" onerror="this.parentElement.innerHTML='🛒';">`
      : "🛒";
  }

  actualizarElemento("scanResultName", producto.PRODUCTO);
  actualizarElemento("scanResultCode", producto.CODIGO);
  actualizarElemento("scanResultPrice", "$" + Number(producto.PRECIO || 0).toLocaleString("es-AR"));

  panel.classList.add("has-product");
}

function flashTile(codigo) {
  const tile = document.querySelector(`.product-tile[data-codigo="${cssEscape(codigo)}"]`);
  if (!tile) return;
  tile.classList.remove("just-added");
  void tile.offsetWidth;
  tile.classList.add("just-added");
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function cambiarCantidadPOS(codigo, delta) {
  const item = ticketPOS.find(i => String(i.CODIGO).trim() === String(codigo).trim());
  if (!item) return;
  item.cantidad += delta;
  if (item.cantidad <= 0) { quitarProductoPOS(codigo); return; }
  renderTicketPOS();
}

/** Lets the cashier type the quantity directly instead of tapping +/- repeatedly */
function actualizarCantidadManualPOS(codigo, valor) {
  const item = ticketPOS.find(i => String(i.CODIGO).trim() === String(codigo).trim());
  if (!item) return;

  let cantidad = parseInt(valor, 10);

  if (isNaN(cantidad) || cantidad <= 0) {
    quitarProductoPOS(codigo);
    return;
  }

  item.cantidad = cantidad;
  renderTicketPOS();
}

/** Selects the whole quantity value on focus, so typing a new number replaces it instead of appending */
function seleccionarCantidadPOS(input) {
  input.select();
}

function quitarProductoPOS(codigo) {
  ticketPOS = ticketPOS.filter(i => String(i.CODIGO).trim() !== String(codigo).trim());
  renderTicketPOS();
}

function vaciarTicketPOS() {
  if (ticketPOS.length === 0) return;
  // Sin confirm() — acción recuperable (el cajero puede volver a agregar productos)
  ticketPOS = [];
  resetearDescuentoPOS();
  const inputRecibido = document.getElementById("inputRecibido");
  const cambioValor = document.getElementById("cambioValor");
  if (inputRecibido) inputRecibido.value = "";
  if (cambioValor) { cambioValor.textContent = "—"; cambioValor.classList.remove("negativo"); }
  renderTicketPOS();
}

/* ---- ticket rendering ---- */

function renderTicketPOS() {
  let html = "";
  let subtotal = 0;
  let totalItems = 0;

  ticketPOS.forEach(item => {
    const sub = item.PRECIO * item.cantidad;
    subtotal += sub;
    totalItems += item.cantidad;
    html += `
      <div class="ticket-row" data-codigo="${escapeHtml(item.CODIGO)}">
        <div class="ti-info">
          <div class="ti-name">${escapeHtml(item.PRODUCTO)}</div>
          <div class="ti-price">$${item.PRECIO.toLocaleString("es-AR")} c/u</div>
        </div>
        <div class="ti-qty">
          <input
            type="number"
            class="qty-input-pos"
            min="1"
            step="1"
            inputmode="numeric"
            value="${item.cantidad}"
            onfocus="seleccionarCantidadPOS(this)"
            onchange="actualizarCantidadManualPOS('${item.CODIGO}', this.value)">
        </div>
        <div class="ti-sub money">$${sub.toLocaleString("es-AR")}</div>
        <button class="ti-remove" onclick="quitarProductoPOS('${item.CODIGO}')" title="Quitar">✕</button>
      </div>`;
  });

  const tabla = document.getElementById("ticketPOS");
  if (tabla) tabla.innerHTML = html;

  const emptyState = document.getElementById("ticketEmptyState");
  if (emptyState) emptyState.style.display = ticketPOS.length === 0 ? "flex" : "none";

  const { montoDescuento, total } = calcularDescuentoPOS(subtotal);

  const subtotalEl = document.getElementById("subtotalPOS");
  if (subtotalEl) subtotalEl.innerText = subtotal.toLocaleString("es-AR");

  const rowDescuentoEl = document.getElementById("rowDescuentoPOS");
  const descuentoMontoEl = document.getElementById("descuentoMontoPOS");
  if (rowDescuentoEl && descuentoMontoEl) {
    if (descuentoActivoPOS && montoDescuento > 0) {
      rowDescuentoEl.style.display = "flex";
      descuentoMontoEl.innerText = "-$" + montoDescuento.toLocaleString("es-AR");
    } else {
      rowDescuentoEl.style.display = "none";
    }
  }

  const totalEl = document.getElementById("totalPOS");
  if (totalEl) totalEl.innerText = total.toLocaleString("es-AR");

  const countEl = document.getElementById("ticketCount");
  if (countEl) countEl.innerText = ticketPOS.length;

  const itemsCountEl = document.getElementById("ticketItemsCount");
  if (itemsCountEl) itemsCountEl.innerText = totalItems;

  const finalizeBtn = document.getElementById("btnFinalizarVenta");
  if (finalizeBtn) finalizeBtn.disabled = ticketPOS.length === 0;

  const generarPedidoBtn = document.getElementById("btnGenerarPedido");
  if (generarPedidoBtn) generarPedidoBtn.disabled = ticketPOS.length === 0;

  const printBtn = document.getElementById("btnImprimirTicket");
  if (printBtn) printBtn.disabled = ticketPOS.length === 0;

  actualizarUIDescuentoPOS();
}

/* ---- discount ---- */

/** Computes the discount amount (clamped to the subtotal) and the resulting total */
function calcularDescuentoPOS(subtotal) {
  if (!descuentoActivoPOS || descuentoValorPOS <= 0) {
    return { montoDescuento: 0, total: subtotal };
  }

  let monto = descuentoTipoPOS === "PORCENTAJE"
    ? subtotal * (descuentoValorPOS / 100)
    : descuentoValorPOS;

  monto = Math.max(0, Math.min(monto, subtotal)); // nunca negativo ni mayor al subtotal

  return { montoDescuento: monto, total: subtotal - monto };
}

/** Calcula y muestra el cambio a entregar según lo recibido */
function calcularCambio() {
  const totalEl = document.getElementById("totalPOS");
  const recibidoEl = document.getElementById("inputRecibido");
  const cambioEl = document.getElementById("cambioValor");
  if (!totalEl || !recibidoEl || !cambioEl) return;

  const total = Number(String(totalEl.textContent).replace(/\./g, "").replace(",", ".")) || 0;
  const recibido = Number(recibidoEl.value) || 0;

  if (!recibido) {
    cambioEl.textContent = "—";
    cambioEl.classList.remove("negativo");
    return;
  }

  const cambio = recibido - total;
  cambioEl.textContent = "$" + Math.abs(cambio).toLocaleString("es-AR");
  if (cambio < 0) {
    cambioEl.classList.add("negativo");
    cambioEl.textContent = "-$" + Math.abs(cambio).toLocaleString("es-AR");
  } else {
    cambioEl.classList.remove("negativo");
  }
}

/** Devuelve el monto recibido y el cambio para incluirlos en el ticket */
function obtenerDatosCambio() {
  const recibidoEl = document.getElementById("inputRecibido");
  const cambioEl = document.getElementById("cambioValor");
  const recibido = recibidoEl ? Number(recibidoEl.value) || 0 : 0;
  const cambioTexto = cambioEl ? cambioEl.textContent : "—";
  return { recibido, cambioTexto };
}

function toggleDescuentoPOS() {
  const panel = document.getElementById("discountPanel");
  if (!panel) return;
  const abierto = panel.style.display !== "none";
  panel.style.display = abierto ? "none" : "flex";
  if (!abierto) {
    setTimeout(() => {
      const input = document.getElementById("descuentoValorInput");
      if (input) input.focus();
    }, 50);
  }
}

function elegirTipoDescuento(el, tipo) {
  descuentoTipoPOS = tipo;
  document.querySelectorAll(".discount-type-btn").forEach(b => b.classList.remove("active"));
  el.classList.add("active");

  const input = document.getElementById("descuentoValorInput");
  if (input) input.placeholder = tipo === "PORCENTAJE" ? "Ej: 10" : "Ej: 500";

  aplicarDescuentoPOS();
}

function aplicarDescuentoPOS() {
  const input = document.getElementById("descuentoValorInput");
  const valor = Number(input ? input.value : 0) || 0;

  descuentoValorPOS = Math.max(0, valor);
  descuentoActivoPOS = descuentoValorPOS > 0;

  renderTicketPOS();
}

function quitarDescuentoPOS() {
  resetearDescuentoPOS();
  renderTicketPOS();
}

function resetearDescuentoPOS() {
  descuentoActivoPOS = false;
  descuentoValorPOS = 0;
  const input = document.getElementById("descuentoValorInput");
  if (input) input.value = "";
  const motivo = document.getElementById("descuentoMotivoInput");
  if (motivo) motivo.value = "";
}

/** Returns a short human-readable label for the active discount, e.g. "10% (-$500)" or "-$300" */
function obtenerEtiquetaDescuentoPOS(subtotal) {
  if (!descuentoActivoPOS || descuentoValorPOS <= 0) return "";
  const { montoDescuento } = calcularDescuentoPOS(subtotal);
  const motivo = (document.getElementById("descuentoMotivoInput") || {}).value || "";
  let etiqueta = descuentoTipoPOS === "PORCENTAJE"
    ? `${descuentoValorPOS}% (-$${Math.round(montoDescuento).toLocaleString("es-AR")})`
    : `-$${Math.round(montoDescuento).toLocaleString("es-AR")}`;
  if (motivo.trim()) etiqueta += ` — ${motivo.trim()}`;
  return etiqueta;
}

/** Keeps the toggle button label/style in sync with the current discount state */
function actualizarUIDescuentoPOS() {
  const btn = document.getElementById("btnToggleDescuento");
  const label = document.getElementById("discountToggleLabel");
  if (!btn || !label) return;

  if (descuentoActivoPOS && descuentoValorPOS > 0) {
    btn.classList.add("has-discount");
    label.innerText = descuentoTipoPOS === "PORCENTAJE"
      ? `Descuento aplicado: ${descuentoValorPOS}%`
      : `Descuento aplicado: $${descuentoValorPOS.toLocaleString("es-AR")}`;
  } else {
    btn.classList.remove("has-discount");
    label.innerText = "Agregar descuento";
  }
}

/* ---- payment method ---- */

function elegirFormaPago(el, valor) {
  formaPagoPOS = valor;
  document.querySelectorAll(".pay-method-btn").forEach(b => b.classList.remove("active"));
  el.classList.add("active");
}

/* ---- finalize sale ---- */

/* ---- Modal Finalizar Venta ---- */
let mfvTipoDescuento = "PORCENTAJE";
let mfvFormaPago = "EFECTIVO";

function abrirModalFinalizarVenta() {
  if (ticketPOS.length === 0) { toast("El ticket está vacío", "error"); return; }

  try {
  // Pre-cargar valores del ticket actual
  const subtotal = ticketPOS.reduce((a, i) => a + i.PRECIO * i.cantidad, 0);
  const { montoDescuento, total } = calcularDescuentoPOS(subtotal);

  document.getElementById("mfvTotal").textContent = "$" + total.toLocaleString("es-AR");

  // Descuento — prellenar con el valor actual del ticket
  document.getElementById("mfvDescuentoValor").value = descuentoValorPOS || "";
  document.getElementById("mfvDescuentoMotivo").value =
    (document.getElementById("descuentoMotivoInput") || {}).value || "";

  // Tipo de descuento
  mfvTipoDescuento = descuentoTipoPOS || "PORCENTAJE";
  document.getElementById("mfvTipoPct").classList.toggle("active", mfvTipoDescuento === "PORCENTAJE");
  document.getElementById("mfvTipoMonto").classList.toggle("active", mfvTipoDescuento === "MONTO");
  mfvActualizarDescuento();

  // Forma de pago
  mfvFormaPago = formaPagoPOS || "EFECTIVO";
  document.querySelectorAll("#mfvPayMethods .pay-method-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.val === mfvFormaPago);
  });
  mfvMostrarRecibido();

  // Recibido
  document.getElementById("mfvRecibido").value = "";
  document.getElementById("mfvCambio").textContent = "—";
  document.getElementById("mfvCambio").classList.remove("negativo");

  document.getElementById("btnConfirmarVenta").disabled = false;
  document.getElementById("btnConfirmarVenta").textContent = "✅ Confirmar venta";
  document.getElementById("modalFinalizarVentaBackdrop").classList.add("show");
  setTimeout(() => {
    const el = mfvFormaPago === "EFECTIVO"
      ? document.getElementById("mfvRecibido")
      : document.getElementById("btnConfirmarVenta");
    if (el) el.focus();
  }, 120);
  } catch(err) {
    console.error("Error al abrir modal finalizar:", err);
    // Fallback: abrir el modal igual aunque haya error de prefill
    document.getElementById("modalFinalizarVentaBackdrop").classList.add("show");
  }
}

function cerrarModalFinalizarVenta() {
  document.getElementById("modalFinalizarVentaBackdrop").classList.remove("show");
}

function mfvElegirPago(btn, valor) {
  mfvFormaPago = valor;
  document.querySelectorAll("#mfvPayMethods .pay-method-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.val === valor));
  mfvMostrarRecibido();
  if (valor === "EFECTIVO") setTimeout(() => document.getElementById("mfvRecibido").focus(), 50);
}

function mfvMostrarRecibido() {
  const wrap = document.getElementById("mfvRecibidoWrap");
  if (wrap) wrap.style.display = mfvFormaPago === "EFECTIVO" ? "block" : "none";
}

function mfvElegirTipo(btn, tipo) {
  mfvTipoDescuento = tipo;
  document.querySelectorAll("#mfvPayMethods .discount-type-btn, .product-modal .discount-type-btn").forEach(b => {
    if (b.dataset.tipo) b.classList.toggle("active", b.dataset.tipo === tipo);
  });
  btn.closest(".product-modal-body").querySelectorAll(".discount-type-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tipo === tipo));
  mfvActualizarDescuento();
}

function mfvLimpiarDescuento() {
  document.getElementById("mfvDescuentoValor").value = "";
  document.getElementById("mfvDescuentoMotivo").value = "";
  mfvActualizarDescuento();
}

function mfvActualizarDescuento() {
  const subtotal = ticketPOS.reduce((a, i) => a + i.PRECIO * i.cantidad, 0);
  const val = Number(document.getElementById("mfvDescuentoValor").value) || 0;
  let monto = 0;
  if (mfvTipoDescuento === "PORCENTAJE") monto = subtotal * val / 100;
  else monto = val;
  monto = Math.min(monto, subtotal);
  const total = subtotal - monto;
  document.getElementById("mfvTotal").textContent = "$" + total.toLocaleString("es-AR");
  const info = document.getElementById("mfvDescuentoInfo");
  if (monto > 0) {
    info.style.display = "block";
    info.textContent = `Descuento: -$${monto.toLocaleString("es-AR")} → Total: $${total.toLocaleString("es-AR")}`;
  } else {
    info.style.display = "none";
  }
  if (mfvFormaPago === "EFECTIVO") mfvCalcularCambio();
}

function mfvCalcularCambio() {
  const totalStr = document.getElementById("mfvTotal").textContent.replace(/\$/g, "").replace(/\./g, "").replace(",", ".");
  const total = Number(totalStr) || 0;
  const recibido = Number(document.getElementById("mfvRecibido").value) || 0;
  const cambioEl = document.getElementById("mfvCambio");
  if (!recibido) { cambioEl.textContent = "—"; cambioEl.classList.remove("negativo"); return; }
  const cambio = recibido - total;
  cambioEl.textContent = "$" + Math.abs(cambio).toLocaleString("es-AR");
  cambioEl.classList.toggle("negativo", cambio < 0);
  if (cambio < 0) cambioEl.textContent = "-$" + Math.abs(cambio).toLocaleString("es-AR");
}

let _ventaEnProceso = false; // evita doble confirmación por clic rápido

async function confirmarFinalizarVenta() {
  if (_ventaEnProceso) return; // ya hay una venta en curso
  _ventaEnProceso = true;
  const btnConfirmar = document.getElementById("btnConfirmarVenta");
  if (btnConfirmar) { btnConfirmar.disabled = true; btnConfirmar.textContent = "Procesando..."; }

  try {
  const valDescuento = document.getElementById("mfvDescuentoValor").value;
  const motivoDescuento = document.getElementById("mfvDescuentoMotivo").value;
  if (valDescuento && Number(valDescuento) > 0) {
    descuentoTipoPOS = mfvTipoDescuento;
    if (document.getElementById("descuentoValorInput"))
      document.getElementById("descuentoValorInput").value = valDescuento;
    if (document.getElementById("descuentoMotivoInput"))
      document.getElementById("descuentoMotivoInput").value = motivoDescuento;
    aplicarDescuentoPOS();
  } else {
    resetearDescuentoPOS();
  }

  const btnPago = document.querySelector(`#mfvPayMethods .pay-method-btn[data-val="${mfvFormaPago}"]`);
  if (btnPago) elegirFormaPago(btnPago, mfvFormaPago);

  const recibido = Number(document.getElementById("mfvRecibido").value) || 0;
  const inputRec = document.getElementById("inputRecibido");
  if (inputRec) inputRec.value = recibido || "";
  if (recibido) calcularCambio();

  cerrarModalFinalizarVenta();

  // Si es TRANSFERENCIA y MercadoPago está configurado → mostrar QR antes de registrar
  if (mfvFormaPago === "TRANSFERENCIA") {
    const bridge = window.veekpos || window.posOffline;
    if (bridge && typeof bridge.mercadoPagoDisponible === "function") {
      const mpDisponible = await bridge.mercadoPagoDisponible().catch(() => false);
      if (mpDisponible) {
        await iniciarCobroMercadoPago(total);
        return; // iniciarCobroMercadoPago maneja el resto del flujo
      }
    }
  }

  // ── OPTIMISTIC: calcular todo localmente y mostrar el recibo al instante ──
  const subtotal = ticketPOS.reduce((acc, item) => acc + (item.PRECIO * item.cantidad), 0);
  const { montoDescuento, total } = calcularDescuentoPOS(subtotal);
  const etiquetaDescuento = obtenerEtiquetaDescuentoPOS(subtotal);
  const itemsSnapshot = [...ticketPOS];
  const fechaVenta = new Date();
  const ventaIdTemp = "VEN-" + Date.now().toString().slice(-6);
  // Generado ACÁ, antes de intentar guardar — así, si hay que
  // reintentar más tarde (ver colaVentasPendientes), el backend puede
  // reconocer que es el mismo intento y no duplicar la venta.
  const clienteVentaId = "CVL-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  // Guardar para impresión
  ultimaVentaImprimible = {
    ventaId: ventaIdTemp,
    items: itemsSnapshot,
    total, subtotal,
    descuento: montoDescuento,
    descuentoEtiqueta: etiquetaDescuento,
    formaPago: formaPagoPOS,
    fecha: fechaVenta
  };

  // Mostrar recibo y limpiar ticket INMEDIATAMENTE
  mostrarRecibo(ventaIdTemp, itemsSnapshot, total, subtotal, montoDescuento, recibido);
  ticketPOS = [];
  resetearDescuentoPOS();
  if (inputRec) inputRec.value = "";
  const cambioEl = document.getElementById("cambioValor");
  if (cambioEl) { cambioEl.textContent = "—"; cambioEl.classList.remove("negativo"); }
  renderTicketPOS();
  ultimoCodigoAgregadoPOS = null;
  posTileFocusIdx = -1;

  // Actualizar stock optimistamente en el grid
  itemsSnapshot.forEach(item => {
    const p = productosPOS.find(x => String(x.CODIGO) === String(item.CODIGO));
    if (p && p.STOCK !== undefined) p.STOCK = Math.max(0, Number(p.STOCK) - item.cantidad);
  });
  renderPosGrid();

  const btn = document.getElementById("btnFinalizarVenta");
  if (btn) btn.disabled = false;

  // ── GUARDAR en el backend en segundo plano ──
  try {
    // Por POST, con el carrito en el body — un carrito grande por GET
    // (todo metido en la URL) puede superar lo que Google/Apps Script
    // acepta, y la venta fallaba con "error de conexión" sin serlo
    // realmente (el mismo problema que tenían los pedidos grandes).
    const response = await fetchAPI(
      API_URL,
      {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify({
          action: "guardarVenta",
          total: total,
          formaPago: formaPagoPOS,
          observaciones: etiquetaDescuento ? "Descuento: " + etiquetaDescuento : "",
          carrito: itemsSnapshot,
          clienteVentaId: clienteVentaId
        })
      },
      { timeoutMs: 15000 } // mutación: sin reintento automático propio (lo maneja la cola de abajo), con más margen que una lectura chica
    );
    const data = await response.json();

    if (data.success && data.ventaId && data.ventaId !== ventaIdTemp) {
      // Actualizar el ID real en el recibo imprimible
      ultimaVentaImprimible.ventaId = data.ventaId;
      // Actualizar el ID visible en el modal de recibo si sigue abierto
      const idEl = document.getElementById("reciboVentaId");
      if (idEl) idEl.textContent = data.ventaId;
    } else if (!data.success) {
      toast("⚠️ La venta se mostró pero no se guardó en el servidor. Reintentá.", "error");
    }
  } catch (err) {
    console.error("Error al guardar venta en backend:", err);
    // Antes acá la venta se perdía directamente — el cajero ya le
    // había dado el ticket al cliente, pero la fila nunca llegaba a
    // VENTAS_LOCAL ni se descontaba el stock del lado del servidor, y
    // no había ninguna forma de recuperarla después. Ahora se guarda
    // en una cola local (localStorage) con el mismo clienteVentaId, y
    // se reintenta sola en cuanto vuelve la conexión — de forma
    // segura: el backend reconoce ese ID y nunca la duplica, aunque el
    // primer intento sí hubiera llegado a guardarse y solo se haya
    // perdido la respuesta.
    encolarVentaPendiente({
      clienteVentaId, total, formaPago: formaPagoPOS,
      observaciones: etiquetaDescuento ? "Descuento: " + etiquetaDescuento : "",
      carrito: itemsSnapshot
    });
    toast("📴 Sin conexión — la venta se guardó localmente y se subirá sola al reconectar", "error");
  }

  // Métricas en segundo plano
  setTimeout(() => { cargarMetricas(); invalidarCache("ventasPOS"); }, 500);

  } catch(err) {
    console.error("Error en confirmarFinalizarVenta:", err);
    toast("Error al finalizar la venta", "error");
  } finally {
    _ventaEnProceso = false;
    if (btnConfirmar) { btnConfirmar.disabled = false; btnConfirmar.textContent = "✅ Confirmar venta"; }
  }
}

async function finalizarVentaPOS() {
  // Si se llama directo (sin modal), abre el modal
  abrirModalFinalizarVenta();
}

/* ---- generar pedido desde el POS (no es una venta, no descuenta stock) ---- */

/** Opens the "Generar Pedido" modal, pre-filling the current ticket total */
function abrirModalPedidoAdmin() {
  if (ticketPOS.length === 0) { toast("El ticket está vacío, agregá productos primero", "error"); return; }

  const subtotal = ticketPOS.reduce((acc, item) => acc + (item.PRECIO * item.cantidad), 0);
  const { total } = calcularDescuentoPOS(subtotal);

  // Limpiar formulario
  paLimpiarCliente();
  document.getElementById("paTotal").textContent = "$" + total.toLocaleString("es-AR");
  document.getElementById("paTipoCambioWrap").style.display = "none";
  document.getElementById("paMoneda").value = "ARS";
  document.getElementById("paTipoCambio").value = "";

  // Poblar selector con clientes existentes — cargar si no están en memoria
  const selector = document.getElementById("paClienteSelector");
  if (selector) {
    selector.innerHTML = '<option value="">— Nuevo cliente / ingresar datos —</option>';
    const poblarSelector = (lista) => {
      const ordenados = [...lista].sort((a, b) =>
        (a.NOMBRE || a.CLIENTE || "").localeCompare(b.NOMBRE || b.CLIENTE || ""));
      ordenados.forEach(c => {
        const nombre = c.NOMBRE || c.CLIENTE || "";
        const dni = c.DNI ? ` · ${c.DNI}` : "";
        const opt = document.createElement("option");
        opt.value = c.CLIENTE_ID || c.DNI || "";
        opt.textContent = nombre + dni;
        selector.appendChild(opt);
      });
    };
    if (_clientesPedidoCache.length > 0) {
      poblarSelector(_clientesPedidoCache);
    } else {
      // Cargar todos los clientes de la hoja CLIENTES
      cargarClientesParaPedido().then(lista => { if (lista.length > 0) poblarSelector(lista); });
    }
  }

  document.getElementById("pedidoAdminModalBackdrop").classList.add("show");
  setTimeout(() => {
    const sel = document.getElementById("paClienteSelector");
    if (sel) sel.focus(); else document.getElementById("paNombre").focus();
  }, 80);
}

/** Rellena el formulario con los datos del cliente seleccionado */
function paSeleccionarCliente(clienteId) {
  if (!clienteId) { paLimpiarCliente(); return; }
  const lista = _clientesPedidoCache.length > 0 ? _clientesPedidoCache : clientesGlobal;
  const cliente = lista.find(c =>
    String(c.CLIENTE_ID || c.DNI || "") === String(clienteId));
  if (!cliente) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
  set("paNombre",       cliente.NOMBRE || cliente.CLIENTE);
  set("paEmpresa",      cliente.EMPRESA || "");
  set("paDireccion",    cliente.DIRECCION || "");
  set("paLocalidad",    cliente.LOCALIDAD || "");
  set("paProvincia",    cliente.PROVINCIA || "");
  set("paCodigoPostal", cliente.CODIGO_POSTAL || "");
  set("paTelefono",     cliente.TELEFONO || "");
  set("paDni",          cliente.DNI || "");
  chequearClienteCreditoPedidoAdmin();
}

/** Limpia el formulario para ingresar datos de cliente nuevo */
function paLimpiarCliente() {
  const sel = document.getElementById("paClienteSelector");
  if (sel) sel.value = "";
  ["paNombre","paEmpresa","paDireccion","paLocalidad","paProvincia",
   "paCodigoPostal","paTelefono","paDni"].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = "";
  });
  const monedaWrap = document.getElementById("paMonedaWrap");
  if (monedaWrap) monedaWrap.style.display = "none";
  // Limpiar también el ajuste de crédito
  const creditoEl = document.getElementById("paCreditoPct");
  if (creditoEl) creditoEl.value = "";
  const infoEl = document.getElementById("paCreditoInfo");
  if (infoEl) infoEl.style.display = "none";
}

/** Recalcula el total del pedido aplicando el % de crédito/recargo */
function paActualizarTotalConCredito() {
  const subtotal = ticketPOS.reduce((acc, item) => acc + (item.PRECIO * item.cantidad), 0);
  const { total: totalBase } = calcularDescuentoPOS(subtotal);

  const pct = Number(document.getElementById("paCreditoPct")?.value) || 0;
  const ajuste = Math.round(totalBase * pct / 100);
  const totalFinal = totalBase + ajuste;

  document.getElementById("paTotal").textContent = "$" + totalFinal.toLocaleString("es-AR");

  const info = document.getElementById("paCreditoInfo");
  if (info) {
    if (pct !== 0) {
      const signo = ajuste >= 0 ? "+" : "";
      const tipo = pct > 0 ? "Recargo" : "Descuento";
      info.textContent = `${tipo} ${Math.abs(pct)}%: ${signo}$${ajuste.toLocaleString("es-AR")} → Total: $${totalFinal.toLocaleString("es-AR")}`;
      info.style.color = pct > 0 ? "var(--red-500)" : "var(--green-600)";
      info.style.display = "block";
    } else {
      info.style.display = "none";
    }
  }
}

function cerrarModalPedidoAdmin() {
  document.getElementById("pedidoAdminModalBackdrop").classList.remove("show");
}

/** Checks if the typed DNI belongs to a client already marked as "a crédito" — if so, shows the currency selector */
async function chequearClienteCreditoPedidoAdmin() {
  const dni = document.getElementById("paDni").value.trim();
  const wrap = document.getElementById("paMonedaWrap");

  if (!dni) {
    wrap.style.display = "none";
    document.getElementById("paTipoCambioWrap").style.display = "none";
    return;
  }

  try {
    const response = await fetchAPI(API_URL + "?action=consultarClienteCreditoPorDni&dni=" + encodeURIComponent(dni));
    const data = await response.json();

    wrap.style.display = data.esCredito ? "block" : "none";
    if (!data.esCredito) {
      document.getElementById("paTipoCambioWrap").style.display = "none";
    } else {
      actualizarVisibilidadTipoCambioPedidoAdmin();
    }
  } catch (error) {
    console.error("Error al consultar cliente a crédito:", error);
    // Un error puntual de red no debe bloquear el pedido — simplemente
    // no se muestra el selector de moneda, y el pedido sigue en ARS.
  }
}

function actualizarVisibilidadTipoCambioPedidoAdmin() {
  const moneda = document.getElementById("paMoneda").value;
  document.getElementById("paTipoCambioWrap").style.display = moneda === "USD" ? "block" : "none";
}

async function confirmarPedidoAdmin() {
  if (ticketPOS.length === 0) { toast("El ticket está vacío", "error"); cerrarModalPedidoAdmin(); return; }

  const nombre = document.getElementById("paNombre").value.trim();
  const empresa = document.getElementById("paEmpresa").value.trim();
  const direccion = document.getElementById("paDireccion").value.trim();
  const localidad = document.getElementById("paLocalidad").value.trim();
  const provincia = document.getElementById("paProvincia").value.trim();
  const codigoPostal = document.getElementById("paCodigoPostal").value.trim();
  const telefono = document.getElementById("paTelefono").value.trim();
  const dni = document.getElementById("paDni").value.trim();

  if (!nombre || !direccion || !localidad || !provincia || !telefono || !dni) {
    toast("Completá Nombre, Dirección, Localidad, Provincia, Teléfono y DNI/CUIT", "error");
    return;
  }

  // Moneda y tipo de cambio solo importan si el selector está visible
  // (cliente a crédito) — para cualquier otro pedido, queda en ARS sin
  // tipo de cambio, igual que siempre.
  const monedaWrapVisible = document.getElementById("paMonedaWrap").style.display !== "none";
  const moneda = monedaWrapVisible ? document.getElementById("paMoneda").value : "ARS";
  const tipoCambio = document.getElementById("paTipoCambio").value.trim();

  if (moneda === "USD" && (!tipoCambio || Number(tipoCambio) <= 0)) {
    toast("Ingresá el tipo de cambio para un pedido en dólares", "error");
    return;
  }

  const subtotal = ticketPOS.reduce((acc, item) => acc + (item.PRECIO * item.cantidad), 0);
  const { total: totalBase } = calcularDescuentoPOS(subtotal);

  // Aplicar ajuste de crédito si fue ingresado
  const creditoPct = Number(document.getElementById("paCreditoPct")?.value) || 0;
  const ajusteCredito = Math.round(totalBase * creditoPct / 100);
  const total = totalBase + ajusteCredito;

  const btn = document.getElementById("btnConfirmarPedidoAdmin");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Creando pedido...";

  try {
    // Por POST, con el carrito en el body — no por GET con todo en la
    // URL. Un pedido con varios cientos de ítems arma una URL enorme
    // que Google/Apps Script rechaza (esto se sentía como "error de
    // conexión" sin serlo realmente). El body no tiene ese límite.
    const response = await fetchAPI(API_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" }, // evita preflight CORS contra Apps Script
      body: JSON.stringify({
        action: "guardarPedidoAdmin",
        nombre, empresa, direccion, localidad, provincia, codigoPostal, telefono, dni,
        total: total,
        moneda: moneda,
        tipoCambio: moneda === "USD" ? tipoCambio : "",
        carrito: ticketPOS
      })
    }, { timeoutMs: 30000 }); // pedidos grandes tardan más en subir — margen extra
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo crear el pedido", "error");
      return;
    }

    toast(`Pedido ${data.pedidoId} creado`, "success");
    cerrarModalPedidoAdmin();

    // El pedido no es una venta: el ticket se vacía igual, para que el
    // cajero pueda empezar de cero, pero sin tocar stock ni métricas
    // de ventas (a diferencia de finalizarVentaPOS).
    ticketPOS = [];
    resetearDescuentoPOS();
    renderTicketPOS();
    ultimoCodigoAgregadoPOS = null;
    posTileFocusIdx = -1;

  } catch (error) {
    console.error("Error al crear el pedido:", error);
    toast("Error de conexión al crear el pedido", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

/* ---- receipt modal ---- */

function mostrarRecibo(ventaId, items, total, subtotal, montoDescuento, recibido) {
  document.getElementById("receiptId").innerText = "#" + (ventaId || "—");

  let html = "";
  items.forEach(item => {
    const sub = item.PRECIO * item.cantidad;
    html += `
      <tr>
        <td>${item.cantidad}x ${escapeHtml(item.PRODUCTO)}</td>
        <td style="text-align:right;">$${sub.toLocaleString("es-AR")}</td>
      </tr>`;
  });

  if (montoDescuento > 0) {
    html += `
      <tr>
        <td>Subtotal</td>
        <td style="text-align:right;">$${Number(subtotal).toLocaleString("es-AR")}</td>
      </tr>
      <tr>
        <td style="color:var(--red-500);">Descuento</td>
        <td style="text-align:right;color:var(--red-500);">-$${Math.round(montoDescuento).toLocaleString("es-AR")}</td>
      </tr>`;
  }

  document.getElementById("receiptItems").innerHTML = html;
  document.getElementById("receiptTotal").innerText = "$" + total.toLocaleString("es-AR");

  // Mostrar cambio si se ingresó efectivo
  const cambioWrap = document.getElementById("receiptCambioWrap");
  const cambioEl = document.getElementById("receiptCambio");
  if (cambioWrap && cambioEl && recibido > 0) {
    const cambio = recibido - total;
    cambioEl.textContent = "$" + Math.max(0, cambio).toLocaleString("es-AR");
    cambioWrap.style.display = cambio >= 0 ? "flex" : "none";
  } else if (cambioWrap) {
    cambioWrap.style.display = "none";
  }

  document.getElementById("receiptBackdrop").classList.add("show");
  toast("Venta registrada con éxito", "success");
}

function cerrarRecibo() {
  document.getElementById("receiptBackdrop").classList.remove("show");
}

function nuevaVentaPOS() {
  cerrarRecibo();
  const input = document.getElementById("posBusqueda");
  if (input) input.focus();
}

/* =====================================================
   THERMAL PRINT — POS80 80mm paper
   Renders a receipt into #thermalPrintFrame and calls
   window.print(). The @media print rule hides everything
   except #thermalPrintFrame, and @page sets 80mm width.
===================================================== */

/**
 * Build the thermal HTML string.
 * @param {string}  ventaId
 * @param {Array}   items   — [{PRODUCTO, PRECIO, cantidad}, …]
 * @param {number}  total
 * @param {string}  formaPago
 * @param {Date}    fecha
 * @param {Object}  [descuento] — { monto, etiqueta } opcional, si la venta tuvo descuento
 * @param {Object}  [cfgOverride] — config del negocio a usar en vez de la guardada (solo para vista previa)
 */
function buildThermalHTML(ventaId, items, total, formaPago, fecha, descuento, cfgOverride, cambioData) {
  const cfg = cfgOverride || obtenerConfigNegocio();

  const fechaStr = (fecha || new Date()).toLocaleString("es-AR", {
    day:"2-digit", month:"2-digit", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  });

  let rows = "";
  let subtotal = 0;
  items.forEach(item => {
    const sub = item.PRECIO * item.cantidad;
    subtotal += sub;
    const unitStr = `${item.cantidad} x $${Number(item.PRECIO).toLocaleString("es-AR")}`;
    rows += `
      <tr>
        <td colspan="2" style="padding-bottom:0;">${escapeHtml(item.PRODUCTO)}</td>
      </tr>
      <tr>
        <td>${unitStr}</td>
        <td style="text-align:right;">$${sub.toLocaleString("es-AR")}</td>
      </tr>`;
  });

  const tieneDescuento = descuento && Number(descuento.monto) > 0;

  let filasTotales = "";
  if (tieneDescuento) {
    filasTotales += `
      <tr>
        <td>Subtotal</td>
        <td style="text-align:right;">$${subtotal.toLocaleString("es-AR")}</td>
      </tr>
      <tr>
        <td>Descuento${descuento.etiqueta ? " (" + escapeHtml(descuento.etiqueta) + ")" : ""}</td>
        <td style="text-align:right;">-$${Math.round(descuento.monto).toLocaleString("es-AR")}</td>
      </tr>`;
  }
  filasTotales += `
    <tr class="th-total-row">
      <td><strong>TOTAL</strong></td>
      <td style="text-align:right;"><strong>$${Number(total).toLocaleString("es-AR")}</strong></td>
    </tr>`;

  // Recibido y cambio — solo si se ingresó un monto recibido
  if (cambioData && cambioData.recibido > 0) {
    filasTotales += `
    <tr>
      <td>Recibido</td>
      <td style="text-align:right;">$${Number(cambioData.recibido).toLocaleString("es-AR")}</td>
    </tr>
    <tr>
      <td><strong>Cambio</strong></td>
      <td style="text-align:right;"><strong>${cambioData.cambioTexto}</strong></td>
    </tr>`;
  }

  // Encabezado: nombre + subtítulo + dirección + teléfono(s), todos configurables
  let encabezado = `<div class="th-center th-big">${escapeHtml(cfg.nombre)}</div>`;
  if (cfg.subtitulo) {
    encabezado += `<div class="th-center" style="font-size:9.5pt;font-weight:bold;">${escapeHtml(cfg.subtitulo)}</div>`;
  }
  if (cfg.direccion) {
    encabezado += `<div class="th-center" style="font-size:9pt;font-weight:bold;">${escapeHtml(cfg.direccion)}</div>`;
  }
  const telefonos = [cfg.telefono1, cfg.telefono2].filter(Boolean).join(" · ");
  if (telefonos) {
    encabezado += `<div class="th-center" style="font-size:9pt;font-weight:bold;margin-bottom:2mm;">Tel: ${escapeHtml(telefonos)}</div>`;
  } else {
    encabezado += `<div style="margin-bottom:2mm;"></div>`;
  }

  // Pie de página
  let pie = "";
  if (cfg.pie) {
    pie += `<div class="th-footer">${escapeHtml(cfg.pie)}</div>`;
  }
  pie += `<div class="th-footer" style="margin-top:1mm;">${escapeHtml(cfg.nombre)} &bull; Sistema POS</div>`;

  return `
    <div class="thermal-receipt">
      ${encabezado}
      <hr class="th-sep-solid">
      <div>Fecha: ${fechaStr}</div>
      <div>Venta: #${escapeHtml(String(ventaId || "—"))}</div>
      <div>Pago: ${escapeHtml(String(formaPago || "—"))}</div>
      <hr class="th-sep">
      <table>
        <tbody>${rows}</tbody>
        ${filasTotales}
      </table>
      <hr class="th-sep">
      ${pie}
      <br><br>
    </div>`;
}

/* ===================================================================
   IMPRESIÓN DIRECTA USB (Web Serial API — Chrome/Edge, sin diálogo)
   Construye los mismos tickets que buildThermalHTML/buildThermalCierreHTML
   pero como comandos ESC/POS en bytes crudos, enviados directo al
   puerto USB de la impresora. Es un camino alternativo: si está
   desactivado (o el navegador no lo soporta), todo sigue imprimiendo
   con el diálogo normal de Chrome, sin ningún cambio.
=================================================================== */

const USB_PRINT_PREF_KEY = "jireh_usb_print_enabled";
const ANCHO_TICKET_USB = 42; // columnas para fuente normal en 80mm (12 cpl aprox.)

let puertoImpresoraUSB = null; // SerialPort activo, o null si no hay conexión

/** Whether the browser supports Web Serial at all */
function soportaImpresionUSB() {
  return "serial" in navigator;
}

/** Reads the saved on/off preference for USB direct printing (per-browser, default off) */
function usbPrintHabilitado() {
  return soportaImpresionUSB() && localStorage.getItem(USB_PRINT_PREF_KEY) === "true";
}

/* ---------------------- ESC/POS byte builders ---------------------- */

const ESC = 0x1B;
const GS  = 0x1D;

const ESCPOS = {
  INIT:          [ESC, 0x40],             // reset printer
  ALIGN_LEFT:    [ESC, 0x61, 0x00],
  ALIGN_CENTER:  [ESC, 0x61, 0x01],
  BOLD_ON:       [ESC, 0x45, 0x01],
  BOLD_OFF:      [ESC, 0x45, 0x00],
  SIZE_NORMAL:   [GS, 0x21, 0x00],
  SIZE_DOUBLE_H: [GS, 0x21, 0x01],         // double height
  SIZE_BIG:      [GS, 0x21, 0x11],         // double width + height
  CUT:           [GS, 0x56, 0x01],         // partial cut
  FEED:          (n) => [ESC, 0x64, n]     // feed n lines
};

/** Builds the raw byte buffer (Uint8Array) for a sale ticket, mirroring buildThermalHTML */
function buildThermalESCPOS(ventaId, items, total, formaPago, fecha, descuento, cfgOverride) {
  const cfg = cfgOverride || obtenerConfigNegocio();
  const b = new EscPosBuilder();

  const fechaStr = (fecha || new Date()).toLocaleString("es-AR", {
    day:"2-digit", month:"2-digit", year:"numeric",
    hour:"2-digit", minute:"2-digit"
  });

  b.init();
  b.center(); b.big(); b.text(cfg.nombre); b.feed(1);
  b.normal();
  if (cfg.subtitulo) { b.center(); b.bold(); b.text(cfg.subtitulo); b.feed(1); b.boldOff(); }
  if (cfg.direccion) { b.center(); b.bold(); b.text(cfg.direccion); b.feed(1); b.boldOff(); }
  const telefonos = [cfg.telefono1, cfg.telefono2].filter(Boolean).join(" / ");
  if (telefonos) { b.center(); b.bold(); b.text("Tel: " + telefonos); b.feed(1); b.boldOff(); }

  b.left();
  b.sepSolid();
  b.bold();
  b.text("Fecha: " + fechaStr); b.feed(1);
  b.text("Venta: #" + String(ventaId || "—")); b.feed(1);
  b.text("Pago: " + String(formaPago || "—")); b.feed(1);
  b.sep();

  let subtotal = 0;
  items.forEach(item => {
    const sub = item.PRECIO * item.cantidad;
    subtotal += sub;
    b.bold();
    b.text(item.PRODUCTO); b.feed(1);
    b.row(`${item.cantidad} x $${money(item.PRECIO)}`, "$" + money(sub));
  });

  const tieneDescuento = descuento && Number(descuento.monto) > 0;
  if (tieneDescuento) {
    b.sep();
    b.row("Subtotal", "$" + money(subtotal));
    const etiquetaDesc = descuento.etiqueta ? `Descuento (${descuento.etiqueta})` : "Descuento";
    b.row(etiquetaDesc, "-$" + money(descuento.monto));
  }

  b.sepSolid();
  b.doubleH();
  b.row("TOTAL", "$" + money(total));
  b.normal();
  b.sep();

  b.bold();
  if (cfg.pie) { b.center(); b.text(cfg.pie); b.feed(1); }
  b.center(); b.text(cfg.nombre + " - Sistema POS"); b.feed(1);
  b.boldOff();

  b.feed(3);
  b.cut();

  return b.build();
}

/** Builds the raw byte buffer for a cierre de caja receipt, mirroring buildThermalCierreHTML */
function buildThermalCierreESCPOS(resumen) {
  const cfg = obtenerConfigNegocio();
  const b = new EscPosBuilder();

  const fechaStr = formatearFechaCierre(resumen.fecha);
  const horaStr = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  function filaMetodo(etiqueta, m) {
    const signo = m.diferencia > 0 ? "+" : "";
    b.bold();
    b.text(etiqueta); b.feed(1);
    b.row("Esperado", "$" + money(m.esperado));
    b.row("Contado", "$" + money(m.contado));
    b.row("Diferencia", signo + "$" + money(Math.round(m.diferencia)));
  }

  b.init();
  b.center(); b.big(); b.text(cfg.nombre); b.feed(1);
  b.normal();
  b.center(); b.bold(); b.text("Cierre de Caja"); b.feed(1); b.boldOff();
  if (cfg.direccion) { b.center(); b.bold(); b.text(cfg.direccion); b.feed(1); b.boldOff(); }
  const telefonos = [cfg.telefono1, cfg.telefono2].filter(Boolean).join(" / ");
  if (telefonos) { b.center(); b.bold(); b.text("Tel: " + telefonos); b.feed(1); b.boldOff(); }

  b.left();
  b.sepSolid();
  b.bold();
  b.text("Fecha: " + fechaStr); b.feed(1);
  b.text("Hora impresión: " + horaStr); b.feed(1);
  b.text("Cierre: #" + String(resumen.cierreId || "—")); b.feed(1);
  b.text("Vendedor: " + String(resumen.vendedor || "—")); b.feed(1);
  b.sep();

  b.bold(); b.text("VENTAS DEL DÍA"); b.feed(1); b.boldOff();
  b.row("Total ventas", "$" + money(resumen.totalVentas));
  b.row("  Efectivo", "$" + money(resumen.ventasEfectivo));
  b.row("  Transferencia", "$" + money(resumen.ventasTransferencia));
  b.row("  Tarjeta", "$" + money(resumen.ventasTarjeta));

  const egresos = resumen.egresosPorFormaPago || { EFECTIVO: 0, TRANSFERENCIA: 0, TARJETA: 0 };
  const filasEgresos = [
    ["  Efectivo", egresos.EFECTIVO],
    ["  Transferencia", egresos.TRANSFERENCIA],
    ["  Tarjeta", egresos.TARJETA]
  ].filter(([, monto]) => Number(monto) > 0);

  if (filasEgresos.length) {
    b.feed(1);
    b.bold(); b.text("EGRESOS DEL DÍA"); b.feed(1); b.boldOff();
    filasEgresos.forEach(([etiqueta, monto]) => b.row(etiqueta, "-$" + money(monto)));
  }
  b.sep();

  filaMetodo("EFECTIVO", resumen.efectivo); b.feed(1);
  filaMetodo("TRANSFERENCIA", resumen.transferencia); b.feed(1);
  filaMetodo("TARJETA", resumen.tarjeta);

  b.sepSolid();
  const signoTotal = resumen.total.diferencia > 0 ? "+" : "";
  b.row("TOTAL ESPERADO", "$" + money(resumen.total.esperado));
  b.row("TOTAL CONTADO", "$" + money(resumen.total.contado));
  b.row("DIFERENCIA", signoTotal + "$" + money(Math.round(resumen.total.diferencia)));
  b.sep();

  if (resumen.observaciones) {
    b.bold();
    b.text("Obs: " + resumen.observaciones); b.feed(1);
    b.sep();
  }

  b.bold();
  b.text("Cierre generado por " + cfg.nombre + " POS"); b.feed(1);
  b.boldOff();

  b.feed(3);
  b.cut();

  return b.build();
}

function money(n) {
  return Number(n || 0).toLocaleString("es-AR");
}

/** Small helper that accumulates ESC/POS bytes with simple word-wrap and two-column row support */
class EscPosBuilder {
  constructor() {
    this.bytes = [];
  }
  push(arr) { this.bytes.push(...arr); }
  init()    { this.push(ESCPOS.INIT); }
  center()  { this.push(ESCPOS.ALIGN_CENTER); }
  left()    { this.push(ESCPOS.ALIGN_LEFT); }
  bold()    { this.push(ESCPOS.BOLD_ON); }
  boldOff() { this.push(ESCPOS.BOLD_OFF); }
  normal()  { this.push(ESCPOS.SIZE_NORMAL); }
  doubleH() { this.push(ESCPOS.SIZE_DOUBLE_H); }
  big()     { this.push(ESCPOS.SIZE_BIG); }
  cut()     { this.push(ESCPOS.CUT); }
  feed(n)   { this.push(ESCPOS.FEED(n)); }

  /** Encodes text as bytes (Latin-1, which covers Spanish accents on most ESC/POS printers) */
  text(str) {
    const encoder = new TextEncoder(); // UTF-8; most modern POS80 controllers accept it fine
    this.push(Array.from(encoder.encode(String(str))));
  }

  sep() {
    this.bold();
    this.text("-".repeat(ANCHO_TICKET_USB));
    this.feed(1);
    this.boldOff();
  }

  sepSolid() {
    this.bold();
    this.text("=".repeat(ANCHO_TICKET_USB));
    this.feed(1);
    this.boldOff();
  }

  /** Prints a left label and a right-aligned value on the same 42-col line (wraps the label if too long) */
  row(left, right) {
    const rightStr = String(right);
    const maxLeft = ANCHO_TICKET_USB - rightStr.length - 1;
    let leftStr = String(left);
    if (leftStr.length > maxLeft) leftStr = leftStr.slice(0, Math.max(0, maxLeft));
    const spaces = Math.max(1, ANCHO_TICKET_USB - leftStr.length - rightStr.length);
    this.text(leftStr + " ".repeat(spaces) + rightStr);
    this.feed(1);
  }

  build() {
    return new Uint8Array(this.bytes);
  }
}

/* ---------------------- Web Serial connection ---------------------- */

/** Prompts the browser's port picker and opens the connection (must be called from a user gesture) */
async function conectarImpresoraUSB() {
  if (!soportaImpresionUSB()) {
    toast("Este navegador no soporta impresión directa", "error");
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 9600 });
    puertoImpresoraUSB = port;
    actualizarEstadoUSBPrint();
    toast("Impresora conectada", "success");
  } catch (error) {
    if (error.name !== "NotFoundError") { // user just closed the picker without choosing
      console.error("Error al conectar la impresora USB:", error);
      toast("No se pudo conectar con la impresora", "error");
    }
  }
}

async function desconectarImpresoraUSB() {
  if (puertoImpresoraUSB) {
    try { await puertoImpresoraUSB.close(); } catch (e) { /* ignore */ }
  }
  puertoImpresoraUSB = null;
  actualizarEstadoUSBPrint();
  toast("Impresora desconectada", "success");
}

/** Tries to silently reconnect to a previously-authorized port (no picker shown) when the app loads */
async function reconectarImpresoraUSBSiPosible() {
  if (!soportaImpresionUSB()) return;
  try {
    const ports = await navigator.serial.getPorts();
    if (ports.length > 0) {
      const port = ports[0];
      await port.open({ baudRate: 9600 });
      puertoImpresoraUSB = port;
    }
  } catch (error) {
    // Port may be in use or unplugged — just leave it disconnected, the admin can reconnect manually
    puertoImpresoraUSB = null;
  }
  actualizarEstadoUSBPrint();
}

/** Sends a raw byte buffer to the connected printer over Web Serial */
async function enviarBytesAImpresoraUSB(bytes) {
  if (!puertoImpresoraUSB || !puertoImpresoraUSB.writable) {
    throw new Error("La impresora USB no está conectada");
  }
  const writer = puertoImpresoraUSB.writable.getWriter();
  try {
    // Si la impresora está trabada, sin papel, o el cable se desconectó
    // a medias, writer.write() puede quedar esperando para siempre sin
    // resolver ni rechazar — el botón "parece" no responder porque en
    // realidad está esperando una escritura que nunca va a terminar.
    // Con este límite de tiempo, a los 4s se corta y se cae al diálogo
    // de impresión normal en vez de quedar colgado.
    const TIMEOUT_MS = 4000;
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error("Tiempo de espera agotado al escribir en la impresora USB")), TIMEOUT_MS);
    });
    try {
      await Promise.race([writer.write(bytes), timeout]);
    } finally {
      clearTimeout(timeoutId);
    }
  } finally {
    try { writer.releaseLock(); } catch(e) { /* puede fallar si la escritura seguía pendiente tras el timeout; no es crítico */ }
  }
}

function probarImpresoraUSB() {
  const b = new EscPosBuilder();
  b.init();
  b.center(); b.big(); b.text("PRUEBA"); b.feed(2);
  b.normal(); b.bold();
  b.text("Si ves esto, la impresión"); b.feed(1);
  b.text("directa por USB funciona bien."); b.feed(1);
  b.boldOff();
  b.feed(3);
  b.cut();

  enviarBytesAImpresoraUSB(b.build())
    .then(() => toast("Ticket de prueba enviado", "success"))
    .catch(error => {
      console.error("Error en impresión de prueba:", error);
      toast("No se pudo imprimir: revisá la conexión USB", "error");
    });
}

function onToggleUsbPrint() {
  const checked = document.getElementById("usbPrintToggle").checked;
  if (checked && !puertoImpresoraUSB) {
    toast("Conectá la impresora primero", "error");
    document.getElementById("usbPrintToggle").checked = false;
    return;
  }
  localStorage.setItem(USB_PRINT_PREF_KEY, checked ? "true" : "false");
  toast(checked ? "Impresión directa activada" : "Impresión directa desactivada", "success");
}

/** Refreshes the Configuración card UI to reflect support/connection state */
function actualizarEstadoUSBPrint() {
  const unsupportedEl = document.getElementById("usbPrintUnsupported");
  const supportedEl   = document.getElementById("usbPrintSupported");
  if (!unsupportedEl || !supportedEl) return; // section not in the DOM yet

  if (!soportaImpresionUSB()) {
    unsupportedEl.style.display = "flex";
    supportedEl.style.display = "none";
    return;
  }

  unsupportedEl.style.display = "none";
  supportedEl.style.display = "block";

  const statusEl     = document.getElementById("usbPrintStatus");
  const statusTextEl = document.getElementById("usbPrintStatusText");
  const btnConectar   = document.getElementById("btnConectarImpresora");
  const btnDesconectar = document.getElementById("btnDesconectarImpresora");
  const btnProbar      = document.getElementById("btnProbarImpresora");
  const toggle          = document.getElementById("usbPrintToggle");

  if (puertoImpresoraUSB) {
    statusEl.className = "usb-print-status ok";
    statusTextEl.textContent = "Impresora conectada";
    btnConectar.style.display = "none";
    btnDesconectar.style.display = "inline-block";
    btnProbar.style.display = "inline-block";
  } else {
    statusEl.className = "usb-print-status";
    statusTextEl.textContent = "Impresora no conectada";
    btnConectar.style.display = "inline-block";
    btnDesconectar.style.display = "none";
    btnProbar.style.display = "none";

    // Can't keep "impresión directa" on if there's nothing connected
    if (toggle) toggle.checked = false;
    localStorage.setItem(USB_PRINT_PREF_KEY, "false");
  }

  if (toggle) toggle.checked = usbPrintHabilitado();
}

/** Print the current (unsaved) ticket as a pre-sale receipt */
let _imprimiendoTicket = false; // evita disparar impresiones superpuestas si tocan el botón varias veces

function imprimirTicketThermal() {
  if (ticketPOS.length === 0) { toast("El ticket está vacío", "error"); return; }
  if (_imprimiendoTicket) return; // ya hay una impresión en curso — ignorar toques repetidos
  const subtotal = ticketPOS.reduce((acc, i) => acc + i.PRECIO * i.cantidad, 0);
  const { montoDescuento, total } = calcularDescuentoPOS(subtotal);
  const etiqueta = obtenerEtiquetaDescuentoPOS(subtotal);
  _ejecutarImpresion("PREVIO", ticketPOS, total, formaPagoPOS, new Date(),
    montoDescuento > 0 ? { monto: montoDescuento, etiqueta } : null);
}

/** Print after a completed sale (from receipt modal) */
function imprimirUltimoRecibo() {
  if (!ultimaVentaImprimible) { toast("No hay venta para imprimir", "error"); return; }
  const u = ultimaVentaImprimible;
  _ejecutarImpresion(u.ventaId, u.items, u.total, u.formaPago, u.fecha,
    u.descuento > 0 ? { monto: u.descuento, etiqueta: u.descuentoEtiqueta } : null);
}

/** Print a sale from the dashboard recent-sales table or the Ventas POS history */
function imprimirVentaDesdeData(ventaObj) {
  const items = [];
  // Try to parse items if stored as JSON string or array
  if (ventaObj.CARRITO) {
    try {
      const parsed = typeof ventaObj.CARRITO === "string"
        ? JSON.parse(ventaObj.CARRITO)
        : ventaObj.CARRITO;
      if (Array.isArray(parsed)) items.push(...parsed);
    } catch(e) { /* ignore */ }
  }
  // Fallback: show just a total line if no item detail
  if (items.length === 0) {
    items.push({ PRODUCTO: ventaObj.DETALLE || "Venta", PRECIO: Number(ventaObj.TOTAL || 0), cantidad: 1 });
  }

  // El descuento (si lo hubo) quedó guardado como texto en OBSERVACIONES,
  // ej: "Descuento: 10% (-$500) — cliente frecuente". Lo reconstruimos
  // calculando subtotal real de items vs. el TOTAL guardado (ya con descuento).
  const subtotalItems = items.reduce((acc, i) => acc + Number(i.PRECIO) * Number(i.cantidad), 0);
  const totalGuardado = Number(ventaObj.TOTAL || 0);
  const diferencia = subtotalItems - totalGuardado;

  const obs = String(ventaObj.OBSERVACIONES || "");
  let descuentoInfo = null;
  if (diferencia > 0.5 && /descuento/i.test(obs)) {
    descuentoInfo = { monto: diferencia, etiqueta: obs.replace(/^Descuento:\s*/i, "") };
  }

  _ejecutarImpresion(
    ventaObj.VENTA_ID || ventaObj.ID || "—",
    items,
    totalGuardado,
    ventaObj.FORMA_PAGO || ventaObj.PAGO || "—",
    ventaObj.FECHA ? new Date(ventaObj.FECHA) : new Date(),
    descuentoInfo
  );
}

function _ejecutarImpresion(ventaId, items, total, formaPago, fecha, descuento) {
  const cambioData = obtenerDatosCambio();

  const btn = document.getElementById("btnImprimirTicket");
  const textoOriginalBtn = btn ? btn.innerHTML : null;
  _imprimiendoTicket = true;
  if (btn) { btn.disabled = true; btn.innerHTML = "⏳"; }

  const liberar = () => {
    _imprimiendoTicket = false;
    if (btn) {
      btn.innerHTML = textoOriginalBtn;
      // El disabled real (según si el ticket tiene items) lo recalcula
      // renderTicketPOS/actualizarBotonesTicketPOS en su próximo render;
      // acá solo se saca el bloqueo temporal de "imprimiendo".
      btn.disabled = ticketPOS.length === 0;
    }
  };

  if (usbPrintHabilitado() && puertoImpresoraUSB) {
    const bytes = buildThermalESCPOS(ventaId, items, total, formaPago, fecha, descuento);
    enviarBytesAImpresoraUSB(bytes)
      .catch(error => {
        console.error("Error al imprimir por USB:", error);
        toast("Error al imprimir por USB — se abre el diálogo normal", "error");
        return _imprimirConDialogo(buildThermalHTML(ventaId, items, total, formaPago, fecha, descuento, null, cambioData));
      })
      .finally(liberar);
    return;
  }

  _imprimirConDialogo(buildThermalHTML(ventaId, items, total, formaPago, fecha, descuento, null, cambioData))
    .finally(liberar);
}

/** Falls back to the regular browser print dialog (used when USB printing is off, unsupported, or fails) */
async function _imprimirConDialogo(html) {
  const frame = document.getElementById("thermalPrintFrame");
  if (!frame) { toast("Error: frame de impresión no encontrado", "error"); return; }

  const etiquetasArea = document.getElementById("etiquetasPrintArea");
  if (etiquetasArea) etiquetasArea.innerHTML = "";

  frame.innerHTML = html;

  // Esperar a que el contenido del frame esté completamente pintado
  await new Promise(r => requestAnimationFrame(r));

  const imagenes = frame.querySelectorAll("img");
  if (imagenes.length > 0) {
    await Promise.all(Array.from(imagenes).map(img =>
      img.complete ? Promise.resolve() : new Promise(r => {
        img.onload = r; img.onerror = r;
        setTimeout(r, 2000); // máximo 2s de espera por imagen
      })
    ));
  }

  // NOTA: acá hubo dos intentos de calcular el alto real del ticket
  // (midiendo scrollHeight) para no pedirle a Windows una página más
  // grande de lo necesario y así imprimir más rápido. Los dos
  // terminaron cortando o desalineando tickets reales — medir el alto
  // de un elemento que normalmente está oculto (display:none) es
  // frágil: para que la medición sea correcta hay que "mostrarlo"
  // brevemente, y esa manipulación de estilos resultó nada confiable
  // en la práctica. Se vuelve a un alto fijo, simple y sin trucos:
  // menos veloz en teoría, pero nunca corta ni desalinea un ticket.
  const altoMicrones = 297000; // 297mm (largo A4) — margen de sobra para cualquier ticket, incluido el de cierre de caja

  // En Electron: impresión silenciosa sin diálogo del sistema
  const bridge = window.veekpos || window.posOffline;
  if (bridge && typeof bridge.imprimirSilencioso === "function") {
    const deviceName = localStorage.getItem("veekpos_impresora") || "";
    let result = await bridge.imprimirSilencioso({ deviceName, altoMicrones });

    // Causa más común de "tengo la impresora configurada y igual sale
    // el diálogo": el nombre guardado (de una lista de impresoras que
    // se cargó una vez) ya no coincide exactamente con cómo el driver
    // reporta la impresora ahora mismo (Windows es especialmente
    // propenso a esto — actualizaciones de driver, reconexión USB,
    // etc.). Antes, un solo fallo con ese nombre hacía caer directo al
    // diálogo visible; ahora, si había un nombre guardado, se reintenta
    // una vez dejando que Electron use la impresora predeterminada del
    // sistema — que suele ser la térmica igual — antes de rendirse.
    if (result && !result.success && deviceName) {
      console.warn(`Impresión silenciosa falló con la impresora guardada ("${deviceName}"): ${result.errorType}. Reintentando con la predeterminada del sistema...`);
      result = await bridge.imprimirSilencioso({ deviceName: "", altoMicrones });
    }

    if (result && !result.success) {
      console.warn("Impresión silenciosa falló:", result.errorType);
      toast(`No se pudo imprimir en silencio (${result.errorType || "motivo desconocido"}) — revisá la impresora en Configuración`, "error");
      window.print();
    }
    return;
  }

  // En el navegador web: diálogo normal
  window.print();
}

/* =====================================================
   THERMAL PRINT — CIERRE DE CAJA (POS80 80mm)
   Reusa el mismo #thermalPrintFrame y las reglas @media
   print ya definidas para el ticket de venta.
===================================================== */

/**
 * Build the thermal HTML string for a cash-register closing (cierre de caja).
 * @param {Object} resumen  — { fecha, cierreId, vendedor, observaciones,
 *                               efectivo:{esperado,contado,diferencia},
 *                               transferencia:{...}, tarjeta:{...}, total:{...} }
 */
function buildThermalCierreHTML(resumen) {
  const cfg = obtenerConfigNegocio();

  const fechaStr = formatearFechaCierre(resumen.fecha);
  const horaStr = new Date().toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" });

  function filaMetodo(etiqueta, m) {
    const signo = m.diferencia > 0 ? "+" : "";
    return `
      <tr>
        <td colspan="2" style="padding-top:2mm;"><strong>${etiqueta}</strong></td>
      </tr>
      <tr>
        <td>Esperado</td>
        <td style="text-align:right;">$${Number(m.esperado).toLocaleString("es-AR")}</td>
      </tr>
      <tr>
        <td>Contado</td>
        <td style="text-align:right;">$${Number(m.contado).toLocaleString("es-AR")}</td>
      </tr>
      <tr>
        <td>Diferencia</td>
        <td style="text-align:right;">${signo}$${Math.round(m.diferencia).toLocaleString("es-AR")}</td>
      </tr>`;
  }

  const signoTotal = resumen.total.diferencia > 0 ? "+" : "";

  const fmt = n => "$" + Number(n || 0).toLocaleString("es-AR");

  // Egresos del día, desglosados por forma de pago (solo se muestran
  // los que tuvieron movimiento para no ensuciar el ticket).
  const egresos = resumen.egresosPorFormaPago || { EFECTIVO: 0, TRANSFERENCIA: 0, TARJETA: 0 };
  const filasEgresos = [
    ["Efectivo", egresos.EFECTIVO],
    ["Transferencia", egresos.TRANSFERENCIA],
    ["Tarjeta", egresos.TARJETA]
  ].filter(([, monto]) => Number(monto) > 0);

  const bloqueVentasYEgresos = `
    <table>
      <tbody>
        <tr>
          <td colspan="2" style="padding-top:1mm;"><strong>VENTAS DEL DÍA</strong></td>
        </tr>
        <tr>
          <td>Total ventas</td>
          <td style="text-align:right;">${fmt(resumen.totalVentas)}</td>
        </tr>
        <tr>
          <td>&nbsp;&nbsp;Efectivo</td>
          <td style="text-align:right;">${fmt(resumen.ventasEfectivo)}</td>
        </tr>
        <tr>
          <td>&nbsp;&nbsp;Transferencia</td>
          <td style="text-align:right;">${fmt(resumen.ventasTransferencia)}</td>
        </tr>
        <tr>
          <td>&nbsp;&nbsp;Tarjeta</td>
          <td style="text-align:right;">${fmt(resumen.ventasTarjeta)}</td>
        </tr>
        ${filasEgresos.length ? `
        <tr>
          <td colspan="2" style="padding-top:2mm;"><strong>EGRESOS DEL DÍA</strong></td>
        </tr>
        ${filasEgresos.map(([etiqueta, monto]) => `
        <tr>
          <td>&nbsp;&nbsp;${etiqueta}</td>
          <td style="text-align:right;">−${fmt(monto)}</td>
        </tr>`).join("")}` : ""}
      </tbody>
    </table>
    <hr class="th-sep">`;

  // Encabezado: nombre del local + dirección + teléfono(s) (sin subtítulo, este ticket no es de venta)
  let encabezado = `<div class="th-center th-big">${escapeHtml(cfg.nombre)}</div>`;
  encabezado += `<div class="th-center" style="font-size:13pt;font-weight:bold;">Cierre de Caja</div>`;
  if (cfg.direccion) {
    encabezado += `<div class="th-center" style="font-size:13pt;font-weight:bold;">${escapeHtml(cfg.direccion)}</div>`;
  }
  const telefonos = [cfg.telefono1, cfg.telefono2].filter(Boolean).join(" · ");
  if (telefonos) {
    encabezado += `<div class="th-center" style="font-size:13pt;font-weight:bold;margin-bottom:2mm;">Tel: ${escapeHtml(telefonos)}</div>`;
  } else {
    encabezado += `<div style="margin-bottom:2mm;"></div>`;
  }

  return `
    <div class="thermal-receipt">
      ${encabezado}
      <hr class="th-sep-solid">
      <div>Fecha: ${escapeHtml(fechaStr)}</div>
      <div>Hora impresión: ${escapeHtml(horaStr)}</div>
      <div>Cierre: #${escapeHtml(String(resumen.cierreId || "—"))}</div>
      <div>Vendedor: ${escapeHtml(String(resumen.vendedor || "—"))}</div>
      <hr class="th-sep">
      ${bloqueVentasYEgresos}
      <table>
        <tbody>
          ${filaMetodo("EFECTIVO", resumen.efectivo)}
          ${filaMetodo("TRANSFERENCIA", resumen.transferencia)}
          ${filaMetodo("TARJETA", resumen.tarjeta)}
        </tbody>
        <tr class="th-total-row">
          <td><strong>TOTAL ESPERADO</strong></td>
          <td style="text-align:right;"><strong>$${Number(resumen.total.esperado).toLocaleString("es-AR")}</strong></td>
        </tr>
        <tr>
          <td><strong>TOTAL CONTADO</strong></td>
          <td style="text-align:right;"><strong>$${Number(resumen.total.contado).toLocaleString("es-AR")}</strong></td>
        </tr>
        <tr>
          <td><strong>DIFERENCIA</strong></td>
          <td style="text-align:right;"><strong>${signoTotal}$${Math.round(resumen.total.diferencia).toLocaleString("es-AR")}</strong></td>
        </tr>
      </table>
      <hr class="th-sep">
      ${resumen.observaciones ? `<div style="font-size:13pt;font-weight:bold;">Obs: ${escapeHtml(resumen.observaciones)}</div><hr class="th-sep">` : ""}
      <div class="th-footer">Cierre generado por ${escapeHtml(cfg.nombre)} POS</div>
      <br><br>
    </div>`;
}

/**
 * Imprime el cierre de caja actualmente visible en pantalla.
 * Usa los montos "esperado" ya cargados (cierreCajaResumenActual)
 * y los montos "contado" tal cual están en los inputs en este momento,
 * sin necesidad de haber guardado el cierre primero.
 */
function imprimirCierreCaja() {
  if (!cierreCajaResumenActual) {
    toast("Esperá a que se calculen las ventas del día", "error");
    return;
  }

  const esp = cierreCajaResumenActual.esperado;

  const efectivoContado      = Number(document.getElementById("ccEfectivoContado").value || 0);
  const transferenciaContado = Number(document.getElementById("ccTransferenciaContado").value || 0);
  const tarjetaContado       = Number(document.getElementById("ccTarjetaContado").value || 0);
  const observaciones        = document.getElementById("ccObservaciones").value || "";

  const efectivo = {
    esperado: esp.EFECTIVO,
    contado: efectivoContado,
    diferencia: efectivoContado - esp.EFECTIVO
  };
  const transferencia = {
    esperado: esp.TRANSFERENCIA,
    contado: transferenciaContado,
    diferencia: transferenciaContado - esp.TRANSFERENCIA
  };
  const tarjeta = {
    esperado: esp.TARJETA,
    contado: tarjetaContado,
    diferencia: tarjetaContado - esp.TARJETA
  };

  const totalEsperado = efectivo.esperado + transferencia.esperado + tarjeta.esperado;
  const totalContado  = efectivo.contado  + transferencia.contado  + tarjeta.contado;

  const mov = cierreCajaResumenActual.movimientosCaja || {};

  const resumen = {
    fecha: cierreCajaResumenActual.fecha,
    cierreId: (cierreCajaResumenActual.cierreExistente && cierreCajaResumenActual.cierreExistente.CIERRE_ID) || "PREVIO",
    vendedor: (cierreCajaResumenActual.cierreExistente && cierreCajaResumenActual.cierreExistente.VENDEDOR) || "ADMIN",
    observaciones,
    efectivo,
    transferencia,
    tarjeta,
    total: {
      esperado: totalEsperado,
      contado: totalContado,
      diferencia: totalContado - totalEsperado
    },
    // Datos para el bloque de "Ventas del día" / "Egresos del día" del ticket
    totalVentas: cierreCajaResumenActual.totalVentas,
    ventasEfectivo: cierreCajaResumenActual.ventasEfectivo,
    ventasTransferencia: cierreCajaResumenActual.ventasTransferencia,
    ventasTarjeta: cierreCajaResumenActual.ventasTarjeta,
    egresosPorFormaPago: mov.egresosPorFormaPago
  };

  if (usbPrintHabilitado() && puertoImpresoraUSB) {
    const bytes = buildThermalCierreESCPOS(resumen);
    enviarBytesAImpresoraUSB(bytes).catch(error => {
      console.error("Error al imprimir cierre por USB:", error);
      toast("Error al imprimir por USB — se abre el diálogo normal", "error");
      _imprimirConDialogo(buildThermalCierreHTML(resumen));
    });
    return;
  }

  _imprimirConDialogo(buildThermalCierreHTML(resumen));
}

/* ===================================================================
   BARCODE SCANNER SUPPORT + ATAJOS DE TECLADO DEL POS
=================================================================== */

let scanBuffer    = "";
let lastKeyTime   = 0;
const SCAN_KEY_THRESHOLD_MS = 40;

function setupScannerListener() {
  document.addEventListener("keydown", (e) => {
    // ---- Enter/Esc en modal de finalizar venta ----
    const modalFinalizar = document.getElementById("modalFinalizarVentaBackdrop");
    if (modalFinalizar && modalFinalizar.classList.contains("show")) {
      if (e.key === "Enter") { e.preventDefault(); confirmarFinalizarVenta(); return; }
      if (e.key === "Escape") { e.preventDefault(); cerrarModalFinalizarVenta(); return; }
    }

    // ---- Enter/Esc en modal de recibo ----
    const recibo = document.getElementById("receiptBackdrop");
    if (recibo && recibo.classList.contains("show")) {
      if (e.key === "Enter") { e.preventDefault(); imprimirUltimoRecibo(); return; }
      if (e.key === "Escape") { e.preventDefault(); cerrarRecibo(); return; }
    }

    const posSection = document.getElementById("pos");
    const posVisible = posSection && posSection.style.display === "block";
    if (!posVisible) return;

    // Ctrl+K / Cmd+K: foco directo al buscador, funciona incluso si el foco está en otro lado
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      const input = document.getElementById("posBusqueda");
      if (input) input.focus();
      return;
    }

    const activeTag  = document.activeElement ? document.activeElement.tagName : "";
    const isOurInput = document.activeElement && document.activeElement.id === "posBusqueda";

    // F2 finaliza la venta desde cualquier lado dentro del POS (incluso con el buscador enfocado)
    if (e.key === "F2") {
      e.preventDefault();
      abrirModalFinalizarVenta();
      return;
    }

    if (!isOurInput && (activeTag === "INPUT" || activeTag === "SELECT" || activeTag === "TEXTAREA")) return;

    // ---- Atajos que solo aplican cuando NO se está escribiendo en el buscador ----
    if (!isOurInput) {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft" || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        moverFocoPosGrid(e.key);
        return;
      }
      if (e.key === "Enter" && posTileFocusIdx >= 0) {
        e.preventDefault();
        agregarProductoEnFoco();
        return;
      }
      if (e.key === "+" || e.key === "=") {
        if (ultimoCodigoAgregadoPOS) { e.preventDefault(); cambiarCantidadPOS(ultimoCodigoAgregadoPOS, 1); }
        return;
      }
      if (e.key === "-") {
        if (ultimoCodigoAgregadoPOS) { e.preventDefault(); cambiarCantidadPOS(ultimoCodigoAgregadoPOS, -1); }
        return;
      }
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        const mapa = { "1": "EFECTIVO", "2": "TRANSFERENCIA", "3": "TARJETA" };
        const btn = document.querySelector(`.pay-method-btn[data-val="${mapa[e.key]}"]`);
        if (btn) { e.preventDefault(); elegirFormaPago(btn, mapa[e.key]); }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        vaciarTicketPOS();
        return;
      }
    }

    const now     = Date.now();
    const elapsed = now - lastKeyTime;
    lastKeyTime   = now;

    if (e.key === "Enter") {
      // Si el foco está en el buscador del POS, onPosInputKeyup (el
      // oninput="" de ese mismo <input>) ya se encarga de procesar
      // este Enter — dejarlo pasar también acá disparaba
      // agregarProductoPorCodigo() DOS VECES para el mismo escaneo
      // (una desde cada listener), una condición de carrera que podía
      // hacer fallar una de las dos búsquedas y mostrar "Producto no
      // encontrado" aunque el producto sí se agregara por la otra vía.
      if (isOurInput) { scanBuffer = ""; return; }

      if (scanBuffer.length >= 3) { agregarProductoPorCodigo(scanBuffer); setScannerStatus("listening"); }
      scanBuffer = "";
      return;
    }

    if (e.key.length === 1) {
      if (elapsed > 250) scanBuffer = "";
      scanBuffer += e.key;
      if (elapsed < SCAN_KEY_THRESHOLD_MS && scanBuffer.length >= 3) setScannerStatus("listening");
    }
  });

  setInterval(() => {
    if (Date.now() - lastKeyTime > 1200) setScannerStatus("idle");
  }, 500);
}

/** Moves the keyboard focus highlight across the visible product tiles in the grid */
function moverFocoPosGrid(tecla) {
  const tiles = Array.from(document.querySelectorAll("#posProductGrid .product-tile:not(.disabled)"));
  if (tiles.length === 0) return;

  // Estimate columns from actual layout so left/right and up/down both feel natural
  const primerTop = tiles[0].getBoundingClientRect().top;
  let columnas = 1;
  for (let i = 1; i < tiles.length; i++) {
    if (Math.abs(tiles[i].getBoundingClientRect().top - primerTop) > 2) { columnas = i; break; }
  }

  let nuevoIdx = posTileFocusIdx;
  if (nuevoIdx < 0) {
    nuevoIdx = 0;
  } else if (tecla === "ArrowRight") {
    nuevoIdx = Math.min(tiles.length - 1, nuevoIdx + 1);
  } else if (tecla === "ArrowLeft") {
    nuevoIdx = Math.max(0, nuevoIdx - 1);
  } else if (tecla === "ArrowDown") {
    nuevoIdx = Math.min(tiles.length - 1, nuevoIdx + columnas);
  } else if (tecla === "ArrowUp") {
    nuevoIdx = Math.max(0, nuevoIdx - columnas);
  }

  tiles.forEach(t => t.classList.remove("kbd-focus"));
  posTileFocusIdx = nuevoIdx;
  const tileActivo = tiles[posTileFocusIdx];
  if (tileActivo) {
    tileActivo.classList.add("kbd-focus");
    tileActivo.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

/** Adds to the ticket whichever tile currently has keyboard focus */
function agregarProductoEnFoco() {
  const tiles = Array.from(document.querySelectorAll("#posProductGrid .product-tile:not(.disabled)"));
  const tile = tiles[posTileFocusIdx];
  if (!tile || !tile.dataset.codigo) return;
  agregarProductoPOS(tile.dataset.codigo);
}

function setScannerStatus(estado) {
  const el = document.getElementById("scannerStatus");
  if (!el) return;
  if (estado === "listening") {
    el.className = "scanner-status listening";
    el.innerHTML = `<span class="dot"></span> Leyendo...`;
  } else if (estado === "camera") {
    el.className = "scanner-status camera";
    el.innerHTML = `<span class="dot"></span> Cámara activa`;
  } else {
    el.className = "scanner-status idle";
    el.innerHTML = `<span class="dot"></span> Listo`;
  }
}

/* ---- shortcuts help modal ---- */

function toggleShortcutsHelp() {
  document.getElementById("shortcutsHelpBackdrop").classList.toggle("show");
}
function cerrarShortcutsHelp(e) {
  if (e.target.id === "shortcutsHelpBackdrop") e.target.classList.remove("show");
}

/* ---- camera-based scanning ---- */

let camaraStream = null;
let camaraDetectorTimer = null;

async function abrirCamaraScan() {
  const backdrop  = document.getElementById("scanModalBackdrop");
  const videoWrap = document.getElementById("scanVideoWrap");
  const video     = document.getElementById("scanVideo");

  backdrop.classList.add("show");

  if (!("BarcodeDetector" in window)) {
    videoWrap.innerHTML = `
      <div class="scan-unsupported">
        Tu navegador no soporta el escaneo por cámara nativo.<br>
        Usá un lector USB, o Chrome/Edge en Android.
      </div>`;
    return;
  }

  try {
    camaraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = camaraStream;
    setScannerStatus("camera");
    document.getElementById("btnCameraScan").classList.add("active");

    const detector = new BarcodeDetector({
      formats: ["ean_13","ean_8","upc_a","upc_e","code_128","code_39","qr_code","itf"]
    });

    camaraDetectorTimer = setInterval(async () => {
      try {
        const codigos = await detector.detect(video);
        if (codigos.length > 0) {
          const valor = codigos[0].rawValue;
          cerrarCamaraScan();
          agregarProductoPorCodigo(valor);
        }
      } catch (err) { /* frame errors expected */ }
    }, 350);

  } catch (error) {
    console.error("Error de cámara:", error);
    videoWrap.innerHTML = `
      <div class="scan-unsupported">
        No se pudo acceder a la cámara.<br>
        Revisá los permisos del navegador e intentá de nuevo.
      </div>`;
  }
}

function cerrarCamaraScan() {
  const backdrop = document.getElementById("scanModalBackdrop");
  backdrop.classList.remove("show");

  if (camaraDetectorTimer) { clearInterval(camaraDetectorTimer); camaraDetectorTimer = null; }
  if (camaraStream) { camaraStream.getTracks().forEach(t => t.stop()); camaraStream = null; }

  document.getElementById("btnCameraScan").classList.remove("active");
  setScannerStatus("idle");

  document.getElementById("scanVideoWrap").innerHTML = `
    <video id="scanVideo" autoplay playsinline muted></video>
    <div class="scan-reticle"></div>`;
}

/* ===================================================================
   CIERRE DE CAJA — RECONCILIACION DIARIA
   Compara lo esperado (según VENTAS_LOCAL, por forma de pago) contra
   lo contado físicamente al cierre del día. Guarda el resultado en
   la hoja "CIERRES_CAJA" vía el backend.
=================================================================== */

let cierreCajaResumenActual = null; // último resumen "esperado" cargado del backend

/** Loads today's expected totals by payment method and pre-fills the form */
async function cargarResumenCierreCaja(fecha) {
  const estadoEl = document.getElementById("cierreCajaEstado");

  // Caché por fecha — 90 segundos (el cierre rara vez cambia en segundos,
  // pero queremos datos frescos si vuelven a entrar después de registrar movimientos)
  const CACHE_KEY = "vpos_cache_cierre_" + (fecha || "ayer");
  const CACHE_TTL = 90 * 1000;

  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts < CACHE_TTL) {
        aplicarDatosCierreCaja(data);
        if (estadoEl) estadoEl.textContent = "";
        return;
      }
    }
  } catch(e) {}

  if (estadoEl) estadoEl.textContent = "Calculando ventas del día...";

  try {
    const url = API_URL + "?action=cierreCajaResumen" + (fecha ? "&fecha=" + encodeURIComponent(fecha) : "");
    const response = await fetch(url);
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo calcular el resumen de caja", "error");
      if (estadoEl) estadoEl.textContent = "";
      return;
    }

    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch(e) {}
    aplicarDatosCierreCaja(data);
    if (estadoEl) estadoEl.textContent = "";

  } catch (error) {
    console.error("Error cierre de caja:", error);
    toast("Error al calcular el cierre de caja", "error");
    if (estadoEl) estadoEl.textContent = "";
  }
}

function invalidarCacheCierre(fecha) {
  try { localStorage.removeItem("vpos_cache_cierre_" + (fecha || "ayer")); } catch(e) {}
}

function aplicarDatosCierreCaja(data) {
  const estadoEl = document.getElementById("cierreCajaEstado");
  cierreCajaResumenActual = data;

  actualizarElemento("ccFechaLabel", formatearFechaCierre(data.fecha));
  actualizarElemento("ccCantidadVentas", data.cantidadVentas + (data.cantidadVentas === 1 ? " venta" : " ventas"));
  actualizarElemento("ccTotalVentas", "$" + Number(data.totalVentas || 0).toLocaleString("es-AR"));

  actualizarElemento("ccEfectivoEsperado",      "$" + Number(data.esperado.EFECTIVO).toLocaleString("es-AR"));
  actualizarElemento("ccTransferenciaEsperado", "$" + Number(data.esperado.TRANSFERENCIA).toLocaleString("es-AR"));
  actualizarElemento("ccTarjetaEsperado",       "$" + Number(data.esperado.TARJETA).toLocaleString("es-AR"));
  actualizarElemento("ccTotalEsperado",         "$" + Number(data.esperado.TOTAL).toLocaleString("es-AR"));

    // Desglose de movimientos y pagos de clientes — cada forma de pago
    // muestra solo lo que le corresponde a ella.
    const movDetalleEl = document.getElementById("ccMovimientosDetalle");
    const mov = data.movimientosCaja;
    const pfp = mov?.porFormaPago || {};
    const movEfectivo = Number(pfp.EFECTIVO || 0);
    const movTransferencia = Number(pfp.TRANSFERENCIA || 0);
    const movTarjeta = Number(pfp.TARJETA || 0);

    // Ingresos y egresos BRUTOS de cada forma de pago (no el neto). Si
    // un mismo día hay un ingreso y un egreso por el mismo importe en
    // la misma forma de pago, el neto da $0 — pero eso no significa
    // que no hubo ningún movimiento, así que mostrar el neto acá
    // ocultaría un ingreso y un egreso reales. Por eso se usan los
    // valores brutos que ya vienen separados desde el backend.
    const ingPorFormaPago = mov?.ingresosPorFormaPago || {};
    const egrPorFormaPago = mov?.egresosPorFormaPago || {};

    const pc = data.pagosClientes || {};
    const pcEfectivo = Number(pc.EFECTIVO || 0);
    const pcTransferencia = Number(pc.TRANSFERENCIA || 0);
    const pcTarjeta = Number(pc.TARJETA || 0);

    function mostrarLineaPagos(idLinea, idMonto, monto) {
      const lineaEl = document.getElementById(idLinea);
      if (!lineaEl) return;
      if (monto > 0) {
        actualizarElemento(idMonto, "$" + monto.toLocaleString("es-AR"));
        lineaEl.style.display = "flex";
      } else {
        lineaEl.style.display = "none";
      }
    }

    // Desglose de efectivo
    if (movDetalleEl && (movEfectivo !== 0 || pcEfectivo !== 0)) {
      actualizarElemento("ccVentasEfectivo", "$" + Number(data.ventasEfectivo || 0).toLocaleString("es-AR"));
      mostrarLineaPagos("ccPagosClientesEfectivoLinea", "ccPagosClientesEfectivo", pcEfectivo);
      const ingEf = Number(ingPorFormaPago.EFECTIVO || 0);
      const egrEf = Number(egrPorFormaPago.EFECTIVO || 0);
      actualizarElemento("ccMovIngresos", ingEf > 0 ? "+$" + ingEf.toLocaleString("es-AR") : "$0");
      actualizarElemento("ccMovEgresos",  egrEf > 0 ? "−$" + egrEf.toLocaleString("es-AR") : "$0");
      movDetalleEl.style.display = "flex";
    } else if (movDetalleEl) {
      movDetalleEl.style.display = "none";
    }

    // Desglose de transferencia
    const movTransfEl = document.getElementById("ccMovimientosDetalleTransf");
    if (movTransfEl) {
      if (movTransferencia !== 0 || pcTransferencia !== 0) {
        const ingTr = Number(ingPorFormaPago.TRANSFERENCIA || 0);
        const egrTr = Number(egrPorFormaPago.TRANSFERENCIA || 0);
        actualizarElemento("ccVentasTransferencia", "$" + Number(data.ventasTransferencia || 0).toLocaleString("es-AR"));
        mostrarLineaPagos("ccPagosClientesTransfLinea", "ccPagosClientesTransf", pcTransferencia);
        actualizarElemento("ccMovIngresosTransf", ingTr > 0 ? "+$" + ingTr.toLocaleString("es-AR") : "$0");
        actualizarElemento("ccMovEgresosTransf",  egrTr > 0 ? "−$" + egrTr.toLocaleString("es-AR") : "$0");
        movTransfEl.style.display = "flex";
      } else {
        movTransfEl.style.display = "none";
      }
    }

    // Desglose de tarjeta
    const movTarjetaEl = document.getElementById("ccMovimientosDetalleTarjeta");
    if (movTarjetaEl) {
      if (movTarjeta !== 0 || pcTarjeta !== 0) {
        const ingTa = Number(ingPorFormaPago.TARJETA || 0);
        const egrTa = Number(egrPorFormaPago.TARJETA || 0);
        actualizarElemento("ccVentasTarjeta", "$" + Number(data.ventasTarjeta || 0).toLocaleString("es-AR"));
        mostrarLineaPagos("ccPagosClientesTarjetaLinea", "ccPagosClientesTarjeta", pcTarjeta);
        actualizarElemento("ccMovIngresosTarjeta", ingTa > 0 ? "+$" + ingTa.toLocaleString("es-AR") : "$0");
        actualizarElemento("ccMovEgresosTarjeta",  egrTa > 0 ? "−$" + egrTa.toLocaleString("es-AR") : "$0");
        movTarjetaEl.style.display = "flex";
      } else {
        movTarjetaEl.style.display = "none";
      }
    }

    // If a closing already exists for this date, pre-fill counted amounts so the user can review/edit
    const inputEfectivo      = document.getElementById("ccEfectivoContado");
    const inputTransferencia = document.getElementById("ccTransferenciaContado");
    const inputTarjeta       = document.getElementById("ccTarjetaContado");

    if (data.yaCerrado && data.cierreExistente) {
      const c = data.cierreExistente;
      if (inputEfectivo)      inputEfectivo.value      = Number(c.EFECTIVO_CONTADO || 0);
      if (inputTransferencia) inputTransferencia.value = Number(c.TRANSFERENCIA_CONTADO || 0);
      if (inputTarjeta)       inputTarjeta.value        = Number(c.TARJETA_CONTADO || 0);
      const obsEl = document.getElementById("ccObservaciones");
      if (obsEl) obsEl.value = c.OBSERVACIONES || "";
      if (estadoEl) estadoEl.innerHTML = `⚠️ Ya existe un cierre guardado para esta fecha. Guardar de nuevo lo actualizará.`;
    } else {
      if (inputEfectivo)      inputEfectivo.value      = "";
      if (inputTransferencia) inputTransferencia.value = "";
      if (inputTarjeta)       inputTarjeta.value        = "";
      if (estadoEl) estadoEl.textContent = "";
    }

    calcularDiferenciasCierreCaja();
    cargarHistorialCierres();
}

function formatearFechaCierre(fechaStr) {
  if (!fechaStr) return "—";
  const [y, m, d] = fechaStr.split("-");
  return `${d}/${m}/${y}`;
}

/** Recalculates differences live as the user types counted amounts */
function calcularDiferenciasCierreCaja() {
  if (!cierreCajaResumenActual) return;

  const efectivoContado      = Number(document.getElementById("ccEfectivoContado").value || 0);
  const transferenciaContado = Number(document.getElementById("ccTransferenciaContado").value || 0);
  const tarjetaContado       = Number(document.getElementById("ccTarjetaContado").value || 0);

  const esp = cierreCajaResumenActual.esperado;

  const difEfectivo      = efectivoContado - esp.EFECTIVO;
  const difTransferencia = transferenciaContado - esp.TRANSFERENCIA;
  const difTarjeta       = tarjetaContado - esp.TARJETA;
  const difTotal         = difEfectivo + difTransferencia + difTarjeta;

  pintarDiferencia("ccEfectivoDif", difEfectivo);
  pintarDiferencia("ccTransferenciaDif", difTransferencia);
  pintarDiferencia("ccTarjetaDif", difTarjeta);
  pintarDiferencia("ccTotalDif", difTotal, true);

  const totalContado = efectivoContado + transferenciaContado + tarjetaContado;
  actualizarElemento("ccTotalContado", "$" + totalContado.toLocaleString("es-AR"));
}

function pintarDiferencia(id, valor, esTotal) {
  const el = document.getElementById(id);
  if (!el) return;

  const signo = valor > 0 ? "+" : "";
  el.textContent = signo + "$" + Math.round(valor).toLocaleString("es-AR");

  el.classList.remove("cc-dif-ok", "cc-dif-sobra", "cc-dif-falta");

  if (Math.abs(valor) < 1)      el.classList.add("cc-dif-ok");
  else if (valor > 0)           el.classList.add("cc-dif-sobra");
  else                          el.classList.add("cc-dif-falta");
}

/** Saves the daily reconciliation to the backend (CIERRES_CAJA sheet) */
async function guardarCierreCajaForm() {
  if (!cierreCajaResumenActual) { toast("Esperá a que se calculen las ventas del día", "error"); return; }

  const efectivoContado      = document.getElementById("ccEfectivoContado").value;
  const transferenciaContado = document.getElementById("ccTransferenciaContado").value;
  const tarjetaContado       = document.getElementById("ccTarjetaContado").value;
  const observaciones        = document.getElementById("ccObservaciones").value;

  if (efectivoContado === "" && transferenciaContado === "" && tarjetaContado === "") {
    toast("Ingresá al menos un monto contado", "error");
    return;
  }

  const btn = document.getElementById("btnGuardarCierreCaja");
  const textoOriginal = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Guardando..."; }

  try {
    const params = new URLSearchParams({
      action: "guardarCierreCaja",
      fecha: cierreCajaResumenActual.fecha,
      efectivoEsperado:      cierreCajaResumenActual.esperado.EFECTIVO,
      efectivoContado:       efectivoContado || 0,
      transferenciaEsperado: cierreCajaResumenActual.esperado.TRANSFERENCIA,
      transferenciaContado:  transferenciaContado || 0,
      tarjetaEsperado:       cierreCajaResumenActual.esperado.TARJETA,
      tarjetaContado:        tarjetaContado || 0,
      observaciones:         observaciones || ""
    });

    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo guardar el cierre de caja", "error");
      return;
    }

    toast(data.actualizado ? "Cierre de caja actualizado" : "Cierre de caja guardado", "success");
    cargarHistorialCierres();

  } catch (error) {
    console.error("Error al guardar cierre de caja:", error);
    toast("Error de conexión al guardar el cierre", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = textoOriginal; }
  }
}

/** Loads the recent reconciliation history table */
async function cargarHistorialCierres() {
  const CACHE_KEY = "vpos_cache_historial_cierres";
  const CACHE_TTL = 5 * 60 * 1000;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts < CACHE_TTL) { renderHistorialCierres(data); return; }
    }
  } catch(e) {}
  const tbody = document.getElementById("tablaCierresCaja");
  if (!tbody) return;

  try {
    const response = await fetchAPI(API_URL + "?action=historialCierres");
    const data = await response.json();
    const lista = data.cierres || [];

    if (lista.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">Todavía no hay cierres guardados</td></tr>`;
      return;
    }

    let html = "";
    lista.forEach(c => {
      const fecha = formatearFechaCierre(
        c.FECHA instanceof Date
          ? c.FECHA.toISOString().slice(0, 10)
          : String(c.FECHA).slice(0, 10)
      );
      const totalDif = Number(c.TOTAL_DIFERENCIA || 0);
      const claseDif = Math.abs(totalDif) < 1 ? "cc-dif-ok" : (totalDif > 0 ? "cc-dif-sobra" : "cc-dif-falta");
      const signo = totalDif > 0 ? "+" : "";

      html += `
        <tr>
          <td>${escapeHtml(fecha)}</td>
          <td class="money">$${Number(c.TOTAL_ESPERADO || 0).toLocaleString("es-AR")}</td>
          <td class="money">$${Number(c.TOTAL_CONTADO || 0).toLocaleString("es-AR")}</td>
          <td class="money ${claseDif}">${signo}$${Math.round(totalDif).toLocaleString("es-AR")}</td>
          <td>${escapeHtml(c.VENDEDOR || "—")}</td>
          <td>${escapeHtml(c.OBSERVACIONES || "—")}</td>
        </tr>`;
    });

    tbody.innerHTML = html;

  } catch (error) {
    console.error("Error al cargar historial de cierres:", error);
    tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted py-3">Error al cargar el historial</td></tr>`;
  }
}

/* ===================== REPORTES ===================== */

/** Lee el filtro de fecha compartido por los 6 reportes. Si está vacío, el backend usa el mes en curso. */
function obtenerRangoReportes() {
  const desde = document.getElementById("repDesde").value;
  const hasta = document.getElementById("repHasta").value;
  let qs = "";
  if (desde) qs += "&desde=" + encodeURIComponent(desde);
  if (hasta) qs += "&hasta=" + encodeURIComponent(hasta);
  return qs;
}

/** Dispara los 6 reportes a la vez con el rango de fecha actual. */
function cargarTodosLosReportes() {
  cargarReporteVentasPeriodo();
  cargarReporteProductos();
  cargarReporteCategorias();
  cargarReporteFormasPago();
  cargarReporteCierres();
  cargarReporteClientes();
}

/** Sincroniza los inputs de fecha "Desde"/"Hasta" con el rango que devolvió el backend (cuando no se eligió nada, para que el usuario vea qué período se está mostrando). */
function sincronizarRangoReportes(desde, hasta) {
  const inputDesde = document.getElementById("repDesde");
  const inputHasta = document.getElementById("repHasta");
  if (inputDesde && !inputDesde.value) inputDesde.value = desde;
  if (inputHasta && !inputHasta.value) inputHasta.value = hasta;
}

/* ---- Cache de sesión para reportes (no persistente) ---- */
const _reporteCache = {};
function _cacheReporte(key, data) { _reporteCache[key] = { ts: Date.now(), data }; }
function _getCacheReporte(key, ttlMs = 90000) {
  const c = _reporteCache[key];
  return (c && Date.now() - c.ts < ttlMs) ? c.data : null;
}

/* ---- Reporte 1: Ventas por período ---- */
async function cargarReporteVentasPeriodo() {
  const tbody = document.getElementById("repVentasPeriodoTabla");
  const resumenWrap = document.getElementById("repVentasPeriodoResumen");
  const cacheKey = "ventasPeriodo" + obtenerRangoReportes();
  const cached = _getCacheReporte(cacheKey);
  if (cached) { _aplicarReporteVentas(cached, tbody, resumenWrap); return; }

  try {
    const response = await fetchAPI(API_URL + "?action=reporteVentasPeriodo" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;
    _cacheReporte(cacheKey, data);
    _aplicarReporteVentas(data, tbody, resumenWrap);
  } catch (error) {
    console.error("Error reporte ventas:", error);
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-3">Error al cargar el reporte</td></tr>`;
  }
}

function _aplicarReporteVentas(data, tbody, resumenWrap) {
  sincronizarRangoReportes(data.desde, data.hasta);
  const r = data.resumen || {};
  resumenWrap.innerHTML = `
    <div class="col-6 col-md-3"><div class="card p-2 text-center"><div class="text-muted" style="font-size:11.5px;">Total POS</div><div class="money fw-bold">$${Number(r.totalPOS || 0).toLocaleString("es-AR")}</div></div></div>
    <div class="col-6 col-md-3"><div class="card p-2 text-center"><div class="text-muted" style="font-size:11.5px;">Total Pedidos</div><div class="money fw-bold">$${Number(r.totalPedidos || 0).toLocaleString("es-AR")}</div></div></div>
    <div class="col-6 col-md-3"><div class="card p-2 text-center"><div class="text-muted" style="font-size:11.5px;">Total general</div><div class="money fw-bold">$${Number(r.totalGeneral || 0).toLocaleString("es-AR")}</div></div></div>
    <div class="col-6 col-md-3"><div class="card p-2 text-center"><div class="text-muted" style="font-size:11.5px;">Ticket promedio</div><div class="money fw-bold">$${Number(r.ticketPromedio || 0).toLocaleString("es-AR")}</div></div></div>`;
  if (!data.dias || data.dias.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-3">Sin ventas para el rango elegido</td></tr>`;
    return;
  }

}

/* ---- Reporte 2: Productos más vendidos ---- */
async function cargarReporteProductos() {
  const _ck_repProductos = "reporteProductosVendidos" + obtenerRangoReportes();
  const _cd_repProductos = _getCacheReporte(_ck_repProductos);
  if (_cd_repProductos) { _aplicar_cargarReporteProductos(_cd_repProductos); return; }
  const tbody = document.getElementById("repProductosTabla");

  try {
    const response = await fetchAPI(API_URL + "?action=reporteProductosVendidos" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.productos || data.productos.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-3">Sin ventas para el rango elegido</td></tr>`;
      return;
    }

    tbody.innerHTML = data.productos.map(p => `
      <tr>
        <td class="mono">${escapeHtml(p.CODIGO)}</td>
        <td>${escapeHtml(p.PRODUCTO)}</td>
        <td class="money">${Number(p.VENDIDOS || 0).toLocaleString("es-AR")}</td>
        <td class="money">$${Number(p.INGRESOS || 0).toLocaleString("es-AR")}</td>
      </tr>`).join("");

  } catch (error) {
    console.error("Error al cargar reporte de productos vendidos:", error);
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-3">Error al cargar el reporte</td></tr>`;
  }
}

/* ---- Reporte 3: Ventas por categoría ---- */
async function cargarReporteCategorias() {
  const _ck_repCategorias = "reporteVentasPorCategoria" + obtenerRangoReportes();
  const _cd_repCategorias = _getCacheReporte(_ck_repCategorias);
  if (_cd_repCategorias) { _aplicar_cargarReporteCategorias(_cd_repCategorias); return; }
  const tbody = document.getElementById("repCategoriasTabla");

  try {
    const response = await fetchAPI(API_URL + "?action=reporteVentasPorCategoria" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.categorias || data.categorias.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted py-3">Sin ventas para el rango elegido</td></tr>`;
      return;
    }

    tbody.innerHTML = data.categorias.map(c => `
      <tr>
        <td>${escapeHtml(c.categoria)}</td>
        <td class="money">${Number(c.cantidad || 0).toLocaleString("es-AR")}</td>
        <td class="money">$${Number(c.ingresos || 0).toLocaleString("es-AR")}</td>
      </tr>`).join("");

  } catch (error) {
    console.error("Error al cargar reporte de ventas por categoría:", error);
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted py-3">Error al cargar el reporte</td></tr>`;
  }
}

/* ---- Reporte 4: Formas de pago ---- */
async function cargarReporteFormasPago() {
  const tbody = document.getElementById("repFormasPagoTabla");

  try {
    const response = await fetchAPI(API_URL + "?action=reporteFormasPago" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.formas || data.formas.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted py-3">Sin ventas para el rango elegido</td></tr>`;
      return;
    }

    tbody.innerHTML = data.formas.map(f => `
      <tr>
        <td>${escapeHtml(f.forma)}</td>
        <td class="money">${Number(f.cantidad || 0).toLocaleString("es-AR")}</td>
        <td class="money">$${Number(f.total || 0).toLocaleString("es-AR")}</td>
      </tr>`).join("");

  } catch (error) {
    console.error("Error al cargar reporte de formas de pago:", error);
    tbody.innerHTML = `<tr><td colspan="3" class="text-center text-muted py-3">Error al cargar el reporte</td></tr>`;
  }
}

/* ---- Reporte 5: Historial de cierres de caja ---- */
async function cargarReporteCierres() {
  const _ck_repCierres = "reporteCierres" + obtenerRangoReportes();
  const _cd_repCierres = _getCacheReporte(_ck_repCierres);
  if (_cd_repCierres) { _aplicar_cargarReporteCierres(_cd_repCierres); return; }
  const tbody = document.getElementById("repCierresTabla");

  try {
    const response = await fetchAPI(API_URL + "?action=reporteCierresCaja" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.cierres || data.cierres.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-3">Sin cierres para el rango elegido</td></tr>`;
      return;
    }

    tbody.innerHTML = data.cierres.map(c => {
      const fecha = c.FECHA ? new Date(c.FECHA).toLocaleDateString("es-AR") : "—";
      const totalDif = Number(c.TOTAL_DIFERENCIA || 0);
      const claseDif = Math.abs(totalDif) < 1 ? "cc-dif-ok" : (totalDif > 0 ? "cc-dif-sobra" : "cc-dif-falta");
      const signo = totalDif > 0 ? "+" : "";
      return `
      <tr>
        <td>${escapeHtml(fecha)}</td>
        <td class="money">$${Number(c.TOTAL_ESPERADO || 0).toLocaleString("es-AR")}</td>
        <td class="money">$${Number(c.TOTAL_CONTADO || 0).toLocaleString("es-AR")}</td>
        <td class="money ${claseDif}">${signo}$${Math.round(totalDif).toLocaleString("es-AR")}</td>
        <td>${escapeHtml(c.VENDEDOR || "—")}</td>
      </tr>`;
    }).join("");

  } catch (error) {
    console.error("Error al cargar reporte de cierres de caja:", error);
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-3">Error al cargar el reporte</td></tr>`;
  }
}

/* ---- Reporte 6: Clientes que más compran ---- */
async function cargarReporteClientes() {
  const _ck_repClientes = "reporteClientes" + obtenerRangoReportes();
  const _cd_repClientes = _getCacheReporte(_ck_repClientes);
  if (_cd_repClientes) { _aplicar_cargarReporteClientes(_cd_repClientes); return; }
  const tbody = document.getElementById("repClientesTabla");

  try {
    const response = await fetchAPI(API_URL + "?action=reporteClientes" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.clientes || data.clientes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-3">Sin pedidos para el rango elegido</td></tr>`;
      return;
    }

    tbody.innerHTML = data.clientes.map(c => `
      <tr>
        <td>${escapeHtml(c.CLIENTE)}</td>
        <td>${escapeHtml(c.EMPRESA || "—")}</td>
        <td class="money">${Number(c.PEDIDOS || 0).toLocaleString("es-AR")}</td>
        <td class="money">$${Number(c.TOTAL || 0).toLocaleString("es-AR")}</td>
      </tr>`).join("");

  } catch (error) {
    console.error("Error al cargar reporte de clientes:", error);
    tbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted py-3">Error al cargar el reporte</td></tr>`;
  }
}

/* ---- Exportar cualquiera de los 6 reportes a PDF ---- */
/**
 * Toma la tarjeta del reporte (por su id), lee la tabla que tiene
 * adentro, y genera un PDF con jsPDF + autoTable. Funciona igual
 * para los 6 reportes porque todos son <table> dentro de una .card.
 */
function exportarReportePDF(cardId, tituloReporte) {
  try {
    const card = document.getElementById(cardId);
    if (!card) return;

    const tabla = card.querySelector("table");
    if (!tabla) {
      toast("Este reporte no tiene datos para exportar", "error");
      return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

    const nombreLocal = (obtenerConfigNegocio().nombre || "Reporte").toString();
    const desde = document.getElementById("repDesde").value || "—";
    const hasta = document.getElementById("repHasta").value || "—";

    doc.setFontSize(14);
    doc.text(`${nombreLocal} — ${tituloReporte}`, 30, 30);
    doc.setFontSize(10);
    doc.setTextColor(110, 110, 110);
    doc.text(`Período: ${desde} a ${hasta}  ·  Generado: ${new Date().toLocaleString("es-AR")}`, 30, 46);

    doc.autoTable({
      html: tabla,
      startY: 58,
      theme: "grid",
      styles: { fontSize: 9, cellPadding: 5 },
      headStyles: { fillColor: [18, 32, 71], textColor: [255, 255, 255] }
    });

    const nombreArchivo = `${tituloReporte.replace(/\s+/g, "_")}_${desde}_a_${hasta}.pdf`;
    doc.save(nombreArchivo);

  } catch (error) {
    console.error("Error al exportar el reporte a PDF:", error);
    toast("No se pudo generar el PDF", "error");
  }
}


/* ===================================================================
   MOVIMIENTOS DE CAJA — ingresos y egresos manuales (no son ventas)
=================================================================== */

let tipoMovimientoCajaActivo = "INGRESO";

function elegirTipoMovimientoCaja(el, tipo) {
  tipoMovimientoCajaActivo = tipo;
  document.querySelectorAll(".mc-tipo-btn").forEach(b => b.classList.remove("active"));
  el.classList.add("active");
}

/** Loads today's manual cash movements and the running totals */
async function cargarMovimientosCajaHoy() {
  // Leer fecha del selector — default hoy
  const selector = document.getElementById("mcFechaSelector");
  if (selector && !selector.value) {
    const hoy = new Date().toISOString().slice(0, 10);
    selector.value = hoy;
  }
  const fecha = selector ? selector.value : new Date().toISOString().slice(0, 10);

  // Actualizar labels de resumen con la fecha seleccionada
  const fechaLabel = fecha === new Date().toISOString().slice(0, 10)
    ? "hoy"
    : new Date(fecha + "T12:00:00").toLocaleDateString("es-AR", { day: "2-digit", month: "2-digit" });
  const li = document.getElementById("mcLabelIngresos");
  const le = document.getElementById("mcLabelEgresos");
  if (li) li.textContent = `Ingresos — ${fechaLabel}`;
  if (le) le.textContent = `Egresos — ${fechaLabel}`;

  // Caché 60 segundos por fecha
  const CACHE_KEY = "vpos_cache_movimientos_" + fecha;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const { ts, data } = JSON.parse(raw);
      if (Date.now() - ts < 60000) {
        _aplicarMovimientos(data);
        return;
      }
    }
  } catch(e) {}

  try {
    const response = await fetchAPI(API_URL + "?action=movimientosCajaHoy&fecha=" + encodeURIComponent(fecha));
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo cargar movimientos de caja", "error");
      return;
    }

    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); } catch(e) {}
    _aplicarMovimientos(data);

  } catch (error) {
    console.error("Error al cargar movimientos de caja:", error);
    toast("Error de conexión al cargar movimientos de caja", "error");
  }
}

function _aplicarMovimientos(data) {
  actualizarElemento("mcTotalIngresos", "$" + Number(data.totalIngresos).toLocaleString("es-AR"));
  actualizarElemento("mcTotalEgresos",  "$" + Number(data.totalEgresos).toLocaleString("es-AR"));
  const netoEl = document.getElementById("mcSaldoNeto");
  if (netoEl) {
    netoEl.textContent = (data.neto >= 0 ? "$" : "-$") + Math.abs(data.neto).toLocaleString("es-AR");
    netoEl.style.color = data.neto >= 0 ? "var(--green-600)" : "var(--red-500)";
  }
  renderTablaMovimientosCaja(data.movimientos || []);
}

function renderTablaMovimientosCaja(lista) {
  const tbody = document.getElementById("tablaMovimientosCaja");
  if (!tbody) return;

  if (lista.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted py-3">Todavía no hay movimientos registrados</td></tr>`;
    return;
  }

  const iconoFormaPago = { EFECTIVO: "💵", TRANSFERENCIA: "📲", TARJETA: "💳" };

  let html = "";
  lista.forEach(m => {
    const esIngreso = String(m.TIPO).toUpperCase() === "INGRESO";
    const hora = m.FECHA_REGISTRO
      ? new Date(m.FECHA_REGISTRO).toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" })
      : "—";
    const fp = String(m.FORMA_PAGO || "EFECTIVO").toUpperCase();
    const fpIcon = iconoFormaPago[fp] || "💵";
    const fpLabel = fp.charAt(0) + fp.slice(1).toLowerCase();

    html += `
    <tr>
      <td>${hora}</td>
      <td><span class="mc-tag ${esIngreso ? "mc-ingreso" : "mc-egreso"}">${esIngreso ? "⬆️ Ingreso" : "⬇️ Egreso"}</span></td>
      <td>${escapeHtml(m.MOTIVO || "—")}</td>
      <td><span style="font-size:12.5px;">${fpIcon} ${fpLabel}</span></td>
      <td class="money" style="color:${esIngreso ? "var(--green-600)" : "var(--red-500)"};">
        ${esIngreso ? "+" : "-"}$${Number(m.MONTO || 0).toLocaleString("es-AR")}
      </td>
      <td>${escapeHtml(m.VENDEDOR || "—")}</td>
      <td><button class="btn btn-outline-danger btn-sm"
        onclick="confirmarEliminarMovimiento('${escapeHtml(m.MOVIMIENTO_ID)}', '${escapeHtml(m.MOTIVO || "")}')">✕</button></td>
    </tr>`;
  });

  tbody.innerHTML = html;
}

/** Pide confirmación con modal propio (confirm() bloquea el input en Electron) */
function confirmarEliminarMovimiento(movimientoId, motivo) {
  // Guardar ID en variable global para usar al confirmar
  window._movimientoParaEliminar = movimientoId;

  const backdrop = document.getElementById("modalEliminarMovBackdrop");
  const texto = document.getElementById("modalEliminarMovTexto");
  if (texto) texto.textContent = motivo
    ? `¿Eliminar el movimiento "${motivo}"? Esta acción no se puede deshacer.`
    : "¿Eliminar este movimiento? Esta acción no se puede deshacer.";
  if (backdrop) backdrop.classList.add("show");
}

function cerrarModalEliminarMov() {
  const backdrop = document.getElementById("modalEliminarMovBackdrop");
  if (backdrop) backdrop.classList.remove("show");
  window._movimientoParaEliminar = null;
}

async function eliminarMovimientoCajaForm(movimientoId) {
  const id = movimientoId || window._movimientoParaEliminar;
  cerrarModalEliminarMov();
  if (!id) return;

  try {
    const response = await fetchAPI(API_URL + "?action=eliminarMovimientoCaja&movimientoId=" + encodeURIComponent(id));
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo eliminar el movimiento", "error");
      return;
    }

    toast("Movimiento eliminado", "success");
    const fechaMov = document.getElementById("mcFechaSelector")?.value || new Date().toISOString().slice(0, 10);
    try { localStorage.removeItem("vpos_cache_movimientos_" + fechaMov); } catch(e) {}
    try { localStorage.removeItem("vpos_cache_cierre_" + fechaMov); } catch(e) {}
    try { localStorage.removeItem("vpos_cache_cierre_ayer"); } catch(e) {}
    cargarMovimientosCajaHoy();

  } catch (error) {
    console.error("Error al eliminar movimiento de caja:", error);
    toast("Error de conexión al eliminar el movimiento", "error");
  }
}

async function guardarMovimientoCajaForm() {
  const monto = document.getElementById("mcMonto").value;
  const motivo = document.getElementById("mcMotivo").value.trim();
  const formaPago = (document.getElementById("mcFormaPago")?.value || "EFECTIVO").toUpperCase();

  if (!monto || Number(monto) <= 0) { toast("Ingresá un monto válido", "error"); return; }
  if (!motivo) { toast("Ingresá un motivo para el movimiento", "error"); return; }

  const btn = document.getElementById("btnGuardarMovimientoCaja");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Guardando...";

  try {
    const params = new URLSearchParams({
      action: "guardarMovimientoCaja",
      tipo: tipoMovimientoCajaActivo,
      monto: monto,
      motivo: motivo,
      formaPago: formaPago
    });

    const response = await fetchAPI(API_URL + "?" + params.toString());
    const data = await response.json();

    if (!data.success) {
      toast(data.message || "No se pudo registrar el movimiento", "error");
      return;
    }

    toast(tipoMovimientoCajaActivo === "INGRESO" ? "Ingreso registrado" : "Egreso registrado", "success");
    document.getElementById("mcMonto").value = "";
    document.getElementById("mcMotivo").value = "";

    // Invalidar caché para que el cierre de caja muestre datos frescos
    const fecha = document.getElementById("mcFechaSelector")?.value || new Date().toISOString().slice(0, 10);
    try { localStorage.removeItem("vpos_cache_movimientos_" + fecha); } catch(e) {}
    try { localStorage.removeItem("vpos_cache_cierre_" + fecha); } catch(e) {}
    try { localStorage.removeItem("vpos_cache_cierre_ayer"); } catch(e) {}

    cargarMovimientosCajaHoy();

  } catch (error) {
    console.error("Error al guardar movimiento de caja:", error);
    toast("Error de conexión al registrar el movimiento", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

/* ===================================================================
   ETIQUETAS DE CÓDIGO DE BARRAS (para estantería/góndola)
=================================================================== */

/** Updates the selection counter and enables/disables the three label/QR generation buttons */
function actualizarSeleccionEtiquetas() {
  const checks = document.querySelectorAll(".check-producto-etiqueta:checked");
  const info = document.getElementById("etiquetasSeleccionInfo");
  const btnEtiquetas = document.getElementById("btnGenerarEtiquetas");
  const btnQR = document.getElementById("btnGenerarQR");
  const btnQROffline = document.getElementById("btnGenerarQROffline");

  const cantidad = checks.length;

  if (info) {
    info.textContent = cantidad === 0
      ? "Ningún producto seleccionado"
      : cantidad === 1
        ? "1 producto seleccionado"
        : `${cantidad} productos seleccionados`;
  }

  if (btnEtiquetas) btnEtiquetas.disabled = cantidad === 0;
  if (btnQR) btnQR.disabled = cantidad === 0;
  if (btnQROffline) btnQROffline.disabled = cantidad === 0;
}

/** Toggles every visible product checkbox via the header checkbox */
function toggleTodosProductos(checkboxHeader) {
  document.querySelectorAll(".check-producto-etiqueta").forEach(c => {
    c.checked = checkboxHeader.checked;
  });
  actualizarSeleccionEtiquetas();
}

/** Returns the list of currently-checked product codes */
function obtenerCodigosSeleccionados() {
  return Array.from(document.querySelectorAll(".check-producto-etiqueta:checked")).map(c => c.value);
}

function abrirModalEtiquetas() {
  const codigos = obtenerCodigosSeleccionados();
  if (codigos.length === 0) { toast("Seleccioná al menos un producto", "error"); return; }

  actualizarPreviewEtiquetas();
  document.getElementById("etiquetasModalBackdrop").classList.add("show");
}

function cerrarModalEtiquetas() {
  document.getElementById("etiquetasModalBackdrop").classList.remove("show");
}

/** Shows a quick text summary (no barcodes yet — those render only at print time) */
function actualizarPreviewEtiquetas() {
  const codigos = obtenerCodigosSeleccionados();
  const copias = Math.max(1, Number(document.getElementById("etqCantidadCopias").value || 1));
  const totalEtiquetas = codigos.length * copias;

  const info = document.getElementById("etiquetasPreviewInfo");
  if (info) {
    info.textContent = `Se van a imprimir ${totalEtiquetas} etiqueta${totalEtiquetas === 1 ? "" : "s"} en total (${codigos.length} producto${codigos.length === 1 ? "" : "s"} × ${copias} copia${copias === 1 ? "" : "s"}).`;
  }
}

/**
 * Builds the printable label grid (one <div> per label, with an <svg>
 * placeholder per barcode) and renders the actual barcodes into those
 * placeholders with JsBarcode — then triggers the browser's print
 * dialog. Runs entirely client-side, same approach as the PDF catalog
 * download: no server round-trip per label.
 */
function imprimirEtiquetas() {
  const codigos = obtenerCodigosSeleccionados();
  if (codigos.length === 0) { toast("Seleccioná al menos un producto", "error"); return; }

  const copias = Math.max(1, Number(document.getElementById("etqCantidadCopias").value || 1));
  const columnas = document.getElementById("etqColumnas").value;

  const productos = codigos
    .map(codigo => productosAdminGlobal.find(p => String(p.CODIGO) === String(codigo)))
    .filter(Boolean);

  if (productos.length === 0) {
    toast("No se encontraron los productos seleccionados", "error");
    return;
  }

  const printArea = document.getElementById("etiquetasPrintArea");

  // Por si quedó contenido de una impresión de ticket térmico anterior
  // a medio camino, se limpia el otro contenedor de impresión para que
  // el CSS de :empty/:not(:empty) elija el correcto sin ambigüedad.
  const thermalFrame = document.getElementById("thermalPrintFrame");
  if (thermalFrame) thermalFrame.innerHTML = "";

  let html = `<div class="etiquetas-grid cols-${columnas}">`;

  let idx = 0;
  productos.forEach(p => {
    for (let copia = 0; copia < copias; copia++) {
      const svgId = `etqSvg${idx}`;
      html += `
        <div class="etiqueta-item">
          <div class="etiqueta-nombre">${escapeHtml(p.PRODUCTO)}</div>
          <svg class="etiqueta-barcode-svg" id="${svgId}"></svg>
          <div class="etiqueta-codigo-texto">${escapeHtml(p.CODIGO)}</div>
          <div class="etiqueta-precio">$${Number(p.PRECIO || 0).toLocaleString("es-AR")}</div>
        </div>`;
      idx++;
    }
  });

  html += `</div>`;
  printArea.innerHTML = html;

  // JsBarcode necesita que el <svg> ya esté en el DOM antes de dibujar
  // adentro — por eso se llena el HTML primero y se recorre después.
  idx = 0;
  productos.forEach(p => {
    for (let copia = 0; copia < copias; copia++) {
      try {
        JsBarcode(`#etqSvg${idx}`, String(p.CODIGO), {
          format: "CODE128",
          displayValue: false, // el código ya se muestra como texto aparte, en una fuente más legible
          width: 1.6,
          height: 38,
          margin: 4
        });
      } catch (error) {
        // Un código vacío o con caracteres no soportados no debe
        // frenar la impresión del resto de las etiquetas.
        console.error("No se pudo generar el código de barras para", p.CODIGO, error);
      }
      idx++;
    }
  });

  cerrarModalEtiquetas();

  // Pequeño delay para asegurar que los SVG ya se pintaron en el DOM
  // antes de que el navegador capture el contenido para imprimir.
  setTimeout(() => {
    window.print();
  }, 200);
}

/* ===================================================================
   QR DE PRECIO (consulta pública del precio actualizado, sin login)
=================================================================== */

function abrirModalQR() {
  const codigos = obtenerCodigosSeleccionados();
  if (codigos.length === 0) { toast("Seleccioná al menos un producto", "error"); return; }

  if (!configNegocioCache.urlCatalogo) {
    toast("Configurá primero la URL del catálogo en Configuración → Catálogo online", "error");
    return;
  }

  actualizarPreviewQR();
  document.getElementById("qrModalBackdrop").classList.add("show");
}

function cerrarModalQR() {
  document.getElementById("qrModalBackdrop").classList.remove("show");
}

function actualizarPreviewQR() {
  const codigos = obtenerCodigosSeleccionados();
  const copias = Math.max(1, Number(document.getElementById("qrCantidadCopias").value || 1));
  const totalQR = codigos.length * copias;

  const info = document.getElementById("qrPreviewInfo");
  if (info) {
    info.textContent = `Se van a imprimir ${totalQR} código${totalQR === 1 ? "" : "s"} QR en total (${codigos.length} producto${codigos.length === 1 ? "" : "s"} × ${copias} copia${copias === 1 ? "" : "s"}).`;
  }
}

/** Builds the public "consultar precio" URL for a given product code */
function construirUrlPrecio(codigo) {
  const base = (configNegocioCache.urlCatalogo || "").replace(/\/+$/, "");
  return `${base}/precio.html?codigo=${encodeURIComponent(codigo)}`;
}

/**
 * Builds the printable QR grid and renders each QR with QRCode.js into
 * its placeholder <div> — then triggers the print dialog. Same
 * client-side approach as the barcode labels: no server round-trip.
 */
function imprimirQR() {
  const codigos = obtenerCodigosSeleccionados();
  if (codigos.length === 0) { toast("Seleccioná al menos un producto", "error"); return; }

  if (!configNegocioCache.urlCatalogo) {
    toast("Configurá primero la URL del catálogo en Configuración → Catálogo online", "error");
    return;
  }

  const copias = Math.max(1, Number(document.getElementById("qrCantidadCopias").value || 1));
  const columnas = document.getElementById("qrColumnas").value;

  const productos = codigos
    .map(codigo => productosAdminGlobal.find(p => String(p.CODIGO) === String(codigo)))
    .filter(Boolean);

  if (productos.length === 0) {
    toast("No se encontraron los productos seleccionados", "error");
    return;
  }

  const printArea = document.getElementById("etiquetasPrintArea");

  // Mismo cuidado que en las etiquetas de código de barras: se limpia
  // el otro contenedor de impresión para que el CSS :empty/:not(:empty)
  // elija el correcto sin ambigüedad.
  const thermalFrame = document.getElementById("thermalPrintFrame");
  if (thermalFrame) thermalFrame.innerHTML = "";

  let html = `<div class="etiquetas-grid cols-${columnas}">`;

  let idx = 0;
  productos.forEach(p => {
    for (let copia = 0; copia < copias; copia++) {
      html += `
        <div class="qr-item">
          <div class="qr-nombre">${escapeHtml(p.PRODUCTO)}</div>
          <div id="qrCanvas${idx}"></div>
          <div class="qr-leyenda">Escaneá para ver el precio</div>
        </div>`;
      idx++;
    }
  });

  html += `</div>`;
  printArea.innerHTML = html;

  // QRCode.js necesita que el contenedor ya esté en el DOM antes de
  // dibujar adentro — por eso se llena el HTML primero y se recorre después.
  idx = 0;
  productos.forEach(p => {
    const url = construirUrlPrecio(p.CODIGO);
    for (let copia = 0; copia < copias; copia++) {
      try {
        new QRCode(document.getElementById(`qrCanvas${idx}`), {
          text: url,
          width: 120,
          height: 120,
          colorDark: "#000000",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (error) {
        // Un error puntual generando un QR no debe frenar la
        // impresión del resto.
        console.error("No se pudo generar el QR para", p.CODIGO, error);
      }
      idx++;
    }
  });

  cerrarModalQR();

  setTimeout(() => {
    window.print();
  }, 200);
}

/* ===================================================================
   QR DE IDENTIFICACIÓN (offline, solo nombre del producto)
   A diferencia del QR de Precio, NO apunta a ninguna URL — codifica
   directamente el texto del nombre. Por eso cualquier lector de QR lo
   muestra al instante, sin necesidad de internet ni de que el backend
   esté disponible. Pensado para identificar cajas en el depósito.
=================================================================== */

function abrirModalQROffline() {
  const codigos = obtenerCodigosSeleccionados();
  if (codigos.length === 0) { toast("Seleccioná al menos un producto", "error"); return; }

  actualizarPreviewQROffline();
  document.getElementById("qrOfflineModalBackdrop").classList.add("show");
}

function cerrarModalQROffline() {
  document.getElementById("qrOfflineModalBackdrop").classList.remove("show");
}

function actualizarPreviewQROffline() {
  const codigos = obtenerCodigosSeleccionados();
  const copias = Math.max(1, Number(document.getElementById("qrOfflineCantidadCopias").value || 1));
  const totalQR = codigos.length * copias;

  const info = document.getElementById("qrOfflinePreviewInfo");
  if (info) {
    info.textContent = `Se van a imprimir ${totalQR} código${totalQR === 1 ? "" : "s"} QR en total (${codigos.length} producto${codigos.length === 1 ? "" : "s"} × ${copias} copia${copias === 1 ? "" : "s"}).`;
  }
}

/**
 * Builds the printable QR grid where each QR encodes just the plain
 * product name as text (not a URL) — works with any QR reader with
 * zero network involved, on either end.
 */
function imprimirQROffline() {
  const codigos = obtenerCodigosSeleccionados();
  if (codigos.length === 0) { toast("Seleccioná al menos un producto", "error"); return; }

  const copias = Math.max(1, Number(document.getElementById("qrOfflineCantidadCopias").value || 1));
  const columnas = document.getElementById("qrOfflineColumnas").value;

  const productos = codigos
    .map(codigo => productosAdminGlobal.find(p => String(p.CODIGO) === String(codigo)))
    .filter(Boolean);

  if (productos.length === 0) {
    toast("No se encontraron los productos seleccionados", "error");
    return;
  }

  const printArea = document.getElementById("etiquetasPrintArea");

  const thermalFrame = document.getElementById("thermalPrintFrame");
  if (thermalFrame) thermalFrame.innerHTML = "";

  let html = `<div class="etiquetas-grid cols-${columnas}">`;

  let idx = 0;
  productos.forEach(p => {
    for (let copia = 0; copia < copias; copia++) {
      html += `
        <div class="qr-item">
          <div class="qr-nombre">${escapeHtml(p.PRODUCTO)}</div>
          <div id="qrOfflineCanvas${idx}"></div>
          <div class="qr-leyenda">Funciona sin internet</div>
        </div>`;
      idx++;
    }
  });

  html += `</div>`;
  printArea.innerHTML = html;

  idx = 0;
  productos.forEach(p => {
    for (let copia = 0; copia < copias; copia++) {
      try {
        new QRCode(document.getElementById(`qrOfflineCanvas${idx}`), {
          text: String(p.PRODUCTO || ""),
          width: 120,
          height: 120,
          colorDark: "#000000",
          colorLight: "#ffffff",
          correctLevel: QRCode.CorrectLevel.M
        });
      } catch (error) {
        console.error("No se pudo generar el QR de identificación para", p.CODIGO, error);
      }
      idx++;
    }
  });

  cerrarModalQROffline();

  setTimeout(() => {
    window.print();
  }, 200);
}


/* =========================================================
   SISTEMA DE LICENCIAS
   Usa window.veekpos (preload.js) → main.js → license-client.js → Apps Script
========================================================= */

let estadoLicenciaActual = { activada: false, modoLimitado: true };

async function aplicarEstadoLicencia() {
  if (typeof window.veekpos === "undefined" || !window.veekpos.obtenerEstadoLicencia) return;
  try {
    estadoLicenciaActual = await window.veekpos.obtenerEstadoLicencia();
  } catch (error) { console.error("Error licencia:", error); return; }

  const pantallaActivacion = document.getElementById("licenseScreenBackdrop");
  const banner = document.getElementById("licenseLimitedBanner");
  const bannerTexto = document.getElementById("licenseLimitedBannerText");

  if (!estadoLicenciaActual.activada) {
    if (pantallaActivacion) pantallaActivacion.classList.add("show");
    if (banner) banner.style.display = "none";
    const urlGuardada = await window.veekpos.obtenerUrlServidorLicencia?.() || "";
    const inputUrl = document.getElementById("licenseScreenUrlServidor");
    if (inputUrl && urlGuardada && !inputUrl.value) inputUrl.value = urlGuardada;
    return;
  }

  if (pantallaActivacion) pantallaActivacion.classList.remove("show");

  if (estadoLicenciaActual.modoLimitado) {
    if (banner) {
      banner.style.display = "flex";
      if (bannerTexto) bannerTexto.textContent = "⚠️ " + (estadoLicenciaActual.motivo || "Licencia no vigente") + " — no se pueden registrar ventas ni editar productos.";
    }
  } else {
    if (banner) banner.style.display = "none";
  }
  actualizarBloqueosPorLicencia();
  const configVisible = document.getElementById("configuracion")?.style.display === "block";
  if (configVisible) mostrarEstadoLicenciaEnConfig();
}

function actualizarBloqueosPorLicencia() {
  const bloqueado = estadoLicenciaActual.modoLimitado;
  const btnFinalizar = document.getElementById("btnFinalizarVenta");
  if (btnFinalizar) btnFinalizar.disabled = bloqueado || ticketPOS.length === 0;
  document.querySelectorAll(".btn-accion-producto").forEach(btn => { btn.disabled = bloqueado; });
}

async function activarLicenciaForm() {
  const urlServidor = document.getElementById("licenseScreenUrlServidor").value.trim();
  const email = document.getElementById("licenseScreenEmail").value.trim();
  const pin = document.getElementById("licenseScreenPin").value.trim();
  const errorBox = document.getElementById("licenseScreenError");
  if (errorBox) errorBox.style.display = "none";
  if (!urlServidor || !email || !pin) {
    if (errorBox) { errorBox.style.display = "block"; errorBox.textContent = "Completá la URL, el email y el PIN."; }
    return;
  }
  const btn = document.getElementById("licenseScreenBtn");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true; btn.innerHTML = "Activando...";
  try {
    await window.veekpos.fijarUrlServidorLicencia(urlServidor);
    const resultado = await window.veekpos.activarLicencia(email, pin);
    if (!resultado.success) {
      if (errorBox) { errorBox.style.display = "block"; errorBox.textContent = resultado.message || "No se pudo activar la licencia"; }
      return;
    }
    toast("Licencia activada correctamente", "success");
    await aplicarEstadoLicencia();
  } catch (error) {
    if (errorBox) { errorBox.style.display = "block"; errorBox.textContent = "Error: " + String(error.message || error); }
  } finally { btn.disabled = false; btn.innerHTML = textoOriginal; }
}

async function guardarUrlServidorLicencia() {
  const url = (document.getElementById("cfgLicenciaUrlServidor")?.value || "").trim();
  if (!url) { toast("Ingresá la URL del servidor", "error"); return; }
  try { await window.veekpos?.fijarUrlServidorLicencia?.(url); toast("URL guardada", "success"); }
  catch (e) { toast("Error al guardar", "error"); }
}

async function validarLicenciaAhoraBtn() {
  const btn = event?.target;
  const orig = btn ? btn.innerHTML : "";
  if (btn) { btn.disabled = true; btn.innerHTML = "Validando..."; }
  try {
    estadoLicenciaActual = await window.veekpos?.validarLicenciaAhora?.() || estadoLicenciaActual;
    await aplicarEstadoLicencia();
    toast(estadoLicenciaActual.modoLimitado ? "No vigente: " + (estadoLicenciaActual.motivo||"") : "Licencia válida", estadoLicenciaActual.modoLimitado ? "error" : "success");
  } catch(e) { toast("Error al validar", "error"); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = orig; } }
}

async function mostrarEstadoLicenciaEnConfig() {
  const box = document.getElementById("licenciaEstadoBox");
  const inputUrl = document.getElementById("cfgLicenciaUrlServidor");
  if (inputUrl && !inputUrl.value) inputUrl.value = await window.veekpos?.obtenerUrlServidorLicencia?.() || "";
  if (!box) return;
  const e = estadoLicenciaActual;
  if (!e.activada) { box.innerHTML = `<span style="color:var(--red-500)">⚠️ Sin licencia activada.</span>`; return; }
  if (e.modoLimitado) { box.innerHTML = `<div style="color:var(--red-500);font-weight:600">⚠️ Modo limitado — ${escapeHtml(e.motivo||"")}</div>`; return; }
  box.innerHTML = `<div style="color:var(--green-600);font-weight:600">✓ Licencia activa</div>
    <div class="text-muted" style="font-size:12.5px">Email: ${escapeHtml(e.email||"—")} · Vence: ${escapeHtml(e.fechaVencimiento||"—")}</div>`;
}

/* =========================================================
   INSTALADOR / GENERADOR DE CLIENTE
   Genera Code.gs, config.json y ZIPs listos para instalar
========================================================= */

function instObtenerDatos() {
  return {
    empresa:       (document.getElementById("instEmpresa")?.value || "").trim(),
    spreadsheetId: (document.getElementById("instSpreadsheetId")?.value || "").trim(),
    apiUrl:        (document.getElementById("instApiUrl")?.value || "").trim(),
    whatsapp:      (document.getElementById("instWhatsapp")?.value || "").trim(),
    direccion:     (document.getElementById("instDireccion")?.value || "").trim(),
    moneda:        (document.getElementById("instMoneda")?.value || "ARS"),
    fecha:         new Date().toISOString().slice(0, 10),
    version:       "1.0"
  };
}

function instValidar() {
  const d = instObtenerDatos();
  if (!d.empresa) { toast("Ingresá el nombre de la empresa", "error"); return null; }
  if (!d.spreadsheetId) { toast("Ingresá el ID de la planilla de Google Sheets", "error"); return null; }
  return d;
}

/** Descarga un archivo de texto desde el browser */
function descargarArchivo(nombre, contenido, tipo = "text/plain") {
  const blob = new Blob([contenido], { type: tipo });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  a.click();
  URL.revokeObjectURL(url);
}

/** Paso 2: Genera y descarga el Code.gs con los datos del cliente */
async function generarCodeGs() {
  const d = instValidar();
  if (!d) return;

  const status = document.getElementById("instStatus");
  if (status) status.innerHTML = `<div class="text-muted">⏳ Cargando template...</div>`;

  try {
    // Cargar el template desde el servidor
    const res = await fetch("../code.gs.template?_=" + Date.now(), { cache: "no-store" });
    if (!res.ok) throw new Error("No se encontró el template code.gs.template");
    let template = await res.text();

    // El template real (el mismo que corre en producción para el
    // negocio actual, así que no puede tener un {{marcador}} literal
    // sin romper ese uso directo) tiene el ID de la planilla escrito
    // como una constante de verdad: const SPREADSHEET_ID = "...".
    // Se busca esa línea puntual con una expresión regular y se le
    // cambia el valor — antes se buscaba un {{SPREADSHEET_ID}} que
    // nunca existió en el archivo, así que el reemplazo no encontraba
    // nada y el .gs se descargaba con el ID de OTRO negocio adentro,
    // sin ningún aviso de que eso había pasado.
    const regexSpreadsheetId = /const\s+SPREADSHEET_ID\s*=\s*"[^"]*"/;
    if (!regexSpreadsheetId.test(template)) {
      throw new Error("No se encontró la línea 'const SPREADSHEET_ID = ...' en el template — no se puede generar el archivo con seguridad.");
    }
    template = template.replace(regexSpreadsheetId, `const SPREADSHEET_ID = "${d.spreadsheetId}"`);

    const nombreArchivo = `Code_${d.empresa.replace(/\s+/g, "_")}.gs`;
    descargarArchivo(nombreArchivo, template, "text/plain");

    if (status) status.innerHTML = `<div class="text-success">✓ ${nombreArchivo} descargado — seguí las instrucciones del Paso 2</div>`;
    toast("Code.gs generado y descargado", "success");

  } catch (err) {
    console.error(err);
    toast("Error al generar Code.gs: " + err.message, "error");
    if (status) status.innerHTML = `<div class="text-danger">⚠️ ${err.message}</div>`;
  }
}

/** Paso 3a: Genera y descarga config.json */
function generarConfigJson() {
  const d = instValidar();
  if (!d) return;

  const config = {
    empresa:    d.empresa,
    apiUrl:     d.apiUrl || "PEGAR_URL_API_AQUI",
    moneda:     d.moneda,
    whatsapp:   d.whatsapp,
    direccion:  d.direccion,
    version:    d.version,
    generadoEn: d.fecha
  };

  const json = JSON.stringify(config, null, 2);
  descargarArchivo("config.json", json, "application/json");
  toast("config.json descargado — colocalo en la raíz del catálogo y del panel admin", "success");
}

/** Paso 3b: Genera ZIP del catálogo web completo con config del cliente */
async function generarCatalogoZip() {
  const d = instValidar();
  if (!d) return;
  if (!d.apiUrl) { toast("Ingresá la API URL antes de generar el catálogo", "error"); return; }

  const status = document.getElementById("instStatus");
  if (status) status.innerHTML = `<div class="text-muted">⏳ Generando catálogo web...</div>`;

  try {
    // Cargar JSZip dinámicamente si no está disponible
    if (typeof JSZip === "undefined") {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
        s.onload = res; s.onerror = () => rej(new Error("No se pudo cargar JSZip"));
        document.head.appendChild(s);
      });
    }

    const zip = new JSZip();

    // Insertar config.json del cliente en el ZIP
    const config = {
      empresa:    d.empresa,
      apiUrl:     d.apiUrl,
      moneda:     d.moneda,
      whatsapp:   d.whatsapp,
      direccion:  d.direccion,
      version:    d.version,
      generadoEn: d.fecha
    };
    zip.file("config.json", JSON.stringify(config, null, 2));

    // Lista de archivos del catálogo (viven en veekPOS/catalogo/)
    const archivosTexto = [
      "index.html",
      "js/app.js",
      "css/style.css",
      "service-worker.js",
      "manifest.json",
      "manifest-catalogo.json",
      "robots.txt",
      "lector.html",
      "precio.html",
    ];
    const archivosBinarios = ["icon-192.png", "icon-512.png", "favicon.ico"];

    const base = "../catalogo/";
    let cargados = 0;

    // Cargar archivos de texto
    await Promise.all(archivosTexto.map(async (archivo) => {
      try {
        const res = await fetch(base + archivo + "?_=" + Date.now(), { cache: "no-store" });
        if (!res.ok) return;
        zip.file(archivo, await res.text());
        cargados++;
        if (status) status.innerHTML = `<div class="text-muted">⏳ Cargando archivos... (${cargados})</div>`;
      } catch(e) { console.warn("Omitido:", archivo); }
    }));

    // Cargar binarios
    await Promise.all(archivosBinarios.map(async (img) => {
      try {
        const res = await fetch(base + img + "?_=" + Date.now(), { cache: "no-store" });
        if (res.ok) { zip.file(img, await res.arrayBuffer()); cargados++; }
      } catch(e) {}
    }));

    // Generar y descargar ZIP
    if (status) status.innerHTML = `<div class="text-muted">⏳ Comprimiendo...</div>`;
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Catalogo_${d.empresa.replace(/\s+/g, "_")}_${d.fecha}.zip`;
    a.click();
    URL.revokeObjectURL(url);

    if (status) status.innerHTML = `
      <div class="alert alert-success mt-2" style="font-size:13px;">
        ✓ <strong>Catálogo descargado (${cargados} archivos)</strong><br>
        Subí el contenido del ZIP a tu hosting (Netlify, GitHub Pages, etc.).<br>
        El <code>config.json</code> ya tiene la API URL y los datos del cliente.
      </div>`;
    toast("Catálogo web generado", "success");

  } catch (err) {
    console.error(err);
    toast("Error al generar el catálogo: " + err.message, "error");
    if (status) status.innerHTML = `<div class="text-danger mt-2">⚠️ ${err.message}</div>`;
  }
}

/** Paso 4: Verifica que la API URL responda correctamente */
async function verificarConexionInstalador() {
  const apiUrl = (document.getElementById("instApiUrl")?.value || "").trim();
  const status = document.getElementById("instConexionStatus");

  if (!apiUrl) {
    toast("Ingresá la API URL primero", "error");
    return;
  }

  if (status) status.innerHTML = `<span class="text-muted">⏳ Probando conexión y preparando las hojas...</span>`;

  try {
    // Un solo paso: probar que la API responde Y, de paso, crear en la
    // planilla todas las hojas que el sistema necesita (si ya
    // estaban creadas, no se tocan ni se duplican).
    const res = await fetch(apiUrl + "?action=inicializarHojas", { signal: AbortSignal.timeout(20000) });
    const data = await res.json();

    if (data.success) {
      if (status) status.innerHTML = `<span class="text-success">✅ Conexión exitosa — ${data.message}</span>`;
      toast("Conexión verificada y hojas listas", "success");
    } else {
      if (status) status.innerHTML = `<span class="text-warning">⚠️ La API respondió pero algo falló: ${data.message || "revisá el Code.gs publicado"}</span>`;
    }
  } catch (err) {
    if (status) status.innerHTML = `<span class="text-danger">❌ No se pudo conectar: ${err.message}</span>`;
    toast("Error de conexión: " + err.message, "error");
  }
}

/** Guarda la API URL desde el formulario de configuración (tarjeta Electron) */
async function guardarApiUrlDesdeConfig() {
  const input = document.getElementById("conexionNegocioUrl");
  const url = (input ? input.value : "").trim();
  if (!url) { toast("Ingresá la URL de la API", "error"); return; }

  // Guardar con el método disponible (veekpos o posOffline)
  const bridge = window.veekpos || window.posOffline;
  if (bridge) {
    if (bridge.fijarConfigLocal) await bridge.fijarConfigLocal("api_url", url);
    else if (bridge.guardarApiUrl) await bridge.guardarApiUrl(url);
    API_URL = url;
    const actual = document.getElementById("conexionNegocioUrlActual");
    if (actual) actual.textContent = "Conectada a: " + url;
    toast("URL guardada correctamente", "success");
  }
}

/* =========================================================
   SISTEMA DE LICENCIAS
   Verifica la licencia al iniciar el panel.
   Si no hay conexión, permite continuar por 7 días offline.
========================================================= */

const LICENCIAS_URL_KEY = "veekpos_licencias_url";
const LICENCIA_KEY      = "veekpos_licencia";
const LICENCIA_TS_KEY   = "veekpos_licencia_ts";
const LICENCIA_OFFLINE_DIAS = 7;

async function verificarLicenciaAlIniciar() {
  // Si no hay URL de servidor de licencias configurada, saltar verificación
  const servidorUrl = localStorage.getItem(LICENCIAS_URL_KEY);
  if (!servidorUrl) return; // sin servidor configurado → sin restricción

  const codigoGuardado = localStorage.getItem(LICENCIA_KEY);
  const tsGuardado     = Number(localStorage.getItem(LICENCIA_TS_KEY) || 0);
  const diasDesdeUltima = (Date.now() - tsGuardado) / 86400000;

  // Si verificó recientemente (< 24h), no verificar de nuevo
  if (codigoGuardado && diasDesdeUltima < 1) return;

  if (!codigoGuardado) {
    // Primera vez — pedir código de licencia
    mostrarPantallaActivacion();
    return;
  }

  // Verificar en línea
  try {
    const res = await fetch(`${servidorUrl}?action=validarLicencia&licencia=${codigoGuardado}`,
      { signal: AbortSignal.timeout(8000) });
    const data = await res.json();

    if (!data.valida) {
      mostrarPantallaActivacion(data.mensaje || "Licencia inválida o vencida");
      return;
    }

    // Guardar resultado
    localStorage.setItem(LICENCIA_TS_KEY, Date.now());
    console.log(`✓ Licencia válida — ${data.empresa} (${data.plan})`);

  } catch(err) {
    // Sin conexión al servidor de licencias
    if (diasDesdeUltima > LICENCIA_OFFLINE_DIAS) {
      mostrarPantallaActivacion(
        `Sin conexión al servidor de licencias por ${Math.round(diasDesdeUltima)} días. ` +
        `Conectate a internet para continuar.`
      );
    }
    // Si es menos de 7 días offline, continuar normalmente
  }
}

function mostrarPantallaActivacion(mensaje = "") {
  // Crear overlay de activación si no existe
  if (document.getElementById("licenciaOverlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "licenciaOverlay";
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:99999;
    background:#0b1633; display:flex; flex-direction:column;
    align-items:center; justify-content:center; gap:16px;
  `;
  overlay.innerHTML = `
    <div style="color:#fff; font-size:28px;">🔑</div>
    <div style="color:#fff; font-size:20px; font-weight:700;">Activación de licencia</div>
    ${mensaje ? `<div style="color:#f87171; font-size:13px; max-width:340px; text-align:center;">${mensaje}</div>` : ""}
    <div style="background:#fff; padding:24px; border-radius:12px; width:340px;">
      <label style="font-size:13px; font-weight:600; display:block; margin-bottom:8px;">Código de licencia</label>
      <input type="text" id="inputCodigoLicencia" class="form-control"
        placeholder="Ej: VPK-ABC123" style="text-transform:uppercase; letter-spacing:.1em;">
      <div id="licenciaError" style="color:#ef4444; font-size:12px; margin-top:6px; display:none;"></div>
      <button onclick="activarLicencia()" class="btn btn-success w-100 mt-3">
        Activar
      </button>
    </div>
    <div style="color:#64748b; font-size:12px;">VeekPOS — Sistema de Punto de Venta</div>
  `;
  document.body.appendChild(overlay);
  setTimeout(() => document.getElementById("inputCodigoLicencia")?.focus(), 100);
}

async function activarLicencia() {
  const input = document.getElementById("inputCodigoLicencia");
  const errorEl = document.getElementById("licenciaError");
  const codigo = (input?.value || "").trim().toUpperCase();

  if (!codigo) {
    if (errorEl) { errorEl.textContent = "Ingresá el código de licencia"; errorEl.style.display = "block"; }
    return;
  }

  const servidorUrl = localStorage.getItem(LICENCIAS_URL_KEY);
  if (!servidorUrl) {
    // Sin servidor configurado → aceptar cualquier código localmente
    localStorage.setItem(LICENCIA_KEY, codigo);
    localStorage.setItem(LICENCIA_TS_KEY, Date.now());
    document.getElementById("licenciaOverlay")?.remove();
    return;
  }

  const btn = document.querySelector("#licenciaOverlay button");
  if (btn) { btn.disabled = true; btn.textContent = "Verificando..."; }

  try {
    const res = await fetch(`${servidorUrl}?action=validarLicencia&licencia=${codigo}`,
      { signal: AbortSignal.timeout(10000) });
    const data = await res.json();

    if (!data.valida) {
      if (errorEl) { errorEl.textContent = data.mensaje || "Licencia inválida"; errorEl.style.display = "block"; }
      if (btn) { btn.disabled = false; btn.textContent = "Activar"; }
      return;
    }

    localStorage.setItem(LICENCIA_KEY, codigo);
    localStorage.setItem(LICENCIA_TS_KEY, Date.now());
    document.getElementById("licenciaOverlay")?.remove();
    toast(`✓ Licencia activada — ${data.empresa} (${data.plan})`, "success");

  } catch(err) {
    if (errorEl) { errorEl.textContent = "Error de conexión: " + err.message; errorEl.style.display = "block"; }
    if (btn) { btn.disabled = false; btn.textContent = "Activar"; }
  }
}


/* =========================================================
   MERCADO PAGO — Cobro con QR (integrado desde pos-offline)
========================================================= */

async function mostrarEstadoMercadoPagoEnConfig() {
  const box = document.getElementById("mpEstadoBox");
  const formularioWrap = document.getElementById("mpFormularioWrap");
  if (!box) return;

  try {
    const cfg = await window.veekpos.obtenerConfigMercadoPago();
    const btnQuitar = document.getElementById("btnQuitarMercadoPago");

    if (cfg.esCliente) {
      // El Access Token se configura una sola vez, en la caja
      // servidor — esta caja no tiene nada propio para editar, solo
      // muestra si el servidor ya lo tiene listo.
      if (formularioWrap) formularioWrap.style.display = "none";
      box.innerHTML = cfg.configurado
        ? `<div style="color:var(--green-600); font-weight:600;">✓ Configurado en la caja servidor</div><div class="text-muted" style="font-size:12.5px; margin-top:2px;">El cobro con QR se gestiona desde el servidor — no hace falta configurar nada en esta caja.</div>`
        : `<span class="text-muted">No configurado en la caja servidor. La configuración de Mercado Pago se hace una sola vez, ahí.</span>`;
      return;
    }

    if (formularioWrap) formularioWrap.style.display = "block";

    if (cfg.configurado) {
      box.innerHTML = `<div style="color:var(--green-600); font-weight:600;">✓ Configurado</div><div class="text-muted" style="font-size:12.5px; margin-top:2px;">Token guardado: ${escapeHtml(cfg.tokenParcial)}</div>`;
      if (btnQuitar) btnQuitar.style.display = "inline-block";
    } else if (cfg.hayToken) {
      box.innerHTML = `<span style="color:var(--red-500);">⚠️ Hay un token guardado pero falta terminar de configurar (probá guardarlo de nuevo).</span>`;
      if (btnQuitar) btnQuitar.style.display = "inline-block";
    } else {
      box.innerHTML = `<span class="text-muted">No configurado — "Transferencia" funciona en modo manual.</span>`;
      if (btnQuitar) btnQuitar.style.display = "none";
    }

    // Pre-completa los campos de dirección si ya se habían guardado antes (no pisa lo que el usuario esté escribiendo ahora)
    if (cfg.direccion) {
      const campoCalle = document.getElementById("cfgMpCalle");
      const campoNumero = document.getElementById("cfgMpNumero");
      const campoCiudad = document.getElementById("cfgMpCiudad");
      const campoProvincia = document.getElementById("cfgMpProvincia");
      if (campoCalle && !campoCalle.value) campoCalle.value = cfg.direccion.calle || "";
      if (campoNumero && !campoNumero.value) campoNumero.value = cfg.direccion.numero || "";
      if (campoCiudad && !campoCiudad.value) campoCiudad.value = cfg.direccion.ciudad || "";
      if (campoProvincia && !campoProvincia.value) campoProvincia.value = cfg.direccion.provincia || "";
    }

  } catch (error) {
    console.error("Error al consultar estado de Mercado Pago:", error);
    box.innerHTML = `<span class="text-muted">No se pudo consultar el estado.</span>`;
  }
}

async function guardarConfigMercadoPagoForm() {
  const input = document.getElementById("cfgMpAccessToken");
  const accessToken = input.value.trim();

  const direccion = {
    calle: document.getElementById("cfgMpCalle").value.trim(),
    numero: document.getElementById("cfgMpNumero").value.trim(),
    ciudad: document.getElementById("cfgMpCiudad").value.trim(),
    provincia: document.getElementById("cfgMpProvincia").value.trim()
  };

  if (!accessToken) { toast("Ingresá el Access Token", "error"); return; }
  if (!direccion.calle || !direccion.numero || !direccion.ciudad || !direccion.provincia) {
    toast("Completá la dirección del negocio — Mercado Pago la exige para crear la tienda", "error");
    return;
  }

  const btn = document.getElementById("btnGuardarMercadoPago");
  const textoOriginal = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = "Configurando...";

  try {
    const nombreNegocio = (configNegocioCache && configNegocioCache.nombre) || "VeekPOS";
    const resultado = await window.veekpos.guardarYConfigurarMercadoPago(accessToken, nombreNegocio, direccion);

    if (!resultado.success) {
      toast(resultado.message || "No se pudo configurar Mercado Pago", "error");
      return;
    }

    toast("Mercado Pago configurado correctamente" + (resultado.nombre ? " (" + resultado.nombre + ")" : ""), "success");
    input.value = "";
    mostrarEstadoMercadoPagoEnConfig();

  } catch (error) {
    console.error("Error al configurar Mercado Pago:", error);
    toast("Error al configurar Mercado Pago", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = textoOriginal;
  }
}

async function probarCredencialesMercadoPagoBtn() {
  const input = document.getElementById("cfgMpAccessToken");
  const accessToken = input.value.trim();

  if (!accessToken) { toast("Ingresá un Access Token para probar", "error"); return; }

  try {
    const resultado = await window.veekpos.probarCredencialesMercadoPago(accessToken);
    if (resultado.success) {
      toast("Conexión correcta" + (resultado.nombre ? " — cuenta: " + resultado.nombre : ""), "success");
    } else {
      toast(resultado.message || "No se pudo conectar con ese token", "error");
    }
  } catch (error) {
    console.error("Error al probar credenciales de Mercado Pago:", error);
    toast("Error al probar la conexión", "error");
  }
}

async function quitarConfigMercadoPago() {
  if (!await confirmarAccion("¿Quitar la configuración de Mercado Pago? \"Transferencia\" va a volver a funcionar en modo manual.", { textoBoton: "Quitar" })) return;

  try {
    await window.veekpos.borrarConfigMercadoPago();
    toast("Configuración de Mercado Pago eliminada", "success");
    mostrarEstadoMercadoPagoEnConfig();
  } catch (error) {
    console.error("Error al quitar configuración de Mercado Pago:", error);
    toast("Error al quitar la configuración", "error");
  }
}

/* ===================== RED LOCAL MULTI-CAJA (Configuración) ===================== */

async function iniciarCobroMercadoPago(total) {
  document.getElementById("mpQrMontoLabel").textContent = "$" + Number(total).toLocaleString("es-AR");
  document.getElementById("mpQrError").style.display = "none";
  document.getElementById("mpQrEsperando").style.display = "block";
  document.getElementById("mpQrImagen").src = "";
  document.getElementById("mpQrBackdrop").classList.add("show");

  const subtotal = ticketPOS.reduce((acc, item) => acc + (item.PRECIO * item.cantidad), 0);
  const itemsSnapshot = [...ticketPOS]; // snapshot antes de limpiar
  const recibido = Number(document.getElementById("mfvRecibido")?.value) || 0;
  mpVentaEnCurso = { subtotal, total, itemsSnapshot, recibido };

  try {
    const referencia = "veekpos" + Date.now();
    const bridge = window.veekpos || window.posOffline;
    const resultado = await bridge.crearCobroQR(total, referencia);

    if (!resultado.success) {
      mostrarErrorCobroMercadoPago(resultado.message || "No se pudo generar el QR de cobro");
      return;
    }

    mpReferenciaActual = referencia;
    document.getElementById("mpQrImagen").src = resultado.qrImagenDataUrl;
    mpPollingIntervalId = setInterval(consultarCobroMercadoPagoPolling, 3000);

  } catch (error) {
    console.error("Error al generar cobro con Mercado Pago:", error);
    mostrarErrorCobroMercadoPago("Error al generar el QR de cobro");
  }
}


/* =========================================================
   MERCADO PAGO — Polling y modal QR
========================================================= */

let mpPollingIntervalId = null;
let mpReferenciaActual  = null;
let mpVentaEnCurso      = null; // { subtotal, total, itemsSnapshot, recibido }

async function consultarCobroMercadoPagoPolling() {
  if (!mpReferenciaActual) return;
  try {
    const bridge = window.veekpos || window.posOffline;
    const resultado = await bridge.consultarCobroQR(mpReferenciaActual);
    if (resultado.success && resultado.pagada) {
      detenerPollingMercadoPago();
      document.getElementById("mpQrBackdrop").classList.remove("show");
      toast("Pago de Mercado Pago confirmado ✓", "success");

      if (mpVentaEnCurso) {
        const { subtotal, total, itemsSnapshot, recibido } = mpVentaEnCurso;
        const etiquetaDescuento = obtenerEtiquetaDescuentoPOS(subtotal);

        // Guardar en backend — recién ahora que el pago está confirmado
        let ventaId = "VEN-" + Date.now().toString().slice(-6);
        const clienteVentaIdMP = "CVL-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
        try {
          // Por POST, con el carrito en el body — igual que el resto de
          // las ventas, para no toparse con el límite de tamaño de URL
          // en carritos grandes, y con timeout para no quedar colgado.
          const res = await fetchAPI(
            API_URL,
            {
              method: "POST",
              headers: { "Content-Type": "text/plain;charset=utf-8" },
              body: JSON.stringify({
                action: "guardarVenta",
                total: total,
                formaPago: "TRANSFERENCIA",
                observaciones: etiquetaDescuento ? "Descuento: " + etiquetaDescuento : "",
                carrito: itemsSnapshot,
                clienteVentaId: clienteVentaIdMP
              })
            },
            { timeoutMs: 15000 }
          );
          const data = await res.json();
          if (data.success && data.ventaId) ventaId = data.ventaId;
        } catch(e) {
          console.error("Error guardando venta MP en backend:", e);
          toast("⚠️ Pago confirmado pero no se pudo guardar en el servidor", "error");
        }

        // Mostrar recibo con el ID real
        ultimaVentaImprimible = {
          ventaId, items: itemsSnapshot, total, subtotal,
          descuento: subtotal - total,
          descuentoEtiqueta: etiquetaDescuento,
          formaPago: "TRANSFERENCIA", fecha: new Date()
        };

        mostrarRecibo(ventaId, itemsSnapshot, total, subtotal, subtotal - total, recibido);

        // Limpiar ticket y actualizar UI
        ticketPOS = [];
        resetearDescuentoPOS();
        const inputRec = document.getElementById("inputRecibido");
        const cambioEl = document.getElementById("cambioValor");
        if (inputRec) inputRec.value = "";
        if (cambioEl) { cambioEl.textContent = "—"; cambioEl.classList.remove("negativo"); }
        renderTicketPOS();
        ultimoCodigoAgregadoPOS = null;
        posTileFocusIdx = -1;

        // Stock optimista
        itemsSnapshot.forEach(item => {
          const p = productosPOS.find(x => String(x.CODIGO) === String(item.CODIGO));
          if (p) p.STOCK = Math.max(0, Number(p.STOCK) - item.cantidad);
        });
        renderPosGrid();

        setTimeout(() => { cargarMetricas(); invalidarCache("ventasPOS"); }, 500);
        mpVentaEnCurso = null;
      }
    }
  } catch (error) {
    console.warn("Error consultando estado del cobro MP (se reintenta):", error);
  }
}

function mostrarErrorCobroMercadoPago(mensaje) {
  detenerPollingMercadoPago();
  const el = document.getElementById("mpQrEsperando");
  const err = document.getElementById("mpQrError");
  const txt = document.getElementById("mpQrErrorTexto");
  if (el) el.style.display = "none";
  if (err) err.style.display = "block";
  if (txt) txt.textContent = mensaje;
}

function detenerPollingMercadoPago() {
  if (mpPollingIntervalId) { clearInterval(mpPollingIntervalId); mpPollingIntervalId = null; }
}

function cancelarCobroMercadoPago() {
  detenerPollingMercadoPago();
  const backdrop = document.getElementById("mpQrBackdrop");
  if (backdrop) backdrop.classList.remove("show");
  mpReferenciaActual = null;
  mpVentaEnCurso = null;
  toast("Cobro cancelado — el ticket sigue abierto", "info");
}

/** Ejecuta la migración de columna FORMA_PAGO en MOVIMIENTOS_CAJA */
async function ejecutarMigracionFormaPago() {
  const status = document.getElementById("migracionStatus");
  if (status) status.textContent = "Migrando...";
  try {
    const res = await fetchAPI(API_URL + "?action=migrarColumnaFormaPago");
    const data = await res.json();
    if (status) status.textContent = data.message || (data.success ? "✓ OK" : "❌ Error");
    toast(data.message || "Migración completada", data.success ? "success" : "error");
  } catch(e) {
    if (status) status.textContent = "Error de conexión";
    toast("Error al ejecutar migración", "error");
  }
}
