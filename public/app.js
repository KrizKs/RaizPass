const state = {
  user: null,
  events: [],
  organizations: [],
  tickets: [],
  incomingTransfers: [],
  orgStats: [],
  eventSearch: "",
  organizationFilter: "",
};

const ZONE_ORDER = ["Zona Roja", "Zona Azul", "Zona Verde", "Zona Blanca", "Zona Lila", "Zona Naranja", "Zona Amarilla"];

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function setNotice(text, isError = false) {
  const notice = $("#authNotice");
  if (!notice) return;
  notice.textContent = text || "";
  notice.style.color = isError ? "var(--bad)" : "var(--earth)";
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
}

function showToast(message, isError = false) {
  let toast = $("#toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toast";
    document.body.appendChild(toast);
  }
  toast.className = `toast ${isError ? "error" : ""}`;
  toast.textContent = message;
  requestAnimationFrame(() => toast.classList.add("visible"));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("visible"), 3800);
}

function closeModal(value = null) {
  const overlay = $(".modal-overlay");
  if (overlay) overlay.remove();
  if (typeof closeModal.resolve === "function") closeModal.resolve(value);
  closeModal.resolve = null;
}

function openModal(html) {
  closeModal(null);
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-card">${html}</div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeModal(null);
  });
  return new Promise((resolve) => {
    closeModal.resolve = resolve;
  });
}

async function confirmModal(title, message, action = "Aceptar", danger = false) {
  const promise = openModal(`
    <h3>${escapeHtml(title)}</h3>
    <p class="muted">${escapeHtml(message)}</p>
    <div class="modal-actions">
      <button class="ghost" data-modal-cancel>Cancelar</button>
      <button class="${danger ? "danger" : ""}" data-modal-confirm>${escapeHtml(action)}</button>
    </div>`);
  $("[data-modal-cancel]").onclick = () => closeModal(false);
  $("[data-modal-confirm]").onclick = () => closeModal(true);
  return Boolean(await promise);
}

async function promptModal(title, message, inputLabel, options = {}) {
  const type = options.type || "text";
  const promise = openModal(`
    <h3>${escapeHtml(title)}</h3>
    <p class="muted">${escapeHtml(message)}</p>
    <label><span>${escapeHtml(inputLabel)}</span><input id="modalInput" type="${type}" value="${escapeHtml(options.value || "")}" placeholder="${escapeHtml(options.placeholder || "")}"></label>
    <div class="modal-actions">
      <button class="ghost" data-modal-cancel>Cancelar</button>
      <button data-modal-confirm>${escapeHtml(options.action || "Continuar")}</button>
    </div>`);
  $("[data-modal-cancel]").onclick = () => closeModal(null);
  $("[data-modal-confirm]").onclick = () => closeModal($("#modalInput").value.trim());
  $("#modalInput").focus();
  return await promise;
}

function seatText(seat) {
  return seat ? `${seat.zone} · Sección ${seat.section} · Lugar ${seat.seatNumber}` : "Sin lugar asignado";
}

function ticketPdfUrl(ticket) {
  return ticket.pdfUrl || (ticket.publicCode ? `/api/tickets/${encodeURIComponent(ticket.publicCode)}/pdf` : "#");
}

function clearAuthForms() {
  $$(".auth-form").forEach((form) => form.reset());
  setNotice("");
}

function formatPrice(value, currency = "MXN") {
  return `${Number(value || 0).toLocaleString("es-MX", { style: "currency", currency, maximumFractionDigits: 0 })}`;
}

const CURRENCY_RATES = { MXN: 1, USD: 18, EUR: 20 };
function convertCurrency(amount, from, to) {
  const mxn = Number(amount || 0) * (CURRENCY_RATES[from] || 1);
  return Math.round(mxn / (CURRENCY_RATES[to] || 1));
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ocurrió un error (${response.status}). Revisa los logs del servidor.`);
  return data;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function statusText(status) {
  return {
    valid: "Válido",
    used: "Usado",
    expired: "Expirado",
    tampered: "Alterado",
    transfer_pending: "Transferencia pendiente",
    cancelled: "Cancelado",
  }[status] || status;
}

function ticketCodeFromInput(value) {
  const trimmed = String(value || "").trim();
  const match = trimmed.match(/\/ticket\/([^/?#]+)/);
  return match ? match[1] : trimmed;
}

function moneylessCopy() {
  return "La compra se simula sin pagos; el objetivo es mostrar la validación criptográfica.";
}

async function init() {
  $$(".tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".tabs button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      $$(".auth-form").forEach((form) => form.classList.add("hidden"));
      $(`#${button.dataset.tab}Form`).classList.remove("hidden");
      setNotice("");
    });
  });

  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await api("/api/auth/login", { method: "POST", body: JSON.stringify(formData(event.target)) });
      state.user = data.user;
      clearAuthForms();
      await loadDashboard();
    } catch (error) {
      setNotice(error.message, true);
    }
  });

  $("#registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await api("/api/auth/register", { method: "POST", body: JSON.stringify(formData(event.target)) });
      setNotice(data.message);
      event.target.reset();
    } catch (error) {
      setNotice(error.message, true);
    }
  });

  $("#forgotForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const data = await api("/api/auth/forgot", { method: "POST", body: JSON.stringify(formData(event.target)) });
      setNotice(data.message);
      event.target.reset();
    } catch (error) {
      setNotice(error.message, true);
    }
  });

  $("#lookupForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const code = formData(event.target).code.trim();
      const data = await api(`/api/tickets/${encodeURIComponent(code)}`);
      location.href = `/ticket/${data.ticket.publicCode}`;
    } catch {
      setNotice("Codigo incorrecto o no existe.", true);
    }
  });

  $("#logoutBtn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state.user = null;
    clearAuthForms();
    $("#appView").style.display = "none";
    $("#authView").style.display = "grid";
  });

  const params = new URLSearchParams(location.search);
  if (params.get("notice") === "email-verified") setNotice("Correo verificado. Ya puedes iniciar sesión.");
  if (params.get("notice") === "token-invalid") setNotice("El enlace no es válido o ya fue usado.", true);

  const session = await api("/api/session");
  state.user = session.user;
  state.events = session.events;
  state.organizations = session.organizations || [];
  if (state.user) await loadDashboard();
}

async function loadDashboard() {
  const session = await api("/api/session");
  state.user = session.user;
  state.events = session.events;
  state.organizations = session.organizations || [];
  if (!state.user) {
    $("#appView").style.display = "none";
    $("#authView").style.display = "grid";
    return;
  }
  if (state.user.role === "organization") {
    const stats = await api("/api/organization/stats");
    state.orgStats = stats.stats;
    state.tickets = [];
    state.incomingTransfers = [];
  } else {
    const tickets = await api("/api/tickets");
    state.tickets = tickets.tickets || [];
    state.incomingTransfers = tickets.incomingTransfers || [];
  }
  $("#authView").style.display = "none";
  $("#appView").style.display = "block";
  $("#userLabel").textContent = `${state.user.organizationName || state.user.name} (${state.user.role === "organization" ? "organizacion" : "cliente"})`;
  renderDashboard();
}

function renderDashboard() {
  if (state.user.role === "organization") renderOrganization();
  else renderUser();
}

function renderUser() {
  $("#dashboard").innerHTML = `
    <div class="hero-band">
      <div><h1>Eventos disponibles</h1><p>Explora eventos creados por organizaciones, compra boletos y conserva la validación criptográfica de cada QR.</p></div>
      <div class="crypto-box">AES protege tus datos. ECDSA y SHA-256 prueban autenticidad e integridad sin revelar tu identidad.</div>
    </div>
    <div class="grid">
      <section class="panel span-7">
        <h2>Próximos eventos</h2>
        <p class="muted">${moneylessCopy()}</p>
        <div class="event-tools">
          <label><span>Buscar evento</span><input id="eventSearch" placeholder="Lupa: nombre, lugar u organización" value="${state.eventSearch}"></label>
          <label><span>Por organizador</span><select id="organizationFilter">
            <option value="">Todas las organizaciones</option>
            ${state.organizations.map((org) => `<option value="${org.id}" ${state.organizationFilter === org.id ? "selected" : ""}>${org.name}</option>`).join("")}
          </select></label>
        </div>
        <div id="eventList" class="event-list"></div>
      </section>
      <section class="panel span-5">
        <h2>Transferencias recibidas</h2>
        <div id="incomingTransferList" class="ticket-list"></div>
      </section>
      <section class="panel span-12">
        <h2>Gestionar mis boletos</h2>
        <div id="ticketList" class="ticket-list"></div>
      </section>
    </div>`;

  $("#eventSearch").addEventListener("input", (event) => {
    state.eventSearch = event.target.value;
    renderEventList();
  });
  $("#organizationFilter").addEventListener("change", (event) => {
    state.organizationFilter = event.target.value;
    renderEventList();
  });
  renderEventList();
  renderIncomingTransfers();
  renderTicketList($("#ticketList"), state.tickets, false);
}

function ticketsOwnedForEvent(eventId) {
  return state.tickets.filter((ticket) => ticket.eventId === eventId).length;
}

async function openPurchaseModal(eventItem) {
  const availability = await api(`/api/events/${encodeURIComponent(eventItem.id)}/availability`);
  const zoneOptions = availability.zones.map((zone) => `<option value="${escapeHtml(zone.zone)}" ${zone.full ? "disabled" : ""}>${escapeHtml(zone.zone)}${zone.full ? " - agotada" : ""}</option>`).join("");
  const promise = openModal(`
    <h3>Selecciona tu lugar</h3>
    <p><strong>${escapeHtml(eventItem.name)}</strong></p>
    <p class="muted">Costo: ${formatPrice(eventItem.price, eventItem.currency || "MXN")}. El lugar se asigna automáticamente entre 1 y 500 dentro de la sección elegida.</p>
    <img class="seat-map" src="/mapa.png" alt="Mapa de zonas del evento">
    <div class="form">
      <label><span>Zona</span><select id="zoneSelect"><option value="">Selecciona zona</option>${zoneOptions}</select></label>
      <label><span>Sección</span><select id="sectionSelect" disabled><option value="">Selecciona sección</option></select></label>
      <label><span>Contraseña</span><input id="purchasePassword" type="password" placeholder="Firma ECDSA del boleto" autocomplete="current-password"></label>
    </div>
    <div class="modal-actions">
      <button class="ghost" data-modal-cancel>Cancelar</button>
      <button data-modal-confirm disabled>Confirmar compra</button>
    </div>`);
  const zoneSelect = $("#zoneSelect");
  const sectionSelect = $("#sectionSelect");
  const passwordInput = $("#purchasePassword");
  const confirmButton = $("[data-modal-confirm]");
  function updateSections() {
    const zone = availability.zones.find((item) => item.zone === zoneSelect.value);
    sectionSelect.disabled = !zone;
    sectionSelect.innerHTML = `<option value="">Selecciona sección</option>${zone ? zone.sections.map((section) => `<option value="${escapeHtml(section.section)}" ${section.full ? "disabled" : ""}>${escapeHtml(section.section)} · ${section.remaining}/${section.capacity} disponibles${section.full ? " - agotada" : ""}</option>`).join("") : ""}`;
    updateConfirm();
  }
  function updateConfirm() {
    confirmButton.disabled = !zoneSelect.value || !sectionSelect.value || !passwordInput.value.trim();
  }
  zoneSelect.onchange = updateSections;
  sectionSelect.onchange = updateConfirm;
  passwordInput.oninput = updateConfirm;
  $("[data-modal-cancel]").onclick = () => closeModal(null);
  confirmButton.onclick = () => {
    if (!zoneSelect.value || !sectionSelect.value) return showToast("Selecciona zona y sección.", true);
    if (!passwordInput.value.trim()) return showToast("Confirma tu contraseña para firmar el boleto.", true);
    closeModal({ zone: zoneSelect.value, section: sectionSelect.value, password: passwordInput.value });
  };
  return await promise;
}

function renderEventList() {
  const container = $("#eventList");
  const query = state.eventSearch.trim().toLowerCase();
  const events = state.events.filter((event) => {
    const matchesSearch = !query || [event.name, event.venue, event.organizer].some((value) => String(value || "").toLowerCase().includes(query));
    const matchesOrg = !state.organizationFilter || event.organizationId === state.organizationFilter;
    return matchesSearch && matchesOrg;
  });
  if (!events.length) {
    container.innerHTML = `<p class="muted">Aún no hay eventos proximos.</p>`;
    return;
  }
  container.innerHTML = events.map((event) => {
    const owned = ticketsOwnedForEvent(event.id);
    return `
      <article class="event-card">
        <div>
          <strong>${event.name}</strong>
          <p class="muted">${event.date} ${event.time} · ${event.venue}</p>
          <span class="pill">${event.organizer}</span>
          <span class="pill">${formatPrice(event.price, event.currency || "MXN")}</span>
          <p class="muted">${owned}/5 boletos comprados para este evento</p>
        </div>
        <button data-buy="${event.id}" ${owned >= 5 ? "disabled" : ""}>Comprar boleto</button>
      </article>`;
  }).join("");
  container.onclick = async (event) => {
    const id = event.target.dataset.buy;
    if (!id) return;
    const selected = state.events.find((item) => item.id === id);
    if (ticketsOwnedForEvent(id) >= 5) return;
    try {
      const purchase = await openPurchaseModal(selected);
      if (!purchase) return;
      await api("/api/tickets", { method: "POST", body: JSON.stringify({ eventId: id, ...purchase }) });
      showToast("Boleto comprado y firmado con tu llave ECDSA.");
      await loadDashboard();
    } catch (error) {
      showToast(error.message, true);
    }
  };
}

function renderIncomingTransfers() {
  const container = $("#incomingTransferList");
  if (!state.incomingTransfers.length) {
    container.innerHTML = `<p class="muted">No tienes boletos pendientes por aceptar.</p>`;
    return;
  }
  container.innerHTML = state.incomingTransfers.map((ticket) => `
    <article class="ticket-card">
      <div class="ticket-head">
        <div><strong>${ticket.publicClaims.eventName}</strong><p class="muted">${ticket.publicClaims.organizer}</p></div>
        <span class="pill transfer_pending">Pendiente</span>
      </div>
      <p><strong>Costo original:</strong> ${formatPrice(ticket.publicClaims.price || ticket.purchasePrice, ticket.publicClaims.currency || ticket.currency || "MXN")}</p>
      <p><strong>Código visible:</strong> ${ticket.visibleCode}</p>
      <p><strong>Lugar:</strong> ${seatText(ticket.seat || ticket.publicClaims?.seat)}</p>
      ${ticket.transfer?.expiresAt ? `<p class="muted">Expira: ${new Date(ticket.transfer.expiresAt).toLocaleString()}</p>` : `<p class="muted">Boleto firmado recibido. Sólo necesitas aceptarlo para verlo en tu historial.</p>`}
      <div class="actions">
        <button data-accept="${ticket.id}">Aceptar</button>
        <button class="ghost" data-reject="${ticket.id}">Rechazar</button>
      </div>
    </article>`).join("");
  container.onclick = async (event) => {
    if (event.target.dataset.accept) {
      const password = await promptModal("Aceptar transferencia", "Para recibir el boleto, se actualizará el titular y se firmará con tu llave privada ECDSA.", "Contraseña", { type: "password", action: "Aceptar boleto" });
      if (!password) return;
      try {
        await api(`/api/transfers/${event.target.dataset.accept}/accept`, { method: "POST", body: JSON.stringify({ password }) });
        showToast("Boleto aceptado y firmado.");
        await loadDashboard();
      } catch (error) { showToast(error.message, true); }
    }
    if (event.target.dataset.reject) {
      if (!await confirmModal("Rechazar transferencia", "El boleto regresará a estar disponible para quien lo envió.", "Rechazar", true)) return;
      await api(`/api/transfers/${event.target.dataset.reject}/reject`, { method: "POST" });
      showToast("Transferencia rechazada.");
      await loadDashboard();
    }
  };
}

function renderOrganization() {
  $("#dashboard").innerHTML = `
    <div class="hero-band">
      <div><h1>Panel de organización</h1><p>Crea eventos, consulta boletos emitidos y usa el acceso por QR o código visible sin mostrar trazabilidad durante el ingreso.</p></div>
      <div class="crypto-box">AES protege datos personales. ECDSA y SHA-256 validan autenticidad, integridad y responsabilidad del boleto firmado.</div>
    </div>
    <div class="grid">
      <section class="panel span-6">
        <h2>Escáner de acceso</h2>
        <form id="orgAccessForm" class="form">
          <label><span>Código visible o QR escaneado</span><input name="code" placeholder="Ej. A1B2C3D4E5F6"></label>
          <button type="submit">Ver datos de acceso</button>
        </form>
        <div class="actions" style="margin-top:12px">
          <button id="startScan" class="secondary">Activar cámara</button>
          <button id="stopScan" class="ghost">Detener</button>
        </div>
        <video id="video" playsinline></video>
        <p id="scanNotice" class="muted">Si la cámara no funciona, ingresa el código visible del PDF.</p>
        <div id="orgResult"></div>
      </section>
      <section class="panel span-6">
        <h2>Ver información del boleto</h2>
        <form id="orgInfoForm" class="form">
          <label><span>Código visible, token o QR</span><input name="code" placeholder="Código visible o token de acceso"></label>
          <button type="submit">Consultar expediente del boleto</button>
        </form>
        <div class="actions" style="margin-top:12px">
          <button id="startInfoScan" class="secondary">Activar cámara para expediente</button>
          <button id="stopInfoScan" class="ghost">Detener</button>
        </div>
        <video id="infoVideo" playsinline></video>
        <p id="infoScanNotice" class="muted">También puedes escanear el QR para consultar el expediente completo del boleto.</p>
        <div id="orgInfoResult"></div>
      </section>
      <section class="panel span-5">
        <h2>Crear evento</h2>
        <form id="eventForm" class="form">
          <label><span>Nombre del evento</span><input name="name" required placeholder="Festival Cultura Abierta"></label>
          <label><span>Fecha</span><input name="date" type="date" required></label>
          <label><span>Hora</span><input name="time" type="time" required></label>
          <label><span>Lugar</span><input name="venue" required placeholder="Foro cultural"></label>
          <label><span>Organización visible</span><input name="organizer" placeholder="${state.user.organizationName || state.user.name}"></label>
          <div class="event-tools">
            <label><span>Precio del boleto</span><input name="price" type="number" min="1" step="1" required placeholder="1000"></label>
            <label><span>Divisa</span><select name="currency"><option value="MXN">MXN</option><option value="USD">USD</option><option value="EUR">EUR</option></select></label>
          </div>
          <button type="submit">Publicar evento</button>
        </form>
      </section>
      <section class="panel span-7">
        <h2>Boletos emitidos</h2>
        <p class="muted">Se muestran hasta 4 eventos. Desliza verticalmente para consultar el resto.</p>
        <div id="orgStats" class="stats-grid stats-carousel"></div>
      </section>
    </div>`;
  const priceInput = $("#eventForm [name=price]");
  const currencySelect = $("#eventForm [name=currency]");
  currencySelect.addEventListener("change", (event) => {
    const previous = currencySelect.dataset.previous || "MXN";
    priceInput.value = convertCurrency(priceInput.value, previous, event.target.value);
    currencySelect.dataset.previous = event.target.value;
  });
  $("#eventForm").addEventListener("submit", createEvent);
  $("#orgAccessForm").addEventListener("submit", validateAccessTicket);
  $("#orgInfoForm").addEventListener("submit", validateInfoTicket);
  $("#startScan").addEventListener("click", () => startScanner("access"));
  $("#stopScan").addEventListener("click", stopScanner);
  $("#startInfoScan").addEventListener("click", () => startScanner("info"));
  $("#stopInfoScan").addEventListener("click", stopScanner);
  renderOrgStats();
}

function renderOrgStats() {
  const container = $("#orgStats");
  if (!state.orgStats.length) {
    container.innerHTML = `<p class="muted">Aún no has creado eventos.</p>`;
    return;
  }
  container.innerHTML = state.orgStats.map(({ event, total, valid, used, pendingTransfer }) => `
    <article class="stat-card">
      <strong>${event.name}</strong>
      <p><strong>Costo:</strong> ${formatPrice(event.price, event.currency || "MXN")}</p>
      <p class="muted">${event.date} ${event.time} · ${event.venue}</p>
      <div class="stat-row"><span>Total emitidos</span><b>${total}</b></div>
      <div class="stat-row"><span>Válidos</span><b>${valid}</b></div>
      <div class="stat-row"><span>Usados</span><b>${used}</b></div>
      <div class="stat-row"><span>En transferencia</span><b>${pendingTransfer}</b></div>
      <button class="danger" data-delete-event="${event.id}">Eliminar evento</button>
    </article>`).join("");
  container.onclick = async (event) => {
    const id = event.target.dataset.deleteEvent;
    if (!id) return;
    if (!await confirmModal("Eliminar evento", "Los boletos emitidos quedarán cancelados en el historial de los usuarios.", "Eliminar evento", true)) return;
    try {
      await api(`/api/events/${id}`, { method: "DELETE" });
      showToast("Evento eliminado y boletos cancelados.");
      await loadDashboard();
    } catch (error) {
      showToast(error.message, true);
    }
  };
}

async function createEvent(event) {
  event.preventDefault();
  try {
    await api("/api/events", { method: "POST", body: JSON.stringify(formData(event.target)) });
    event.target.reset();
    await loadDashboard();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderTicketList(container, tickets, organization) {
  if (!tickets.length) {
    container.innerHTML = `<p class="muted">Aún no hay boletos.</p>`;
    return;
  }
  const template = $("#ticketTemplate");
  container.innerHTML = "";
  tickets.forEach((ticket) => {
    const node = template.content.cloneNode(true);
    $("[data-field=eventName]", node).textContent = ticket.publicClaims.eventName;
    $("[data-field=date]", node).textContent = `${ticket.publicClaims.eventDate} ${ticket.publicClaims.eventTime} · ${ticket.publicClaims.venue} · ${ticket.publicClaims.organizer}`;
    const status = $("[data-field=status]", node);
    status.textContent = statusText(ticket.status);
    status.classList.add(ticket.status);
    const actions = $("[data-field=actions]", node);
    const pending = Boolean(ticket.transfer && ticket.transfer.status === "pending");
    actions.innerHTML = `
      <span class="pill">${formatPrice(ticket.publicClaims.price || ticket.purchasePrice, ticket.publicClaims.currency || ticket.currency || "MXN")}</span>
      <span class="pill">Código visible: ${ticket.visibleCode || "No generado"}</span>
      ${ticket.seat ? `<span class="pill">${seatText(ticket.seat)}</span>` : ""}
      <a class="button secondary" href="${ticketPdfUrl(ticket)}" target="_blank" rel="noopener">PDF</a>
      ${ticket.holderSignature ? `<span class="pill valid">Firmado ECDSA: ${ticket.holderSignature.signerEmail}</span>` : ""}
      <button data-transfer="${ticket.publicCode}" ${ticket.status !== "valid" || pending ? "disabled" : ""}>Transferir</button>
      <button class="secondary" data-delete="${ticket.publicCode}" ${pending ? "disabled" : ""}>Eliminar boleto</button>
      ${pending ? `<span class="pill transfer_pending">Transferencia pendiente para ${ticket.transfer.toEmail}</span>` : ""}
      ${organization ? `<button data-check="${ticket.publicCode}">Verificar</button><button class="danger" data-admit="${ticket.publicCode}">Permitir acceso</button>` : ""}
    `;
    actions.addEventListener("click", handleTicketAction);
    container.appendChild(node);
  });
}

async function handleTicketAction(event) {
  const target = event.target;
  if (target.dataset.copy) {
    await navigator.clipboard.writeText(target.dataset.copy);
    target.textContent = "Copiado";
  }
  if (target.dataset.transfer) await askTransfer(target.dataset.transfer);
  if (target.dataset.delete) {
    if (!await confirmModal("Eliminar boleto", "El boleto dejará de aparecer en tu historial. El PDF se genera dinámicamente y no se conserva almacenamiento permanente.", "Eliminar boleto", true)) return;
    try {
      await api(`/api/tickets/${target.dataset.delete}/delete`, { method: "POST" });
      showToast("Boleto eliminado del historial.");
      await loadDashboard();
    } catch (error) { showToast(error.message, true); }
  }
  if (target.dataset.check) await showTicket(target.dataset.check, "#orgResult");
  if (target.dataset.admit) await admitTicket(target.dataset.admit, "#orgResult");
}

async function askTransfer(code) {
  const email = await promptModal("Transferir boleto", "Escribe el correo registrado de la persona que recibirá el boleto. Mientras esté pendiente, sólo podrás descargar el PDF.", "Correo destino", { type: "email", action: "Enviar transferencia" });
  if (!email) return;
  try {
    const data = await api(`/api/tickets/${encodeURIComponent(code)}/transfer`, { method: "POST", body: JSON.stringify({ email }) });
    if (data.emailWarning) {
      showToast(`El boleto sí quedó en transferencia, pero no se envió correo: ${data.emailWarning}`, true);
    } else {
      showToast("Transferencia enviada.");
    }
    await loadDashboard();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function validateAccessTicket(event) {
  event.preventDefault();
  const code = ticketCodeFromInput(formData(event.target).code);
  try {
    const { ticket } = await api(`/api/organization/access/${encodeURIComponent(code)}`);
    $("#orgResult").innerHTML = ticketDetails(ticket, true, { accessOnly: true, allowAdmit: true });
  } catch (error) {
    $("#orgResult").innerHTML = `<p class="notice" style="color:var(--bad)">${escapeHtml(error.message)}</p>`;
  }
}

async function validateInfoTicket(event) {
  event.preventDefault();
  const code = ticketCodeFromInput(formData(event.target).code);
  try {
    await showTicket(code, "#orgInfoResult", { includeTrace: true });
  } catch (error) {
    $("#orgInfoResult").innerHTML = `<p class="notice" style="color:var(--bad)">${escapeHtml(error.message)}</p>`;
  }
}

async function validateTicket(event) {
  event.preventDefault();
  const code = ticketCodeFromInput(formData(event.target).code);
  const target = state.user.role === "organization" ? "#orgResult" : "#validationResult";
  await showTicket(code, target);
}

async function showTicket(code, targetSelector, options = {}) {
  const { ticket } = await api(`/api/tickets/${encodeURIComponent(code)}`);
  $(targetSelector).innerHTML = ticketDetails(ticket, state.user?.role === "organization", options);
}

async function admitTicket(code, targetSelector = "#orgResult") {
  try {
    const { ticket } = await api(`/api/organization/tickets/${encodeURIComponent(code)}/admit`, { method: "POST" });
    $(targetSelector).innerHTML = ticketDetails(ticket, true);
    await loadDashboard();
  } catch (error) {
    $(targetSelector).innerHTML = `<p class="notice" style="color:var(--bad)">${error.message}</p>`;
  }
}

function ticketDetails(ticket, organization = false, options = {}) {
  const verification = ticket.verification || {};
  return `
    <article class="ticket-card" style="margin-top:14px">
      <div class="ticket-head"><strong>${ticket.publicClaims.eventName}</strong><span class="pill ${ticket.status}">${statusText(ticket.status)}</span></div>
      <p class="muted">${ticket.publicClaims.eventDate} ${ticket.publicClaims.eventTime} · ${ticket.publicClaims.venue}</p>
      <p><strong>Organización:</strong> ${ticket.publicClaims.organizer}</p>
      <p><strong>Costo original:</strong> ${formatPrice(ticket.publicClaims.price || ticket.purchasePrice, ticket.publicClaims.currency || ticket.currency || "MXN")}</p>
      <p><strong>Código visible:</strong> ${ticket.visibleCode}</p>
      <p><strong>Lugar:</strong> ${seatText(ticket.seat || ticket.publicClaims?.seat)}</p>
      <div class="status-line">
        <span class="pill ${verification.authentic ? "valid" : "tampered"}">${verification.authentic ? "Firma auténtica" : "Firma inválida"}</span>
        <span class="pill ${verification.hashMatches ? "valid" : "tampered"}">${verification.hashMatches ? "Hash coincide" : "Hash alterado"}</span>
      </div>
      ${ticket.qrDataUrl ? `<img class="qr" src="${ticket.qrDataUrl}" alt="Codigo QR">` : ""}
      ${organization && ticket.holder ? `<p><strong>Titular registrado:</strong> ${escapeHtml(ticket.holder.name)} · ${escapeHtml(ticket.holder.email)}</p>` : `<p class="muted">Datos personales protegidos con AES. No se muestran en validación pública.</p>`}
      <div class="crypto-box">SHA-256: ${ticket.crypto.hash}<br>Firma ECDSA: ${ticket.crypto.signature.slice(0, 96)}...<br>Llave pública: ${ticket.crypto.publicKeyFingerprint}</div>
      ${organization && !options.accessOnly && ticket.traceability ? traceabilityDetails(ticket.traceability) : ""}
      ${organization && options.allowAdmit && ticket.status === "valid" ? `<button class="danger" onclick="admitTicket('${ticket.publicCode}')">Permitir acceso y consumir boleto</button>` : ""}
    </article>`;
}

function traceabilityDetails(traceability) {
  return `
    <details class="trace-box" open>
      <summary>Trazabilidad del boleto</summary>
      <ol>
        ${traceability.map((item) => `<li><strong>${item.label}</strong><br><span class="muted">${new Date(item.at).toLocaleString()} · ${item.detail}</span></li>`).join("")}
      </ol>
    </details>`;
}

let stream;
let scanTimer;
let currentScanMode = "access";

function scannerTargets(mode = "access") {
  if (mode === "info") {
    return {
      video: "#infoVideo",
      notice: "#infoScanNotice",
      result: "#orgInfoResult",
      handler: infoTicketFromScan,
    };
  }
  return {
    video: "#video",
    notice: "#scanNotice",
    result: "#orgResult",
    handler: accessTicketFromScan,
  };
}

async function startScanner(mode = "access") {
  currentScanMode = mode;
  const targets = scannerTargets(mode);
  const notice = $(targets.notice);
  if (!notice) return;
  if (!("BarcodeDetector" in window)) {
    notice.textContent = "Este navegador no soporta BarcodeDetector. Usa el campo manual con el código visible.";
    return;
  }
  stopScanner();
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  const video = $(targets.video);
  video.srcObject = stream;
  await video.play();
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  scanTimer = setInterval(async () => {
    const codes = await detector.detect(video).catch(() => []);
    if (codes[0]) {
      const code = ticketCodeFromInput(codes[0].rawValue);
      notice.textContent = `QR detectado: ${code}`;
      await targets.handler(code);
      stopScanner();
    }
  }, 700);
}

async function accessTicketFromScan(code) {
  try {
    const { ticket } = await api(`/api/organization/access/${encodeURIComponent(code)}`);
    $("#orgResult").innerHTML = ticketDetails(ticket, true, { accessOnly: true, allowAdmit: true });
  } catch (error) {
    $("#orgResult").innerHTML = `<p class="notice" style="color:var(--bad)">${escapeHtml(error.message)}</p>`;
  }
}

async function infoTicketFromScan(code) {
  try {
    await showTicket(code, "#orgInfoResult", { includeTrace: true });
  } catch (error) {
    $("#orgInfoResult").innerHTML = `<p class="notice" style="color:var(--bad)">${escapeHtml(error.message)}</p>`;
  }
}

function stopScanner() {
  clearInterval(scanTimer);
  if (stream) stream.getTracks().forEach((track) => track.stop());
  const activeVideo = $(scannerTargets(currentScanMode).video);
  if (activeVideo) activeVideo.srcObject = null;
  stream = null;
}

init().catch((error) => setNotice(error.message, true));
