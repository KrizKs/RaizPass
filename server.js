import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import session from "express-session";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "storage");
const TICKETS_DIR = path.join(STORAGE_DIR, "tickets");
const EMAIL_DIR = path.join(STORAGE_DIR, "email-previews");
const DB_PATH = path.join(DATA_DIR, "db.json");
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
const DELETE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TICKETS_PER_USER_EVENT = 5;
const DEMO_PASSWORD = "Admin123!";
const DEMO_ORGS = [
  { id: "admin", name: "ExpoESCOM", email: "admin@expo.test" },
  { id: "org-lumina", name: "Lumina Eventos", email: "lumina@expo.test" },
  { id: "org-zenit", name: "Zenit Producciones", email: "zenit@expo.test" },
];

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "expo-escom-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", maxAge: 1000 * 60 * 60 * 8 },
  }),
);
app.use(express.static(path.join(__dirname, "public")));
app.use("/tickets", express.static(TICKETS_DIR));

async function ensureStorage() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(TICKETS_DIR, { recursive: true });
  await fs.mkdir(EMAIL_DIR, { recursive: true });
  try {
    const db = await readDb();
    await writeDb(migrateDb(db));
  } catch {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const orgs = await seedOrganizations();
    const db = {
      users: orgs,
      tickets: [],
      deletedTicketCounters: {},
      events: seedEvents(),
      keys: {
        aesKey: crypto.randomBytes(32).toString("base64"),
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
      },
      meta: { createdAt: new Date().toISOString() },
    };
    await writeDb(db);
  }
}

function migrateDb(db) {
  db.users ||= [];
  db.tickets ||= [];
  db.events ||= [];
  db.deletedTicketCounters ||= {};
  for (const orgInfo of DEMO_ORGS) {
    let org = db.users.find((user) => user.email?.toLowerCase() === orgInfo.email);
    if (!org) {
      org = {
        id: orgInfo.id,
        role: "organization",
        name: orgInfo.name,
        organizationName: orgInfo.name,
        email: orgInfo.email,
        passwordHash: "$2a$10$7u4WxOEzpjHXVFRhk/KFWu4MRkWRBqSe.xLgSno89zWo8KjEWaUKm",
        verified: true,
        createdAt: new Date().toISOString(),
      };
      db.users.push(org);
    }
    org.id = orgInfo.id;
    org.role = "organization";
    org.name = orgInfo.name;
    org.organizationName = orgInfo.name;
    org.verified = true;
  }
  if (db.meta?.seedVersion !== 4) {
    db.events = seedEvents();
    db.meta ||= {};
    db.meta.seedVersion = 4;
  } else {
    db.events = db.events.map((event) => ({
      ...event,
      organizer: event.organizer || organizationName(db, event.organizationId),
      price: normalizePrice(event.price),
      createdAt: event.createdAt || new Date().toISOString(),
    }));
  }
  db.tickets = db.tickets.map((ticket) => ({
    ...ticket,
    eventId: ticket.eventId || db.events.find((event) => event.name === ticket.publicClaims?.eventName)?.id || db.events[0]?.id,
    organizationId: ticket.organizationId || db.events.find((event) => event.id === ticket.eventId)?.organizationId || DEMO_ORGS[0].id,
    purchasePrice: normalizePrice(ticket.purchasePrice || ticket.publicClaims?.price || db.events.find((event) => event.id === ticket.eventId)?.price),
    publicClaims: {
      ...ticket.publicClaims,
      price: normalizePrice(ticket.publicClaims?.price || ticket.purchasePrice || db.events.find((event) => event.id === ticket.eventId)?.price),
    },
    hiddenFor: ticket.hiddenFor || [],
  }));
  return db;
}

async function seedOrganizations() {
  return Promise.all(DEMO_ORGS.map(async (org) => ({
    id: org.id,
    role: "organization",
    name: org.name,
    organizationName: org.name,
    email: org.email,
    passwordHash: await bcrypt.hash(DEMO_PASSWORD, 10),
    verified: true,
    createdAt: new Date().toISOString(),
  })));
}

function seedEvents() {
  return [
    {
      id: "evt-crypto",
      organizationId: "admin",
      name: "Expo Cripto: Acceso Seguro",
      date: "2026-06-04",
      time: "11:00",
      venue: "ESCOM IPN - Auditorio Principal",
      organizer: "ExpoESCOM",
      price: 80,
      createdAt: new Date().toISOString(),
    },
    {
      id: "evt-ia",
      organizationId: "org-lumina",
      name: "Foro de Innovacion Digital",
      date: "2026-06-12",
      time: "16:30",
      venue: "Centro Cultural Jaime Torres Bodet",
      organizer: "Lumina Eventos",
      price: 145,
      createdAt: new Date().toISOString(),
    },
    {
      id: "evt-redes",
      organizationId: "org-zenit",
      name: "Seminario de Seguridad en Redes",
      date: "2026-06-20",
      time: "10:00",
      venue: "ESCOM IPN - Sala de Usos Multiples",
      organizer: "Zenit Producciones",
      price: 110,
      createdAt: new Date().toISOString(),
    },
    {
      id: "evt-taller-aes",
      organizationId: "admin",
      name: "Taller AES para Boletos Privados",
      date: "2026-07-03",
      time: "12:00",
      venue: "ESCOM IPN - Laboratorio 4",
      organizer: "ExpoESCOM",
      price: 65,
      createdAt: new Date().toISOString(),
    },
    {
      id: "evt-lumina-cultura",
      organizationId: "org-lumina",
      name: "Festival Lumina Cultura Abierta",
      date: "2026-07-18",
      time: "19:00",
      venue: "Foro Cultural Lindavista",
      organizer: "Lumina Eventos",
      price: 210,
      createdAt: new Date().toISOString(),
    },
    {
      id: "evt-zenit-musica",
      organizationId: "org-zenit",
      name: "Concierto Zenit Terra Viva",
      date: "2026-08-02",
      time: "20:30",
      venue: "Auditorio Nacional Demo",
      organizer: "Zenit Producciones",
      price: 275,
      createdAt: new Date().toISOString(),
    },
  ];
}

function normalizePrice(price) {
  const value = Number(price);
  if (Number.isFinite(value) && value >= 50 && value <= 300) return Math.round(value);
  return randomPrice();
}

function randomPrice() {
  return Math.floor(Math.random() * 251) + 50;
}

function organizationName(db, organizationId) {
  const org = db.users.find((user) => user.id === organizationId);
  return org?.organizationName || org?.name || "Organizacion";
}

async function readDb() {
  return JSON.parse(await fs.readFile(DB_PATH, "utf8"));
}

async function writeDb(db) {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

async function loadDb() {
  const db = migrateDb(await readDb());
  const changed = cleanupDb(db);
  if (changed) await writeDb(db);
  return db;
}

function cleanupDb(db) {
  let changed = false;
  const now = Date.now();
  for (const ticket of db.tickets) {
    if (ticket.transfer?.status === "pending" && ticket.transfer.expiresAt < now) {
      delete ticket.transfer;
      changed = true;
    }
    const staleUsed = ticket.usedAt && Date.parse(ticket.usedAt) + DELETE_AFTER_MS < now;
    const staleExpired = effectiveStatus(ticket, db.events) === "expired" && Date.parse(ticket.publicClaims.eventDate) + DELETE_AFTER_MS < now;
    if ((staleUsed || staleExpired) && ticket.ownerId && !(ticket.hiddenFor || []).includes(ticket.ownerId)) {
      ticket.hiddenFor = [...(ticket.hiddenFor || []), ticket.ownerId];
      changed = true;
    }
  }
  return changed;
}

function publicUser(user) {
  return user && {
    id: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    verified: user.verified,
    organizationName: user.organizationName,
  };
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Inicia sesion para continuar." });
  next();
}

function requireOrganization(req, res, next) {
  if (req.session.role !== "organization") return res.status(403).json({ error: "Permisos insuficientes." });
  next();
}

function requireUser(req, res, next) {
  if (req.session.role !== "user") return res.status(403).json({ error: "Esta accion es para usuarios compradores." });
  next();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function encryptSensitive(db, payload) {
  const key = Buffer.from(db.keys.aesKey, "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    alg: "AES-256-GCM",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptSensitive(db, encrypted) {
  const key = Buffer.from(db.keys.aesKey, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function signTicket(db, publicClaims, encryptedHolder) {
  const digest = sha256(canonical({ publicClaims, encryptedHolder }));
  const signer = crypto.createSign("SHA256");
  signer.update(digest);
  signer.end();
  return {
    hash: digest,
    signature: signer.sign(db.keys.privateKeyPem, "base64"),
    publicKeyFingerprint: sha256(db.keys.publicKeyPem).slice(0, 24),
    signatureAlg: "ECDSA-P256-SHA256",
    hashAlg: "SHA-256",
  };
}

function verifyTicket(db, ticket) {
  const recalculatedHash = sha256(canonical({ publicClaims: ticket.publicClaims, encryptedHolder: ticket.encryptedHolder }));
  const verifier = crypto.createVerify("SHA256");
  verifier.update(recalculatedHash);
  verifier.end();
  const signatureValid = verifier.verify(db.keys.publicKeyPem, ticket.crypto.signature, "base64");
  return {
    hashMatches: recalculatedHash === ticket.crypto.hash,
    signatureValid,
    authentic: recalculatedHash === ticket.crypto.hash && signatureValid,
    recalculatedHash,
  };
}

function effectiveStatus(ticket, events = []) {
  if (ticket.status === "used" || ticket.status === "tampered") return ticket.status;
  const event = events.find((item) => item.id === ticket.eventId);
  const dateText = event?.date || ticket.publicClaims?.eventDate;
  if (dateText) {
    const eventEnd = new Date(`${dateText}T23:59:59`).getTime();
    if (Number.isFinite(eventEnd) && eventEnd < Date.now()) return "expired";
  }
  return ticket.status || "valid";
}

function randomEvent(organizer) {
  const names = ["Festival Raiz Digital", "Concierto Terra Viva", "Encuentro Cultura Abierta", "Foro Ciudad Creativa"];
  const venues = ["Auditorio ESCOM", "Centro Cultural IPN", "Jardin Botanico Chapultepec", "Foro Cultural Lindavista"];
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const date = new Date(Date.now() + Math.floor(Math.random() * 25 + 5) * 86400000);
  return {
    name: pick(names),
    date: date.toISOString().slice(0, 10),
    time: `${String(Math.floor(Math.random() * 8 + 10)).padStart(2, "0")}:00`,
    venue: pick(venues),
    organizer,
    price: randomPrice(),
  };
}

async function createTicketPdf(ticket, qrDataUrl) {
  const filename = `${ticket.id}.pdf`;
  const fullPath = path.join(TICKETS_DIR, filename);
  const qrImage = qrDataUrl.replace(/^data:image\/png;base64,/, "");
  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", async () => {
      try {
        await fs.writeFile(fullPath, Buffer.concat(chunks));
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    doc.rect(0, 0, 595, 842).fill("#ffffff");
    doc.rect(0, 0, 595, 142).fill("#4C4842");
    doc.fillColor("#E3CC8C").fontSize(26).text("Pase verificado", 48, 54);
    doc.fillColor("#ffffff").fontSize(14).text(ticket.publicClaims.organizer, 48, 88);
    doc.fillColor("#4C4842").fontSize(20).text(ticket.publicClaims.eventName, 48, 172);
    doc.fillColor("#4C4842").fontSize(12).text(`${ticket.publicClaims.eventDate} - ${ticket.publicClaims.eventTime}`, 48, 204);
    doc.text(ticket.publicClaims.venue, 48, 224);
    doc.fillColor("#4C4842").fontSize(14).text(`Costo original: $${ticket.publicClaims.price} MXN`, 48, 250);
    doc.image(Buffer.from(qrImage, "base64"), 165, 285, { width: 260 });
    doc.fillColor("#4C4842").fontSize(12).text("Escanea para validar autenticidad sin revelar datos personales.", 92, 575, { align: "center", width: 410 });
    doc.fillColor("#82B979").fontSize(9).text(`ID publico: ${ticket.publicClaims.ticketCode}`, 48, 730);
    doc.text(`Firma: ${ticket.crypto.signatureAlg} | Hash: ${ticket.crypto.hashAlg}`, 48, 746);
    doc.end();
  });
  return `/tickets/${filename}`;
}

async function refreshTicketCrypto(db, ticket, owner) {
  ticket.publicCode = nanoid(22);
  ticket.encryptedHolder = encryptSensitive(db, {
    userId: owner.id,
    name: owner.name,
    email: owner.email,
    purchasedAt: ticket.createdAt,
    currentHolderSince: new Date().toISOString(),
  });
  ticket.crypto = signTicket(db, ticket.publicClaims, ticket.encryptedHolder);
  ticket.qrUrl = `${BASE_URL}/ticket/${ticket.publicCode}`;
  ticket.qrDataUrl = await QRCode.toDataURL(ticket.qrUrl, { margin: 1, width: 340, color: { dark: "#4C4842", light: "#FFFFFF" } });
  ticket.pdfUrl = await createTicketPdf(ticket, ticket.qrDataUrl);
}

async function sendPreviewEmail(to, subject, title, body, actionText, actionUrl) {
  const html = `<!doctype html>
  <html lang="es"><meta charset="utf-8"><body style="margin:0;background:#C1D7AE;font-family:Arial,sans-serif;color:#4C4842">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #82B979">
  <tr><td style="background:#4C4842;color:#FFFFFF;padding:24px 28px"><h1 style="margin:0;font-size:22px">${title}</h1><p style="margin:8px 0 0;color:#E3CC8C">Intermediario seguro de eventos</p></td></tr>
  <tr><td style="padding:28px"><p style="font-size:16px;line-height:1.55">${body}</p>
  <p style="margin:28px 0"><a href="${actionUrl}" style="background:#82B979;color:#1f241f;text-decoration:none;padding:13px 18px;border-radius:10px;font-weight:bold">${actionText}</a></p>
  <p style="font-size:12px;color:#6d685f;word-break:break-all">${actionUrl}</p></td></tr>
  </table></td></tr></table></body></html>`;
  const safeName = `${Date.now()}-${to.replace(/[^a-z0-9]/gi, "_")}.html`;
  const filePath = path.join(EMAIL_DIR, safeName);
  await fs.writeFile(filePath, html, "utf8");
  console.log(`\n[Correo simulado] ${subject} para ${to}\n${actionUrl}\nVista: ${filePath}\n`);
  return filePath;
}

async function removeIfExists(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function deleteTicketPdf(ticket) {
  if (!ticket?.pdfUrl) return;
  const filename = path.basename(ticket.pdfUrl);
  await removeIfExists(path.join(TICKETS_DIR, filename));
}

app.get("/api/session", async (req, res) => {
  const db = await loadDb();
  const user = db.users.find((item) => item.id === req.session.userId);
  const organizations = db.users
    .filter((item) => item.role === "organization")
    .map((item) => ({ id: item.id, name: item.organizationName || item.name, email: item.email }));
  const events = db.events
    .filter((event) => !user || user.role !== "organization" || event.organizationId === user.id)
    .filter((event) => new Date(`${event.date}T23:59:59`).getTime() >= Date.now())
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  res.json({ user: publicUser(user), events, organizations });
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: "Escribe tu nombre completo." });
  if (!validateEmail(email)) return res.status(400).json({ error: "El correo no tiene un formato valido." });
  if (!password || password.length < 8) return res.status(400).json({ error: "La contrasena debe tener al menos 8 caracteres." });
  const db = await loadDb();
  if (db.users.some((user) => user.email.toLowerCase() === email.toLowerCase())) {
    return res.status(409).json({ error: "Ese correo ya esta registrado." });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  const isDemoOrganization = normalizedEmail.endsWith("@expo.test");
  const token = nanoid(36);
  const user = {
    id: nanoid(12),
    role: isDemoOrganization ? "organization" : "user",
    name: String(name).trim(),
    organizationName: isDemoOrganization ? String(name).trim() : undefined,
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(password, 10),
    verified: isDemoOrganization,
    verificationToken: isDemoOrganization ? undefined : token,
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  await writeDb(db);
  if (isDemoOrganization) {
    return res.json({ ok: true, message: "Organizacion demo creada y verificada automaticamente." });
  }
  const verificationEmailPath = await sendPreviewEmail(user.email, "Verifica tu correo", "Verifica tu cuenta", "Confirma tu correo para comprar, transferir y validar boletos seguros.", "Verificar correo", `${BASE_URL}/verify-email?token=${token}`);
  user.verificationEmailPath = verificationEmailPath;
  await writeDb(db);
  res.json({ ok: true, message: "Cuenta creada. Revisa la consola o storage/email-previews para abrir el correo simulado." });
});

app.get("/verify-email", async (req, res) => {
  const db = await loadDb();
  const user = db.users.find((item) => item.verificationToken === req.query.token);
  if (!user) return res.redirect("/?notice=token-invalid");
  user.verified = true;
  delete user.verificationToken;
  await removeIfExists(user.verificationEmailPath);
  delete user.verificationEmailPath;
  await writeDb(db);
  res.redirect("/?notice=email-verified");
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const db = await loadDb();
  const user = db.users.find((item) => item.email.toLowerCase() === String(email || "").toLowerCase());
  if (!user || !(await bcrypt.compare(password || "", user.passwordHash))) {
    return res.status(401).json({ error: "Correo o contrasena incorrectos." });
  }
  if (!user.verified) return res.status(403).json({ error: "Primero verifica tu correo." });
  req.session.userId = user.id;
  req.session.role = user.role;
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.post("/api/auth/forgot", async (req, res) => {
  if (!validateEmail(req.body.email)) return res.status(400).json({ error: "El correo no tiene un formato valido." });
  const db = await loadDb();
  const user = db.users.find((item) => item.email.toLowerCase() === req.body.email.toLowerCase());
  if (user) {
    user.resetToken = nanoid(36);
    user.resetExpires = Date.now() + 1000 * 60 * 30;
    await writeDb(db);
    await sendPreviewEmail(user.email, "Restablece tu contrasena", "Restablecimiento seguro", "Recibimos una solicitud para cambiar tu contrasena. El enlace expira en 30 minutos.", "Cambiar contrasena", `${BASE_URL}/reset-password?token=${user.resetToken}`);
  }
  res.json({ ok: true, message: "Si el correo existe, se genero un correo de recuperacion simulado." });
});

app.get("/reset-password", (req, res) => res.sendFile(path.join(__dirname, "public", "reset.html")));

app.post("/api/auth/reset", async (req, res) => {
  const { token, password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: "La contrasena debe tener al menos 8 caracteres." });
  const db = await loadDb();
  const user = db.users.find((item) => item.resetToken === token && item.resetExpires > Date.now());
  if (!user) return res.status(400).json({ error: "El enlace no es valido o ya expiro." });
  user.passwordHash = await bcrypt.hash(password, 10);
  delete user.resetToken;
  delete user.resetExpires;
  await writeDb(db);
  res.json({ ok: true });
});

app.get("/api/events/random", requireAuth, requireOrganization, async (req, res) => {
  const db = await loadDb();
  const org = db.users.find((user) => user.id === req.session.userId);
  res.json(randomEvent(org.organizationName || org.name));
});

app.post("/api/events", requireAuth, requireOrganization, async (req, res) => {
  const db = await loadDb();
  const org = db.users.find((user) => user.id === req.session.userId);
  const { name, date, time, venue, organizer } = req.body;
  if (!name || !date || !time || !venue) return res.status(400).json({ error: "Completa los datos del evento." });
  const event = {
    id: nanoid(12),
    organizationId: org.id,
    name: String(name).trim(),
    date,
    time,
    venue: String(venue).trim(),
    organizer: String(organizer || org.organizationName || org.name).trim(),
    price: randomPrice(),
    createdAt: new Date().toISOString(),
  };
  db.events.push(event);
  await writeDb(db);
  res.json({ event });
});

app.delete("/api/events/:id", requireAuth, requireOrganization, async (req, res) => {
  const db = await loadDb();
  const index = db.events.findIndex((event) => event.id === req.params.id && event.organizationId === req.session.userId);
  if (index === -1) return res.status(404).json({ error: "Evento no encontrado para esta organizacion." });
  db.events.splice(index, 1);
  await writeDb(db);
  res.json({ ok: true });
});

app.get("/api/organization/stats", requireAuth, requireOrganization, async (req, res) => {
  const db = await loadDb();
  const events = db.events.filter((event) => event.organizationId === req.session.userId);
  const stats = events.map((event) => {
    const tickets = db.tickets.filter((ticket) => ticket.eventId === event.id);
    return {
      event,
      total: tickets.length + (db.deletedTicketCounters[event.id] || 0),
      valid: tickets.filter((ticket) => effectiveStatus(ticket, db.events) === "valid").length,
      used: tickets.filter((ticket) => ticket.status === "used").length,
      pendingTransfer: tickets.filter((ticket) => ticket.transfer?.status === "pending").length,
    };
  });
  res.json({ stats });
});

app.post("/api/tickets", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const user = db.users.find((item) => item.id === req.session.userId);
  const event = db.events.find((item) => item.id === req.body.eventId);
  if (!event) return res.status(404).json({ error: "Evento no encontrado." });
  if (new Date(`${event.date}T23:59:59`).getTime() < Date.now()) return res.status(400).json({ error: "El evento ya expiro." });
  const ownedForEvent = db.tickets.filter((ticket) => ticket.eventId === event.id && ticket.ownerId === user.id).length;
  if (ownedForEvent >= MAX_TICKETS_PER_USER_EVENT) {
    return res.status(400).json({ error: `Solo puedes generar hasta ${MAX_TICKETS_PER_USER_EVENT} boletos por evento.` });
  }
  const ticketCode = `BLC-${nanoid(10).toUpperCase()}`;
  const price = normalizePrice(event.price);
  const publicClaims = {
    ticketCode,
    eventName: event.name,
    eventDate: event.date,
    eventTime: event.time,
    venue: event.venue,
    organizer: event.organizer,
    price,
    issuedAt: new Date().toISOString(),
  };
  const ticket = {
    id: nanoid(14),
    eventId: event.id,
    organizationId: event.organizationId,
    ownerId: user.id,
    buyerId: user.id,
    purchasePrice: price,
    status: "valid",
    publicCode: nanoid(22),
    publicClaims,
    encryptedHolder: encryptSensitive(db, {
      userId: user.id,
      name: user.name,
      email: user.email,
      purchasedAt: new Date().toISOString(),
      currentHolderSince: new Date().toISOString(),
    }),
    accessLog: [],
    hiddenFor: [],
    createdAt: new Date().toISOString(),
    transferHistory: [],
  };
  ticket.crypto = signTicket(db, publicClaims, ticket.encryptedHolder);
  ticket.qrUrl = `${BASE_URL}/ticket/${ticket.publicCode}`;
  ticket.qrDataUrl = await QRCode.toDataURL(ticket.qrUrl, { margin: 1, width: 340, color: { dark: "#4C4842", light: "#FFFFFF" } });
  ticket.pdfUrl = await createTicketPdf(ticket, ticket.qrDataUrl);
  db.tickets.push(ticket);
  await writeDb(db);
  res.json({ ticket: summarizeTicket(ticket, db) });
});

app.get("/api/tickets", requireAuth, async (req, res) => {
  const db = await loadDb();
  if (req.session.role === "organization") {
    return res.json({ tickets: [] });
  }
  const owned = db.tickets
    .filter((ticket) => ticket.ownerId === req.session.userId && !(ticket.hiddenFor || []).includes(req.session.userId))
    .map((ticket) => summarizeTicket(ticket, db));
  const incomingTransfers = db.tickets
    .filter((ticket) => ticket.transfer?.status === "pending" && ticket.transfer.toUserId === req.session.userId)
    .map((ticket) => summarizeTicket(ticket, db, { incomingTransfer: true }));
  res.json({ tickets: owned, incomingTransfers });
});

app.get("/api/tickets/:code", async (req, res) => {
  const db = await loadDb();
  const ticket = db.tickets.find((item) => item.publicCode === req.params.code || item.id === req.params.code);
  if (!ticket) return res.status(404).json({ error: "Boleto no encontrado." });
  const verification = verifyTicket(db, ticket);
  const payload = summarizeTicket(ticket, db, {
    verification,
    includeTrace: req.session.role === "organization" && ticket.organizationId === req.session.userId,
  });
  if (req.session.role === "organization" && ticket.organizationId === req.session.userId) {
    payload.holder = decryptSensitive(db, ticket.encryptedHolder);
  }
  res.json({ ticket: payload });
});

app.get("/ticket/:code", (req, res) => res.sendFile(path.join(__dirname, "public", "ticket.html")));

app.post("/api/tickets/:code/delete", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const index = db.tickets.findIndex((item) => (item.publicCode === req.params.code || item.id === req.params.code) && item.ownerId === req.session.userId);
  const ticket = db.tickets[index];
  if (!ticket) return res.status(404).json({ error: "Boleto no encontrado." });
  db.deletedTicketCounters ||= {};
  db.deletedTicketCounters[ticket.eventId] = (db.deletedTicketCounters[ticket.eventId] || 0) + 1;
  db.tickets.splice(index, 1);
  await deleteTicketPdf(ticket);
  await writeDb(db);
  res.json({ ok: true });
});

app.post("/api/tickets/:code/transfer", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const ticket = db.tickets.find((item) => (item.publicCode === req.params.code || item.id === req.params.code) && item.ownerId === req.session.userId);
  if (!ticket) return res.status(404).json({ error: "Boleto no encontrado." });
  if (effectiveStatus(ticket, db.events) !== "valid") return res.status(400).json({ error: "Solo puedes transferir boletos validos." });
  if (!validateEmail(req.body.email)) return res.status(400).json({ error: "Correo destino invalido." });
  const recipient = db.users.find((user) => user.role === "user" && user.verified && user.email.toLowerCase() === req.body.email.toLowerCase());
  if (!recipient) return res.status(404).json({ error: "El destinatario debe tener una cuenta de usuario verificada." });
  if (recipient.id === req.session.userId) return res.status(400).json({ error: "No puedes transferirte el mismo boleto." });
  ticket.transfer = {
    id: nanoid(12),
    fromUserId: req.session.userId,
    fromEmail: db.users.find((user) => user.id === req.session.userId)?.email,
    toUserId: recipient.id,
    toEmail: recipient.email,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + TRANSFER_TTL_MS,
  };
  await writeDb(db);
  await sendPreviewEmail(recipient.email, "Te enviaron un boleto", "Transferencia de boleto", `Tienes 24 horas para aceptar el boleto de ${ticket.publicClaims.eventName}.`, "Entrar y aceptar", BASE_URL);
  res.json({ ticket: summarizeTicket(ticket, db) });
});

app.post("/api/transfers/:ticketId/accept", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const ticket = db.tickets.find((item) => item.id === req.params.ticketId && item.transfer?.status === "pending" && item.transfer.toUserId === req.session.userId);
  if (!ticket) return res.status(404).json({ error: "Transferencia no encontrada." });
  if (ticket.transfer.expiresAt < Date.now()) {
    delete ticket.transfer;
    await writeDb(db);
    return res.status(410).json({ error: "La transferencia expiro." });
  }
  const recipient = db.users.find((user) => user.id === req.session.userId);
  ticket.ownerId = recipient.id;
  ticket.transferHistory = [...(ticket.transferHistory || []), { ...ticket.transfer, acceptedAt: new Date().toISOString() }];
  delete ticket.transfer;
  await refreshTicketCrypto(db, ticket, recipient);
  await writeDb(db);
  res.json({ ticket: summarizeTicket(ticket, db) });
});

app.post("/api/transfers/:ticketId/reject", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const ticket = db.tickets.find((item) => item.id === req.params.ticketId && item.transfer?.status === "pending" && item.transfer.toUserId === req.session.userId);
  if (!ticket) return res.status(404).json({ error: "Transferencia no encontrada." });
  delete ticket.transfer;
  await writeDb(db);
  res.json({ ok: true });
});

app.post("/api/organization/tickets/:code/admit", requireAuth, requireOrganization, async (req, res) => {
  const db = await loadDb();
  const ticket = db.tickets.find((item) => item.publicCode === req.params.code || item.id === req.params.code);
  if (!ticket) return res.status(404).json({ error: "Boleto no encontrado." });
  if (ticket.organizationId !== req.session.userId) return res.status(403).json({ error: "Este boleto pertenece a otra organizacion." });
  const verification = verifyTicket(db, ticket);
  if (!verification.authentic) return res.status(400).json({ error: "La firma o el hash no son validos." });
  if (effectiveStatus(ticket, db.events) !== "valid") return res.status(409).json({ error: `El boleto esta ${effectiveStatus(ticket, db.events)}.` });
  ticket.status = "used";
  ticket.usedAt = new Date().toISOString();
  ticket.accessLog.push({ by: req.session.userId, at: ticket.usedAt, action: "admitido" });
  await writeDb(db);
  res.json({ ticket: { ...summarizeTicket(ticket, db, { verification, includeTrace: true }), holder: decryptSensitive(db, ticket.encryptedHolder) } });
});

app.post("/api/organization/tickets/:code/tamper-demo", requireAuth, requireOrganization, async (req, res) => {
  const db = await loadDb();
  const original = db.tickets.find((item) => item.publicCode === req.params.code || item.id === req.params.code);
  if (!original) return res.status(404).json({ error: "Boleto no encontrado." });
  if (original.organizationId !== req.session.userId) return res.status(403).json({ error: "Este boleto pertenece a otra organizacion." });
  const copy = structuredClone(original);
  copy.id = nanoid(14);
  copy.publicCode = nanoid(22);
  copy.publicClaims.eventName = `${copy.publicClaims.eventName} (alterado)`;
  copy.status = "tampered";
  copy.qrUrl = `${BASE_URL}/ticket/${copy.publicCode}`;
  copy.qrDataUrl = await QRCode.toDataURL(copy.qrUrl, { margin: 1, width: 340, color: { dark: "#4C4842", light: "#FFFFFF" } });
  copy.pdfUrl = await createTicketPdf(copy, copy.qrDataUrl);
  db.tickets.push(copy);
  await writeDb(db);
  res.json({ ticket: summarizeTicket(copy, db, { verification: verifyTicket(db, copy) }) });
});

function summarizeTicket(ticket, db, options = {}) {
  const status = effectiveStatus(ticket, db.events);
  const summary = {
    id: ticket.id,
    eventId: ticket.eventId,
    organizationId: ticket.organizationId,
    status: options.incomingTransfer ? "transfer_pending" : status,
    publicCode: ticket.publicCode,
    publicClaims: ticket.publicClaims,
    qrUrl: ticket.qrUrl,
    qrDataUrl: ticket.qrDataUrl,
    pdfUrl: ticket.pdfUrl,
    crypto: ticket.crypto,
    verification: options.verification || null,
    usedAt: ticket.usedAt || null,
    transfer: ticket.transfer || null,
    incomingTransfer: Boolean(options.incomingTransfer),
    accessLog: ticket.accessLog || [],
    purchasePrice: ticket.purchasePrice || ticket.publicClaims.price,
  };
  if (options.includeTrace) summary.traceability = buildTraceability(ticket, db);
  return summary;
}

function buildTraceability(ticket, db) {
  const userName = (id, fallback) => {
    const user = db.users.find((item) => item.id === id);
    return user ? `${user.name || user.organizationName} (${user.email})` : fallback || id;
  };
  const trace = [
    {
      type: "generated",
      label: "Boleto generado",
      at: ticket.createdAt,
      detail: `Titular inicial: ${userName(ticket.buyerId || ticket.ownerId)}`,
    },
  ];
  for (const transfer of ticket.transferHistory || []) {
    trace.push({
      type: "transfer_requested",
      label: "Transferencia solicitada",
      at: new Date(transfer.createdAt).toISOString(),
      detail: `${userName(transfer.fromUserId, transfer.fromEmail)} -> ${userName(transfer.toUserId, transfer.toEmail)}`,
    });
    if (transfer.acceptedAt) {
      trace.push({
        type: "transfer_accepted",
        label: "Transferencia aceptada",
        at: transfer.acceptedAt,
        detail: `Nuevo titular: ${userName(transfer.toUserId, transfer.toEmail)}`,
      });
    }
  }
  if (ticket.transfer?.status === "pending") {
    trace.push({
      type: "transfer_pending",
      label: "Transferencia pendiente",
      at: new Date(ticket.transfer.createdAt).toISOString(),
      detail: `${userName(ticket.transfer.fromUserId, ticket.transfer.fromEmail)} -> ${userName(ticket.transfer.toUserId, ticket.transfer.toEmail)}`,
    });
  }
  if (ticket.usedAt) {
    trace.push({
      type: "used",
      label: "Boleto usado",
      at: ticket.usedAt,
      detail: `Acceso permitido por ${userName(ticket.accessLog?.at(-1)?.by, "organizacion")}`,
    });
  }
  return trace.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

await ensureStorage();
app.listen(PORT, () => {
  console.log(`Sistema listo en ${BASE_URL}`);
  console.log("Organizacion de prueba: admin@expo.test / Admin123!");
});
