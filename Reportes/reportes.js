/* ===================================================================
   REPORTES PWA
   Reusa los mismos endpoints del backend (Apps Script) que ya usa el
   panel admin completo. Esta página solo MUESTRA y EXPORTA reportes,
   no escribe nada en la base.
   API_URL y el nombre del negocio se leen de config.js (index.html
   ya carga ese script antes de este archivo).
=================================================================== */

const API_URL = CONFIG_NEGOCIO.API_URL;

/* ---- Sesión: requiere haber pasado por login.html ---- */
if (sessionStorage.getItem("admin") !== "true") {
  window.location.href = "login.html";
}

function cerrarSesion() {
  sessionStorage.removeItem("admin");
  window.location.href = "login.html";
}

/* ---- Utilidades ---- */
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text || "";
  return div.innerHTML;
}

function toast(mensaje, tipo) {
  const box = document.getElementById("toastBox");
  box.textContent = mensaje;
  box.className = "toast show" + (tipo === "error" ? " error" : "");
  setTimeout(() => box.classList.remove("show"), 3200);
}

/* ---- Filtro de fecha compartido por los 6 reportes ---- */
function obtenerRangoReportes() {
  const desde = document.getElementById("repDesde").value;
  const hasta = document.getElementById("repHasta").value;
  let qs = "";
  if (desde) qs += "&desde=" + encodeURIComponent(desde);
  if (hasta) qs += "&hasta=" + encodeURIComponent(hasta);
  return qs;
}

function sincronizarRangoReportes(desde, hasta) {
  const inputDesde = document.getElementById("repDesde");
  const inputHasta = document.getElementById("repHasta");
  if (inputDesde && !inputDesde.value) inputDesde.value = desde;
  if (inputHasta && !inputHasta.value) inputHasta.value = hasta;
}

async function cargarTodosLosReportes() {
  const btn = document.getElementById("btnAplicarFiltro");
  const btnTexto = document.getElementById("btnAplicarTexto");
  if (btn) { btn.disabled = true; }
  if (btnTexto) { btnTexto.innerHTML = '<span class="spinner-mini"></span> Cargando...'; }

  try {
    await Promise.all([
      cargarReporteVentasPeriodo(),
      cargarReporteProductos(),
      cargarReporteCategorias(),
      cargarReporteFormasPago(),
      cargarReporteCierres(),
      cargarReporteClientes()
    ]);
  } finally {
    if (btn) { btn.disabled = false; }
    if (btnTexto) { btnTexto.textContent = "Aplicar a los 6 reportes"; }
  }
}

/* ---- Reporte 1: Ventas por período ---- */
async function cargarReporteVentasPeriodo() {
  const tbody = document.getElementById("repVentasPeriodoTabla");
  const resumenWrap = document.getElementById("repVentasPeriodoResumen");

  try {
    const response = await fetch(API_URL + "?action=reporteVentasPeriodo" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    const r = data.resumen || {};
    resumenWrap.innerHTML = `
      <div class="resumen-item"><div class="lbl">Total POS</div><div class="val money">$${Number(r.totalPOS || 0).toLocaleString("es-AR")}</div></div>
      <div class="resumen-item"><div class="lbl">Total Pedidos</div><div class="val money">$${Number(r.totalPedidos || 0).toLocaleString("es-AR")}</div></div>
      <div class="resumen-item"><div class="lbl">Total general</div><div class="val money">$${Number(r.totalGeneral || 0).toLocaleString("es-AR")}</div></div>
      <div class="resumen-item"><div class="lbl">Ticket promedio</div><div class="val money">$${Number(r.ticketPromedio || 0).toLocaleString("es-AR")}</div></div>`;

    if (!data.dias || data.dias.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="texto-vacio">Sin ventas para el rango elegido</td></tr>`;
      return;
    }

    tbody.innerHTML = data.dias.map(d => `
      <tr>
        <td>${escapeHtml(d.fecha)}</td>
        <td class="money">$${Number(d.pos || 0).toLocaleString("es-AR")}</td>
        <td class="money">$${Number(d.pedidos || 0).toLocaleString("es-AR")}</td>
        <td class="money" style="font-weight:700;">$${Number(d.total || 0).toLocaleString("es-AR")}</td>
      </tr>`).join("");

  } catch (error) {
    console.error("Error al cargar reporte de ventas por período:", error);
    tbody.innerHTML = `<tr><td colspan="4" class="texto-vacio">Error al cargar el reporte</td></tr>`;
    toast("No se pudo conectar para cargar 'Ventas por período'", "error");
  }
}

/* ---- Reporte 2: Productos más vendidos ---- */
async function cargarReporteProductos() {
  const tbody = document.getElementById("repProductosTabla");

  try {
    const response = await fetch(API_URL + "?action=reporteProductosVendidos" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.productos || data.productos.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="texto-vacio">Sin ventas para el rango elegido</td></tr>`;
      return;
    }

    tbody.innerHTML = data.productos.map(p => `
      <tr>
        <td class="money">${escapeHtml(p.CODIGO)}</td>
        <td>${escapeHtml(p.PRODUCTO)}</td>
        <td class="money">${Number(p.VENDIDOS || 0).toLocaleString("es-AR")}</td>
        <td class="money">$${Number(p.INGRESOS || 0).toLocaleString("es-AR")}</td>
      </tr>`).join("");

  } catch (error) {
    console.error("Error al cargar reporte de productos vendidos:", error);
    tbody.innerHTML = `<tr><td colspan="4" class="texto-vacio">Error al cargar el reporte</td></tr>`;
    toast("No se pudo conectar para cargar 'Productos más vendidos'", "error");
  }
}

/* ---- Reporte 3: Ventas por categoría ---- */
async function cargarReporteCategorias() {
  const tbody = document.getElementById("repCategoriasTabla");

  try {
    const response = await fetch(API_URL + "?action=reporteVentasPorCategoria" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.categorias || data.categorias.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="texto-vacio">Sin ventas para el rango elegido</td></tr>`;
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
    tbody.innerHTML = `<tr><td colspan="3" class="texto-vacio">Error al cargar el reporte</td></tr>`;
    toast("No se pudo conectar para cargar 'Ventas por categoría'", "error");
  }
}

/* ---- Reporte 4: Formas de pago ---- */
async function cargarReporteFormasPago() {
  const tbody = document.getElementById("repFormasPagoTabla");

  try {
    const response = await fetch(API_URL + "?action=reporteFormasPago" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.formas || data.formas.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" class="texto-vacio">Sin ventas para el rango elegido</td></tr>`;
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
    tbody.innerHTML = `<tr><td colspan="3" class="texto-vacio">Error al cargar el reporte</td></tr>`;
    toast("No se pudo conectar para cargar 'Formas de pago'", "error");
  }
}

/* ---- Reporte 5: Historial de cierres de caja ---- */
async function cargarReporteCierres() {
  const tbody = document.getElementById("repCierresTabla");

  try {
    const response = await fetch(API_URL + "?action=reporteCierresCaja" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.cierres || data.cierres.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="texto-vacio">Sin cierres para el rango elegido</td></tr>`;
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
    tbody.innerHTML = `<tr><td colspan="5" class="texto-vacio">Error al cargar el reporte</td></tr>`;
    toast("No se pudo conectar para cargar 'Cierres de caja'", "error");
  }
}

/* ---- Reporte 6: Clientes que más compran ---- */
async function cargarReporteClientes() {
  const tbody = document.getElementById("repClientesTabla");

  try {
    const response = await fetch(API_URL + "?action=reporteClientes" + obtenerRangoReportes());
    const data = await response.json();
    if (!data.success) return;

    sincronizarRangoReportes(data.desde, data.hasta);

    if (!data.clientes || data.clientes.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="texto-vacio">Sin pedidos para el rango elegido</td></tr>`;
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
    tbody.innerHTML = `<tr><td colspan="4" class="texto-vacio">Error al cargar el reporte</td></tr>`;
    toast("No se pudo conectar para cargar 'Clientes'", "error");
  }
}

/* ---- Exportar cualquiera de los 6 reportes a PDF ---- */
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

    const desde = document.getElementById("repDesde").value || "—";
    const hasta = document.getElementById("repHasta").value || "—";

    doc.setFontSize(14);
    doc.text(`${CONFIG_NEGOCIO.NOMBRE_NEGOCIO} — ${tituloReporte}`, 30, 30);
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

/* ---- Registrar el service worker (instala como PWA) ---- */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch(() => {});
  });
}

/* ---- Carga inicial: trae los 6 reportes del mes en curso ---- */
cargarTodosLosReportes();
