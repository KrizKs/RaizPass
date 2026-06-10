import bcrypt from "bcryptjs";
import "dotenv/config";
import connectPgSimple from "connect-pg-simple";
import crypto from "node:crypto";
import express from "express";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import PDFDocument from "pdfkit";
import pg from "pg";
import QRCode from "qrcode";
import session from "express-session";
import { fileURLToPath } from "node:url";
import { nanoid } from "nanoid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const RAILWAY_BASE_URL = "https://raizpass-stc2026-2.up.railway.app";
const BASE_URL = (process.env.BASE_URL || process.env.PUBLIC_BASE_URL || RAILWAY_BASE_URL).replace(/\/$/, "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "storage");
const TICKETS_DIR = path.join(STORAGE_DIR, "tickets");
const EMAIL_DIR = path.join(STORAGE_DIR, "email-previews");
const DB_PATH = path.join(DATA_DIR, "db.json");
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
const DELETE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TICKETS_PER_USER_EVENT = 5;
const CURRENCIES = {
  MXN: { label: "Pesos mexicanos", rateToMxn: 1 },
  USD: { label: "Dolares estadounidenses", rateToMxn: 18 },
  EUR: { label: "Euros", rateToMxn: 20 },
};

const SERVER_KEY_SECRET = process.env.SERVER_KEY_SECRET || process.env.SERVER_KEY_PASSPHRASE || process.env.SESSION_SECRET || "";
const SCRYPT_PARAMS = { N: Number(process.env.SCRYPT_N || 131072), r: Number(process.env.SCRYPT_R || 8), p: Number(process.env.SCRYPT_P || 1), maxmem: Number(process.env.SCRYPT_MAXMEM || 256 * 1024 * 1024) };
const PASSWORD_POLICY_MESSAGE = "La contraseña debe tener mínimo 8 caracteres, una mayúscula, un número y un carácter especial.";

const SEAT_CAPACITY_PER_SECTION = 500;
const ZONE_SECTIONS = {
  "Zona Roja": ["101", "102", "103", "104", "105", "106"],
  "Zona Azul": ["201", "202", "203", "204", "205"],
  "Zona Verde": ["301", "302"],
  "Zona Blanca": ["Balcón 1"],
  "Zona Lila": ["501", "502", "503", "504", "505", "506", "507", "508", "509", "510", "511"],
  "Zona Naranja": ["601", "602", "603", "604", "605", "606", "607", "608", "609"],
  "Zona Amarilla": ["701", "702", "703", "704", "705", "706"],
};
let cachedServerKeys = null;
let cachedMasterKey = null;
const pool = process.env.DATABASE_URL
  ? new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    })
  : null;
const DEMO_PASSWORD = "Admin123!";
const DEMO_ORGS = [
  { id: "admin", name: "ExpoESCOM", email: "admin@expo.test" },
  { id: "org-lumina", name: "Lumina Eventos", email: "lumina@expo.test" },
  { id: "org-zenit", name: "Zenit Producciones", email: "zenit@expo.test" },
];

function readSecretFile(envName) {
  const filePath = process.env[envName];
  if (!filePath) return null;
  try {
    return crypto.createHash("sha256").update(readFileSync(filePath)).digest();
  } catch {
    return null;
  }
}

function normalizeBase64Key(value) {
  if (!value) return null;
  const key = Buffer.from(String(value).trim(), "base64");
  return key.length === 32 ? key : crypto.createHash("sha256").update(key).digest();
}

function getMasterKey() {
  if (cachedMasterKey) return cachedMasterKey;
  const fromFile = readSecretFile("DATA_KEY_MASTER_FILE");
  if (fromFile) cachedMasterKey = fromFile;
  else {
    const explicit = normalizeBase64Key(process.env.DATA_KEY_MASTER_BASE64 || process.env.AES_KEY_BASE64);
    cachedMasterKey = explicit || crypto.createHash("sha256").update("raizpass-local-aes-key").digest();
  }
  delete process.env.AES_KEY_BASE64;
  delete process.env.DATA_KEY_MASTER_BASE64;
  return cachedMasterKey;
}

function getAesKey() {
  return getMasterKey();
}

function decryptJsonEnvelope(envelope, secret) {
  if (!envelope?.salt || !envelope?.iv || !envelope?.tag || !envelope?.ciphertext) {
    throw new Error("Formato de secreto cifrado inválido.");
  }
  const key = crypto.scryptSync(secret, Buffer.from(envelope.salt, "base64"), 32, SCRYPT_PARAMS);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
  if (envelope.aad) decipher.setAAD(Buffer.from(String(envelope.aad), "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function encryptJsonEnvelope(plainText, secret, aad = "raizpass-server-key") {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(secret, salt, 32, SCRYPT_PARAMS);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return { alg: "AES-256-GCM", kdf: "scrypt", scrypt: SCRYPT_PARAMS, aad, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function loadServerPrivateKeyPem() {
  if (process.env.ECDSA_PRIVATE_KEY_ENC_JSON) {
    if (!SERVER_KEY_SECRET) throw new Error("Define SERVER_KEY_SECRET o SERVER_KEY_PASSPHRASE para descifrar ECDSA_PRIVATE_KEY_ENC_JSON.");
    return decryptJsonEnvelope(JSON.parse(process.env.ECDSA_PRIVATE_KEY_ENC_JSON), SERVER_KEY_SECRET);
  }
  if (process.env.ECDSA_PRIVATE_KEY_FILE) return readFileSync(process.env.ECDSA_PRIVATE_KEY_FILE, "utf8");
  if (process.env.ECDSA_PRIVATE_KEY_PEM) return process.env.ECDSA_PRIVATE_KEY_PEM.replace(/\\n/g, "\n");
  return null;
}

function getServerKeys() {
  if (cachedServerKeys) return cachedServerKeys;
  const privateKeyPem = loadServerPrivateKeyPem();
  const publicKeyPem = process.env.ECDSA_PUBLIC_KEY_PEM?.replace(/\\n/g, "\n") || (process.env.ECDSA_PUBLIC_KEY_FILE ? readFileSync(process.env.ECDSA_PUBLIC_KEY_FILE, "utf8") : null);
  if (privateKeyPem) {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const publicKey = publicKeyPem ? crypto.createPublicKey(publicKeyPem) : crypto.createPublicKey(privateKey);
    cachedServerKeys = { publicKey, privateKey };
  } else {
    cachedServerKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  }
  delete process.env.ECDSA_PRIVATE_KEY_PEM;
  delete process.env.ECDSA_PRIVATE_KEY_ENC_JSON;
  return cachedServerKeys;
}

function exportServerPublicKeyPem() {
  return getServerKeys().publicKey.export({ type: "spki", format: "pem" });
}

function exportServerPrivateKeyPemForLocalFallback() {
  return getServerKeys().privateKey.export({ type: "pkcs8", format: "pem" });
}

function validatePasswordPolicy(password) {
  const value = String(password || "");
  return value.length >= 8 && /[A-ZÁÉÍÓÚÑ]/.test(value) && /\d/.test(value) && /[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9]/.test(value);
}

async function ensurePostgres() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value JSONB NOT NULL);
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      organization_name TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      verified BOOLEAN NOT NULL DEFAULT FALSE,
      public_key_pem TEXT,
      encrypted_private_key JSONB,
      public_key_history JSONB NOT NULL DEFAULT '[]'::jsonb,
      verification_token TEXT,
      reset_token TEXT,
      reset_expires BIGINT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      date DATE NOT NULL,
      time TEXT NOT NULL,
      venue TEXT NOT NULL,
      organizer TEXT NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      currency TEXT NOT NULL DEFAULT 'MXN',
      price_mxn NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
      organization_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      buyer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'valid',
      public_code TEXT UNIQUE NOT NULL,
      visible_code TEXT UNIQUE NOT NULL,
      public_claims JSONB NOT NULL,
      encrypted_holder JSONB NOT NULL,
      crypto JSONB NOT NULL,
      purchase_price NUMERIC(12,2),
      currency TEXT NOT NULL DEFAULT 'MXN',
      transfer JSONB,
      transfer_history JSONB NOT NULL DEFAULT '[]'::jsonb,
      access_log JSONB NOT NULL DEFAULT '[]'::jsonb,
      holder_signature JSONB,
      seat JSONB,
      hidden_for JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS deleted_ticket_counters (
      event_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS seat JSONB;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS public_key_history JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);
}

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
const PgSession = connectPgSimple(session);
app.use(
  session({
    store: pool ? new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }) : undefined,
    secret: process.env.SESSION_SECRET || "change-this-session-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8,
    },
  }),
);
app.use(express.static(path.join(__dirname, "public")));

async function ensureStorage() {
  if (pool) {
    await ensurePostgres();
    const existing = await readDb();
    if (!existing.users.length) {
      const { publicKey, privateKey } = getServerKeys();
      await writeDb({
        users: await seedOrganizations(),
        tickets: [],
        deletedTicketCounters: {},
        events: seedEvents(),
        keys: {
          aesKey: getAesKey().toString("base64"),
          publicKeyPem: exportServerPublicKeyPem(),
          privateKeyPem: exportServerPrivateKeyPemForLocalFallback(),
        },
        meta: { createdAt: new Date().toISOString(), seedVersion: 5 },
      });
    }
    return;
  }
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(TICKETS_DIR, { recursive: true });
  await fs.mkdir(EMAIL_DIR, { recursive: true });
  try {
    const db = await readDb();
    await writeDb(migrateDb(db));
  } catch {
    const { publicKey, privateKey } = getServerKeys();
    const orgs = await seedOrganizations();
    const db = {
      users: orgs,
      tickets: [],
      deletedTicketCounters: {},
      events: seedEventsV2(),
      keys: {
        aesKey: getAesKey().toString("base64"),
        publicKeyPem: exportServerPublicKeyPem(),
        privateKeyPem: exportServerPrivateKeyPemForLocalFallback(),
      },
      meta: { createdAt: new Date().toISOString(), seedVersion: 5 },
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
  db.meta ||= {};
  // En PostgreSQL no se deben reescribir los eventos en cada arranque.
  // La version anterior guardaba la metadata como meta.state.seedVersion y el migrador
  // buscaba meta.seedVersion, por lo que reiniciaba los eventos semilla en cada loadDb().
  // Eso provocaba que los eventos creados no aparecieran y que las eliminaciones no persistieran.
  if (!db.events.length) {
    db.events = seedEventsV2();
  }
  db.events = db.events.map((event) => {
    const normalized = normalizePrice(event.price, event.currency);
    return {
      ...event,
      organizer: event.organizer || organizationName(db, event.organizationId),
      price: normalized.amount,
      currency: normalized.currency,
      priceMxn: event.priceMxn ?? normalized.mxn,
      status: event.status || "active",
      createdAt: event.createdAt || new Date().toISOString(),
    };
  });
  db.meta.seedVersion = Math.max(Number(db.meta.seedVersion || 0), 5);
  db.users = db.users.map((user) => ({
    ...user,
    publicKeyHistory: user.publicKeyHistory || (user.publicKeyPem ? [{ keyId: user.currentKeyId || sha256(user.publicKeyPem).slice(0, 12), publicKeyPem: user.publicKeyPem, createdAt: user.createdAt || new Date().toISOString(), reason: "legacy_import", status: "active", fingerprint: sha256(user.publicKeyPem).slice(0, 24) }] : []),
  }));
  db.tickets = db.tickets.map((ticket) => ({
    ...ticket,
    eventId: ticket.eventId || db.events.find((event) => event.name === ticket.publicClaims?.eventName)?.id || db.events[0]?.id,
    organizationId: ticket.organizationId || db.events.find((event) => event.id === ticket.eventId)?.organizationId || DEMO_ORGS[0].id,
    purchasePrice: normalizePrice(ticket.purchasePrice || ticket.publicClaims?.price || db.events.find((event) => event.id === ticket.eventId)?.price, ticket.currency || ticket.publicClaims?.currency).amount,
    currency: ticket.currency || ticket.publicClaims?.currency || "MXN",
    publicClaims: {
      ...ticket.publicClaims,
      price: normalizePrice(ticket.publicClaims?.price || ticket.purchasePrice || db.events.find((event) => event.id === ticket.eventId)?.price, ticket.currency || ticket.publicClaims?.currency).amount,
      currency: ticket.currency || ticket.publicClaims?.currency || "MXN",
      seat: ticket.publicClaims?.seat || ticket.seat || null,
    },
    seat: ticket.seat || ticket.publicClaims?.seat || null,
    hiddenFor: ticket.hiddenFor || [],
    holderSignature: ticket.holderSignature?.signature && !ticket.holderSignature.publicKeyPem
      ? { ...ticket.holderSignature, publicKeyPem: db.users.find((user) => user.id === ticket.holderSignature.signerUserId)?.publicKeyPem || ticket.holderSignature.publicKeyPem }
      : ticket.holderSignature,
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
      name: "Foro de Innovación Digital",
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

function normalizePrice(rawAmount, currency = "MXN") {
  const selectedCurrency = CURRENCIES[currency] ? currency : "MXN";
  const value = Number(rawAmount);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("El precio del boleto debe ser un número mayor a cero.");
  }
  const amount = Math.round(value);
  return { amount, currency: selectedCurrency, mxn: Math.round(amount * CURRENCIES[selectedCurrency].rateToMxn) };
}

function seedEventsV2() {
  const now = () => new Date().toISOString();
  return [
    { id: "evt-crypto", organizationId: "admin", name: "Expo Cripto: Acceso Seguro", date: "2026-06-04", time: "11:00", venue: "ESCOM IPN - Auditorio Principal", organizer: "ExpoESCOM", price: 80, currency: "MXN", createdAt: now() },
    { id: "evt-taller-aes", organizationId: "admin", name: "Taller AES para Boletos Privados", date: "2026-07-03", time: "12:00", venue: "ESCOM IPN - Laboratorio 4", organizer: "ExpoESCOM", price: 65, currency: "MXN", createdAt: now() },
    { id: "evt-expo-firmas", organizationId: "admin", name: "Laboratorio de Firmas ECDSA", date: "2026-08-14", time: "13:00", venue: "ESCOM IPN - Aula Magna", organizer: "ExpoESCOM", price: 95, currency: "MXN", createdAt: now() },
    { id: "evt-lumina-synth", organizationId: "org-lumina", name: "Lumina Live: Noche de Synth Pop", date: "2026-06-12", time: "20:30", venue: "Pepsi Center Demo", organizer: "Lumina Eventos", price: 1250, currency: "MXN", createdAt: now() },
    { id: "evt-lumina-arena", organizationId: "org-lumina", name: "Festival Lumina Arena", date: "2026-07-18", time: "19:00", venue: "Arena Ciudad de Mexico Demo", organizer: "Lumina Eventos", price: 5200, currency: "MXN", createdAt: now() },
    { id: "evt-lumina-acustico", organizationId: "org-lumina", name: "Lumina Acustico VIP", date: "2026-08-21", time: "21:00", venue: "Teatro Metropolitano Demo", organizer: "Lumina Eventos", price: 14800, currency: "MXN", createdAt: now() },
    { id: "evt-zenit-cinema", organizationId: "org-zenit", name: "Zenit Cinema: Ciclo de Autor", date: "2026-06-20", time: "18:00", venue: "Cineteca Nacional Demo", organizer: "Zenit Producciones", price: 450, currency: "MXN", createdAt: now() },
    { id: "evt-zenit-arte", organizationId: "org-zenit", name: "Zenit Arte: Exposicion Inmersiva", date: "2026-08-02", time: "17:30", venue: "Museo Digital Demo", organizer: "Zenit Producciones", price: 980, currency: "MXN", createdAt: now() },
    { id: "evt-zenit-corto", organizationId: "org-zenit", name: "Festival Zenit de Cortometraje", date: "2026-09-04", time: "18:00", venue: "Foro de Arte Contemporaneo Demo", organizer: "Zenit Producciones", price: 1750, currency: "MXN", createdAt: now() },
  ];
}

function organizationName(db, organizationId) {
  const org = db.users.find((user) => user.id === organizationId);
  return org?.organizationName || org?.name || "Organizacion";
}

async function readDb() {
  if (pool) return readPostgresDb();
  return JSON.parse(await fs.readFile(DB_PATH, "utf8"));
}

async function writeDb(db) {
  if (pool) return writePostgresDb(db);
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

async function readPostgresDb() {
  const [users, events, tickets, counters, meta] = await Promise.all([
    pool.query("SELECT * FROM users ORDER BY created_at"),
    pool.query("SELECT * FROM events WHERE status <> 'deleted' ORDER BY date, time"),
    pool.query("SELECT * FROM tickets ORDER BY created_at"),
    pool.query("SELECT * FROM deleted_ticket_counters"),
    pool.query("SELECT key, value FROM app_meta"),
  ]);
  return {
    users: users.rows.map((row) => ({
      id: row.id,
      role: row.role,
      name: row.name,
      organizationName: row.organization_name,
      email: row.email,
      passwordHash: row.password_hash,
      verified: row.verified,
      publicKeyPem: row.public_key_pem,
      encryptedPrivateKey: row.encrypted_private_key,
      publicKeyHistory: row.public_key_history || [],
      verificationToken: row.verification_token,
      resetToken: row.reset_token,
      resetExpires: row.reset_expires ? Number(row.reset_expires) : undefined,
      createdAt: row.created_at?.toISOString?.() || row.created_at,
    })),
    events: events.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      date: row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10),
      time: row.time,
      venue: row.venue,
      organizer: row.organizer,
      price: Number(row.price),
      currency: row.currency,
      priceMxn: Number(row.price_mxn),
      status: row.status,
      createdAt: row.created_at?.toISOString?.() || row.created_at,
    })),
    tickets: tickets.rows.map((row) => ({
      id: row.id,
      eventId: row.event_id,
      organizationId: row.organization_id,
      ownerId: row.owner_id,
      buyerId: row.buyer_id,
      status: row.status,
      publicCode: row.public_code,
      visibleCode: row.visible_code,
      publicClaims: row.public_claims,
      encryptedHolder: row.encrypted_holder,
      crypto: row.crypto,
      purchasePrice: Number(row.purchase_price),
      currency: row.currency,
      transfer: row.transfer,
      transferHistory: row.transfer_history || [],
      accessLog: row.access_log || [],
      holderSignature: row.holder_signature,
      seat: row.seat || row.public_claims?.seat || null,
      hiddenFor: row.hidden_for || [],
      createdAt: row.created_at?.toISOString?.() || row.created_at,
      usedAt: row.used_at?.toISOString?.() || row.used_at,
    })),
    deletedTicketCounters: Object.fromEntries(counters.rows.map((row) => [row.event_id, row.count])),
    keys: {
      aesKey: getMasterKey().toString("base64"),
      publicKeyPem: exportServerPublicKeyPem(),
      privateKeyPem: exportServerPrivateKeyPemForLocalFallback(),
    },
    meta: meta.rows.find((row) => row.key === "state")?.value || Object.fromEntries(meta.rows.map((row) => [row.key, row.value])),
  };
}

async function writePostgresDb(db) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const user of db.users || []) {
      await client.query(
        `INSERT INTO users (id, role, name, organization_name, email, password_hash, verified, public_key_pem, encrypted_private_key, public_key_history, verification_token, reset_token, reset_expires, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET role=$2,name=$3,organization_name=$4,email=$5,password_hash=$6,verified=$7,public_key_pem=$8,encrypted_private_key=$9,public_key_history=$10,verification_token=$11,reset_token=$12,reset_expires=$13`,
        [user.id, user.role, user.name, user.organizationName, user.email, user.passwordHash, Boolean(user.verified), user.publicKeyPem, JSON.stringify(user.encryptedPrivateKey || null), JSON.stringify(user.publicKeyHistory || []), user.verificationToken, user.resetToken, user.resetExpires || null, user.createdAt || new Date().toISOString()],
      );
    }
    for (const event of db.events || []) {
      const price = normalizePrice(event.price, event.currency || "MXN");
      await client.query(
        `INSERT INTO events (id, organization_id, name, date, time, venue, organizer, price, currency, price_mxn, status, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (id) DO UPDATE SET organization_id=$2,name=$3,date=$4,time=$5,venue=$6,organizer=$7,price=$8,currency=$9,price_mxn=$10,status=$11`,
        [event.id, event.organizationId, event.name, event.date, event.time, event.venue, event.organizer, price.amount, price.currency, price.mxn, event.status || "active", event.createdAt || new Date().toISOString()],
      );
    }
    for (const ticket of db.tickets || []) {
      await client.query(
        `INSERT INTO tickets (id,event_id,organization_id,owner_id,buyer_id,status,public_code,visible_code,public_claims,encrypted_holder,crypto,purchase_price,currency,transfer,transfer_history,access_log,holder_signature,seat,hidden_for,created_at,used_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         ON CONFLICT (id) DO UPDATE SET event_id=$2,organization_id=$3,owner_id=$4,buyer_id=$5,status=$6,public_code=$7,visible_code=$8,public_claims=$9,encrypted_holder=$10,crypto=$11,purchase_price=$12,currency=$13,transfer=$14,transfer_history=$15,access_log=$16,holder_signature=$17,seat=$18,hidden_for=$19,used_at=$21`,
        [ticket.id, ticket.eventId, ticket.organizationId, ticket.ownerId, ticket.buyerId, ticket.status, ticket.publicCode, ticket.visibleCode || makeVisibleCode(ticket.id, ticket.createdAt), JSON.stringify(ticket.publicClaims), JSON.stringify(ticket.encryptedHolder), JSON.stringify(ticket.crypto), ticket.purchasePrice || ticket.publicClaims?.price, ticket.currency || ticket.publicClaims?.currency || "MXN", JSON.stringify(ticket.transfer || null), JSON.stringify(ticket.transferHistory || []), JSON.stringify(ticket.accessLog || []), JSON.stringify(ticket.holderSignature || null), JSON.stringify(ticket.seat || ticket.publicClaims?.seat || null), JSON.stringify(ticket.hiddenFor || []), ticket.createdAt || new Date().toISOString(), ticket.usedAt || null],
      );
    }
    for (const [eventId, count] of Object.entries(db.deletedTicketCounters || {})) {
      await client.query("INSERT INTO deleted_ticket_counters (event_id, count) VALUES ($1,$2) ON CONFLICT (event_id) DO UPDATE SET count=$2", [eventId, count]);
    }
    await client.query("INSERT INTO app_meta (key,value) VALUES ('state',$1) ON CONFLICT (key) DO UPDATE SET value=$1", [JSON.stringify(db.meta || {})]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
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
  if (!req.session.userId) return res.status(401).json({ error: "Inicia sesión para continuar." });
  next();
}

function requireOrganization(req, res, next) {
  if (req.session.role !== "organization") return res.status(403).json({ error: "Permisos insuficientes." });
  next();
}

function requireUser(req, res, next) {
  if (req.session.role !== "user") return res.status(403).json({ error: "Esta acción es para usuarios compradores." });
  next();
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim());
}

function canonical(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value, encoding = "hex") {
  return crypto.createHash("sha256").update(value).digest(encoding);
}

function makeVisibleCode(ticketId, timestamp = new Date().toISOString()) {
  return sha256(`${ticketId}||${timestamp}`).slice(0, 16).toUpperCase();
}

function normalizeZone(value) {
  const text = String(value || "").trim().toLowerCase();
  return Object.keys(ZONE_SECTIONS).find((zone) => zone.toLowerCase() === text);
}

function normalizeSection(zone, value) {
  const section = String(value || "").trim();
  return ZONE_SECTIONS[zone]?.find((item) => item.toLowerCase() === section.toLowerCase());
}

function sectionUsedSeats(db, eventId, zone, section) {
  return new Set((db.tickets || [])
    .filter((ticket) => ticket.eventId === eventId)
    .filter((ticket) => !["cancelled", "tampered"].includes(ticket.status))
    .filter((ticket) => ticket.seat?.zone === zone && ticket.seat?.section === section)
    .map((ticket) => Number(ticket.seat?.seatNumber))
    .filter((seatNumber) => Number.isInteger(seatNumber) && seatNumber >= 1));
}

function randomAvailableSeat(db, eventId, zone, section) {
  const used = sectionUsedSeats(db, eventId, zone, section);
  if (used.size >= SEAT_CAPACITY_PER_SECTION) return null;
  let seatNumber;
  do {
    seatNumber = Math.floor(Math.random() * SEAT_CAPACITY_PER_SECTION) + 1;
  } while (used.has(seatNumber));
  return seatNumber;
}

function eventSeatAvailability(db, eventId) {
  return Object.entries(ZONE_SECTIONS).map(([zone, sections]) => {
    const sectionItems = sections.map((section) => {
      const used = sectionUsedSeats(db, eventId, zone, section).size;
      return { section, used, capacity: SEAT_CAPACITY_PER_SECTION, remaining: Math.max(SEAT_CAPACITY_PER_SECTION - used, 0), full: used >= SEAT_CAPACITY_PER_SECTION };
    });
    return { zone, sections: sectionItems, full: sectionItems.every((item) => item.full) };
  });
}

function seatLabel(seat) {
  if (!seat) return "Sin lugar asignado";
  return `${seat.zone} · Sección ${seat.section} · Lugar ${seat.seatNumber}`;
}

function maskEmailForPdf(email) {
  const text = String(email || "").trim();
  const [local, domain] = text.split("@");
  if (!local || !domain) return text ? `${text.slice(0, 2)}****` : "";
  const prefix = local.slice(0, 2);
  return `${prefix}${"*".repeat(Math.max(local.length - 2, 4))}@${domain}`;
}

function ensureTicketRuntimeFields(ticket) {
  if (!ticket) return ticket;
  if (!ticket.publicCode) ticket.publicCode = nanoid(22);
  if (!ticket.visibleCode) ticket.visibleCode = makeVisibleCode(ticket.id, ticket.publicClaims?.issuedAt || ticket.createdAt);
  ticket.qrUrl = `${BASE_URL}/ticket/${ticket.publicCode}`;
  ticket.pdfUrl = `/api/tickets/${ticket.publicCode}/pdf`;
  return ticket;
}

function ticketFilename(ticket) {
  return `${ticket.publicClaims?.ticketCode || ticket.id || ticket.publicCode}.pdf`;
}

function findTicketByCode(db, code) {
  const value = String(code || "").trim();
  const ticket = db.tickets.find((item) => item.publicCode === value || item.id === value || item.visibleCode === value.toUpperCase());
  return ensureTicketRuntimeFields(ticket);
}

function wrapDataKey(masterKey, dataKey, aad) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return { alg: "AES-256-GCM", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
}

function unwrapDataKey(masterKey, wrapped, aad) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, Buffer.from(wrapped.iv, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(wrapped.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(wrapped.ciphertext, "base64")), decipher.final()]);
}

function encryptSensitive(db, payload, context = {}) {
  const masterKey = Buffer.from(db.keys.aesKey, "base64");
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const aad = canonical({ purpose: "ticket-holder", ticketId: context.ticketId || payload.ticketId || null, eventId: context.eventId || null, version: 2 });
  const cipher = crypto.createCipheriv("aes-256-gcm", dataKey, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    version: 2,
    alg: "AES-256-GCM",
    mode: "GCM",
    keyManagement: "envelope-aes-256-gcm",
    aad,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    wrappedDataKey: wrapDataKey(masterKey, dataKey, aad),
  };
}

function encryptUserPrivateKey(privateKeyPem, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS);
  const aad = "raizpass-user-private-key-v2";
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(privateKeyPem, "utf8"), cipher.final()]);
  return {
    version: 2,
    alg: "AES-256-GCM",
    mode: "GCM",
    kdf: "scrypt",
    scrypt: SCRYPT_PARAMS,
    aad,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decryptUserPrivateKey(encrypted, password) {
  try {
    if (!encrypted?.salt || !encrypted?.iv || !encrypted?.tag || !encrypted?.ciphertext) {
      const err = new Error("La llave privada del usuario no tiene un formato válido.");
      err.code = "USER_KEY_INVALID";
      throw err;
    }
    const salt = Buffer.from(encrypted.salt, "base64");
    const opts = encrypted.scrypt || SCRYPT_PARAMS;
    const key = crypto.scryptSync(password, salt, 32, { ...SCRYPT_PARAMS, ...opts });
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
    if (encrypted.aad) decipher.setAAD(Buffer.from(String(encrypted.aad), "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (!error.code) error.code = "USER_KEY_DECRYPT_FAILED";
    throw error;
  }
}

function generateUserKeyPairForPassword(password, reason = "registration") {
  const userKeys = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = userKeys.publicKey.export({ type: "spki", format: "pem" });
  const privateKeyPem = userKeys.privateKey.export({ type: "pkcs8", format: "pem" });
  const keyId = nanoid(10);
  return { publicKeyPem, encryptedPrivateKey: encryptUserPrivateKey(privateKeyPem, password), privateKeyPem, keyId, keyRecord: { keyId, publicKeyPem, createdAt: new Date().toISOString(), reason, status: "active", fingerprint: sha256(publicKeyPem).slice(0, 24) } };
}

function installUserKeyPair(user, keys) {
  user.publicKeyPem = keys.publicKeyPem;
  user.encryptedPrivateKey = keys.encryptedPrivateKey;
  user.currentKeyId = keys.keyId;
  user.publicKeyHistory = [...(user.publicKeyHistory || []), keys.keyRecord];
}

function ensureUserPrivateKeyForPassword(user, password) {
  if (!user) throw new Error("Usuario no encontrado.");
  if (!user.encryptedPrivateKey || !user.publicKeyPem) {
    const keys = generateUserKeyPairForPassword(password, "legacy_missing_key");
    installUserKeyPair(user, keys);
    return { privateKeyPem: keys.privateKeyPem, rotated: true, keyId: keys.keyId };
  }
  return { privateKeyPem: decryptUserPrivateKey(user.encryptedPrivateKey, password), rotated: false, keyId: user.currentKeyId || user.publicKeyHistory?.at(-1)?.keyId || sha256(user.publicKeyPem).slice(0, 12) };
}

function decryptSensitive(db, encrypted) {
  if (encrypted?.version === 2 && encrypted.wrappedDataKey) {
    const masterKey = Buffer.from(db.keys.aesKey, "base64");
    const aad = encrypted.aad || "";
    const dataKey = unwrapDataKey(masterKey, encrypted.wrappedDataKey, aad);
    const decipher = crypto.createDecipheriv("aes-256-gcm", dataKey, Buffer.from(encrypted.iv, "base64"));
    if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  }
  const key = Buffer.from(db.keys.aesKey, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function signedTicketMessage(publicClaims, encryptedHolder) {
  return canonical({ publicClaims, encryptedHolder });
}

function signTicket(db, publicClaims, encryptedHolder) {
  const message = signedTicketMessage(publicClaims, encryptedHolder);
  const digest = sha256(message);
  const signer = crypto.createSign("SHA256");
  signer.update(message);
  signer.end();
  return {
    hash: digest,
    signature: signer.sign(db.keys.privateKeyPem, "base64"),
    publicKeyFingerprint: sha256(db.keys.publicKeyPem).slice(0, 24),
    signatureAlg: "ECDSA-P256-SHA256",
    hashAlg: "SHA-256",
    canonicalization: "JCS-like-stable-json",
    signedBytes: "canonical(publicClaims, encryptedHolder)",
  };
}

function holderSignaturePayload(ticket) {
  return canonical({
    ticketId: ticket.id,
    publicCode: ticket.publicCode,
    visibleCode: ticket.visibleCode,
    ownerId: ticket.ownerId,
    eventId: ticket.eventId,
    seat: ticket.seat || null,
    issuedAt: ticket.publicClaims.issuedAt,
    holderPublicKeyFingerprint: ticket.holderSignature?.publicKeyFingerprint || null,
    signerKeyId: ticket.holderSignature?.signerKeyId || null,
  });
}

function legacyHolderSignaturePayload(ticket) {
  return canonical({
    ticketId: ticket.id,
    publicCode: ticket.publicCode,
    visibleCode: ticket.visibleCode,
    ownerId: ticket.ownerId,
    eventId: ticket.eventId,
    seat: ticket.seat || null,
    issuedAt: ticket.publicClaims.issuedAt,
  });
}

function signTicketWithUser(ticket, user, password) {
  const { privateKeyPem, rotated, keyId } = ensureUserPrivateKeyForPassword(user, password);
  const publicKeyFingerprint = sha256(user.publicKeyPem || "").slice(0, 24);
  const signedAt = new Date().toISOString();
  ticket.holderSignature = {
    alg: "ECDSA-P256-SHA256",
    signerUserId: user.id,
    signerEmail: user.email,
    signerKeyId: keyId,
    signedAt,
    publicKeyPem: user.publicKeyPem,
    publicKeyFingerprint,
    keyRotated: rotated,
  };
  const payload = holderSignaturePayload(ticket);
  const signer = crypto.createSign("SHA256");
  signer.update(payload);
  signer.end();
  ticket.holderSignature.payloadHash = sha256(payload);
  ticket.holderSignature.signature = signer.sign(privateKeyPem, "base64");
  ticket.transferHistory = [...(ticket.transferHistory || []), { action: rotated ? "holder_key_created_and_signed" : "holder_signed", byUserId: user.id, byEmail: user.email, signerKeyId: keyId, at: signedAt }];
}

function verifyHolderSignature(db, ticket) {
  if (!ticket.holderSignature?.signature) return { present: false, valid: false, reason: "Boleto sin firma de titular." };
  const publicKeyPem = ticket.holderSignature.publicKeyPem || db.users.find((user) => user.id === ticket.holderSignature.signerUserId)?.publicKeyPem;
  if (!publicKeyPem) return { present: true, valid: false, reason: "No se encontró la llave pública del titular." };
  const payload = holderSignaturePayload(ticket);
  const legacyPayload = legacyHolderSignaturePayload(ticket);
  const verifyPayload = (candidate) => {
    const verifier = crypto.createVerify("SHA256");
    verifier.update(candidate);
    verifier.end();
    return verifier.verify(publicKeyPem, ticket.holderSignature.signature, "base64");
  };
  const currentHashMatches = !ticket.holderSignature.payloadHash || ticket.holderSignature.payloadHash === sha256(payload);
  const currentSignatureValid = verifyPayload(payload);
  const legacyHashMatches = Boolean(ticket.holderSignature.payloadHash && ticket.holderSignature.payloadHash === sha256(legacyPayload));
  const legacySignatureValid = !currentSignatureValid && verifyPayload(legacyPayload);
  const valid = (currentHashMatches && currentSignatureValid) || (legacyHashMatches && legacySignatureValid);
  return { present: true, valid: Boolean(valid), hashMatches: currentHashMatches || legacyHashMatches, signatureValid: currentSignatureValid || legacySignatureValid, legacyFormat: Boolean(legacySignatureValid), publicKeyFingerprint: sha256(publicKeyPem).slice(0, 24), signerKeyId: ticket.holderSignature.signerKeyId || null };
}

function verifyTicket(db, ticket) {
  const message = signedTicketMessage(ticket.publicClaims, ticket.encryptedHolder);
  const recalculatedHash = sha256(message);
  const verifyServerPayload = (payload) => {
    const verifier = crypto.createVerify("SHA256");
    verifier.update(payload);
    verifier.end();
    return verifier.verify(db.keys.publicKeyPem, ticket.crypto.signature, "base64");
  };
  const signatureValid = verifyServerPayload(message);
  const legacyDoubleHashSignature = !signatureValid && verifyServerPayload(recalculatedHash);
  const holder = verifyHolderSignature(db, ticket);
  return {
    hashMatches: recalculatedHash === ticket.crypto.hash,
    signatureValid: signatureValid || legacyDoubleHashSignature,
    legacyDoubleHashSignature,
    holderSignature: holder,
    authentic: recalculatedHash === ticket.crypto.hash && (signatureValid || legacyDoubleHashSignature) && (!holder.present || holder.valid),
    recalculatedHash,
  };
}

function effectiveStatus(ticket, events = []) {
  if (ticket.status === "cancelled") return "cancelled";
  if (ticket.status === "used" || ticket.status === "tampered") return ticket.status;
  const event = events.find((item) => item.id === ticket.eventId);
  const dateText = event?.date || ticket.publicClaims?.eventDate;
  if (dateText) {
    const eventEnd = new Date(`${dateText}T23:59:59`).getTime();
    if (Number.isFinite(eventEnd) && eventEnd < Date.now()) return "expired";
  }
  return ticket.status || "valid";
}

async function createTicketPdf(ticket) {
  ensureTicketRuntimeFields(ticket);
  return ticket.pdfUrl;
}

async function ticketPdfBuffer(ticket, qrDataUrl) {
  ensureTicketRuntimeFields(ticket);
  if (!qrDataUrl) qrDataUrl = await QRCode.toDataURL(ticket.qrUrl, { margin: 1, width: 340, color: { dark: "#4C4842", light: "#FFFFFF" } });
  const qrImage = qrDataUrl.replace(/^data:image\/png;base64,/, "");
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.rect(0, 0, 595, 842).fill("#ffffff");
    doc.rect(0, 0, 595, 142).fill("#4C4842");
    const logoPath = path.join(__dirname, "public", "LogoEVRaizPass.png");
    try {
      // Logo cuadrado, sin fondo artificial y sin recorte. Se coloca en el cuerpo blanco
      // del PDF para conservar contraste sin usar la caja beige anterior.
      doc.image(logoPath, 462, 156, { fit: [78, 78], align: "center", valign: "center" });
    } catch (error) {
      doc.fillColor("#4C4842").fontSize(10).text("RaizPass", 474, 184);
    }
    doc.fillColor("#E3CC8C").fontSize(26).text("Pase verificado", 48, 54);
    doc.fillColor("#ffffff").fontSize(14).text(ticket.publicClaims.organizer, 48, 88);
    doc.fillColor("#4C4842").fontSize(20).text(ticket.publicClaims.eventName, 48, 172, { width: 390 });
    doc.fillColor("#4C4842").fontSize(12).text(`${ticket.publicClaims.eventDate} - ${ticket.publicClaims.eventTime}`, 48, 204);
    doc.text(ticket.publicClaims.venue, 48, 224);
    doc.fontSize(14).text(`Costo original: $${ticket.publicClaims.price} ${ticket.publicClaims.currency || ticket.currency || "MXN"}`, 48, 250);
    doc.text(`Codigo visible: ${ticket.visibleCode}`, 48, 270);
    if (ticket.seat) {
      doc.text(`Lugar: ${seatLabel(ticket.seat)}`, 48, 292);
    }
    doc.image(Buffer.from(qrImage, "base64"), 165, 320, { width: 240 });
    doc.fillColor("#4C4842").fontSize(12).text("Escanea para validar autenticidad sin revelar datos personales.", 92, 575, { align: "center", width: 410 });
    if (ticket.holderSignature) {
      doc.fillColor("#82B979").fontSize(14).text(`Ticket firmado: responsabilidad de ${maskEmailForPdf(ticket.holderSignature.signerEmail)}`, 48, 615);
    }
    doc.fillColor("#82B979").fontSize(9).text(`ID publico: ${ticket.publicClaims.ticketCode}`, 48, 730);
    doc.text(`Firma: ${ticket.crypto.signatureAlg} | Hash: ${ticket.crypto.hashAlg}`, 48, 746);
    doc.end();
  });
}

async function refreshTicketCrypto(db, ticket, owner, password) {
  ticket.publicCode = nanoid(22);
  ticket.visibleCode = makeVisibleCode(ticket.id, new Date().toISOString());
  ticket.encryptedHolder = encryptSensitive(db, {
    userId: owner.id,
    name: owner.name,
    email: owner.email,
    purchasedAt: ticket.createdAt,
    currentHolderSince: new Date().toISOString(),
  }, { ticketId: ticket.id, eventId: ticket.eventId });
  ticket.crypto = signTicket(db, ticket.publicClaims, ticket.encryptedHolder);
  signTicketWithUser(ticket, owner, password);
  ticket.qrUrl = `${BASE_URL}/ticket/${ticket.publicCode}`;
  ticket.qrDataUrl = await QRCode.toDataURL(ticket.qrUrl, { margin: 1, width: 340, color: { dark: "#4C4842", light: "#FFFFFF" } });
  ticket.pdfUrl = await createTicketPdf(ticket);
}

function emailAddressFrom(value, fallbackEmail) {
  const text = String(value || "").trim();
  const match = text.match(/<([^>]+)>/);
  if (match) return match[1];
  if (validateEmail(text)) return text;
  return fallbackEmail;
}

async function sendBrevoEmail(to, subject, html, actionText) {
  if (!process.env.BREVO_API_KEY) return false;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || emailAddressFrom(process.env.MAIL_FROM || process.env.SMTP_FROM, process.env.SMTP_USER || process.env.MAIL_USER);
  const senderName = process.env.BREVO_SENDER_NAME || "RaizPass";
  if (!senderEmail) throw new Error("BREVO_API_KEY está configurado, pero falta BREVO_SENDER_EMAIL o MAIL_FROM.");
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "api-key": process.env.BREVO_API_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ sender: { name: senderName, email: senderEmail }, to: [{ email: to }], subject, htmlContent: html }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Brevo rechazó el correo (${response.status}): ${text}`);
  }
  console.log(`[Correo enviado por Brevo] ${subject} -> ${to}`);
  return true;
}

async function sendAppEmail(to, subject, title, body, actionText, actionUrl) {
  const html = `<!doctype html>
  <html lang="es"><meta charset="utf-8"><body style="margin:0;background:#C1D7AE;font-family:Arial,sans-serif;color:#4C4842">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px">
  <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #82B979">
  <tr><td style="background:#4C4842;color:#FFFFFF;padding:24px 28px"><h1 style="margin:0;font-size:22px">${title}</h1><p style="margin:8px 0 0;color:#E3CC8C">RaizPass · Intermediario seguro de eventos</p></td></tr>
  <tr><td style="padding:28px"><p style="font-size:16px;line-height:1.55">${body}</p>
  <p style="margin:28px 0"><a href="${actionUrl}" style="background:#82B979;color:#1f241f;text-decoration:none;padding:13px 18px;border-radius:10px;font-weight:bold">${actionText}</a></p>
  <p style="font-size:12px;color:#6d685f;word-break:break-all">${actionUrl}</p>
  <p style="font-size:12px;color:#6d685f">Si no solicitaste este correo, puedes ignorarlo.</p></td></tr>
  </table></td></tr></table></body></html>`;

  if (await sendBrevoEmail(to, subject, html, actionText)) {
    return { sent: true, provider: "brevo" };
  }

  const smtpUser = process.env.SMTP_USER || process.env.MAIL_USER;
  const smtpPass = process.env.SMTP_PASS || process.env.MAIL_PASS;
  const smtpHost = process.env.SMTP_HOST || process.env.MAIL_HOST || (smtpUser?.includes("gmail.com") ? "smtp.gmail.com" : undefined);
  const smtpPort = Number(process.env.SMTP_PORT || process.env.MAIL_PORT || 587);
  const smtpSecure = String(process.env.SMTP_SECURE || process.env.MAIL_SECURE || "").toLowerCase() === "true" || smtpPort === 465;

  if (smtpHost && smtpUser && smtpPass) {
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.default.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: smtpPass },
      family: 4,
      requireTLS: !smtpSecure,
      tls: { servername: smtpHost },
      connectionTimeout: 20000,
      greetingTimeout: 20000,
      socketTimeout: 30000,
    });
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_FROM || `RaizPass <${smtpUser}>`,
      to,
      subject,
      html,
    });
    console.log(`[Correo enviado] ${subject} -> ${to}`);
    return { sent: true, previewPath: null };
  }

  if (process.env.NODE_ENV !== "production") {
    const safeName = `${Date.now()}-${to.replace(/[^a-z0-9]/gi, "_")}.html`;
    const filePath = path.join(EMAIL_DIR, safeName);
    await fs.mkdir(EMAIL_DIR, { recursive: true });
    await fs.writeFile(filePath, html, "utf8");
    console.log(`
[Correo desarrollo] ${subject} para ${to}
${actionUrl}
Vista: ${filePath}
`);
    return { sent: false, previewPath: filePath };
  }

  throw new Error("SMTP no configurado. Define SMTP_USER/SMTP_PASS o MAIL_USER/MAIL_PASS en Railway.");
}

async function trySendAppEmail(context, ...args) {
  try {
    await sendAppEmail(...args);
    return { ok: true };
  } catch (error) {
    console.error(`[SMTP ${context}]`, error);
    return { ok: false, error };
  }
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
    .filter((event) => event.status !== "deleted")
    .filter((event) => !user || user.role !== "organization" || event.organizationId === user.id)
    .filter((event) => new Date(`${event.date}T23:59:59`).getTime() >= Date.now())
    .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  res.json({ user: publicUser(user), events, organizations });
});

app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || String(name).trim().length < 3) return res.status(400).json({ error: "Escribe tu nombre completo." });
  if (!validateEmail(email)) return res.status(400).json({ error: "El correo no tiene un formato valido." });
  if (!validatePasswordPolicy(password)) return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });

  const db = await loadDb();
  const normalizedEmail = String(email).trim().toLowerCase();
  const existing = db.users.find((user) => user.email.toLowerCase() === normalizedEmail);
  if (existing) {
    if (existing.role === "user" && !existing.verified) {
      const previousToken = existing.verificationToken;
      existing.verificationToken = nanoid(36);
      const emailResult = await trySendAppEmail("registro existente", existing.email, "Verifica tu correo", "Verifica tu cuenta", "Confirma tu correo para comprar, transferir y validar boletos seguros.", "Verificar correo", `${BASE_URL}/verify-email?token=${existing.verificationToken}`);
      if (!emailResult.ok) {
        existing.verificationToken = previousToken;
        return res.status(502).json({ error: `No se pudo reenviar el correo de verificación: ${emailResult.error.message}` });
      }
      await writeDb(db);
      return res.json({ ok: true, message: "Ese correo ya estaba registrado sin verificar. Enviamos un nuevo enlace de confirmacion." });
    }
    return res.status(409).json({ error: "Ese correo ya esta registrado." });
  }

  const isDemoOrganization = normalizedEmail.endsWith("@expo.test");
  const token = nanoid(36);
  const userKeys = generateUserKeyPairForPassword(password, "registration");
  const user = {
    id: nanoid(12),
    role: isDemoOrganization ? "organization" : "user",
    name: String(name).trim(),
    organizationName: isDemoOrganization ? String(name).trim() : undefined,
    email: normalizedEmail,
    passwordHash: await bcrypt.hash(password, 10),
    publicKeyPem: userKeys.publicKeyPem,
    encryptedPrivateKey: userKeys.encryptedPrivateKey,
    currentKeyId: userKeys.keyId,
    publicKeyHistory: [userKeys.keyRecord],
    verified: isDemoOrganization,
    verificationToken: isDemoOrganization ? undefined : token,
    createdAt: new Date().toISOString(),
  };
  if (isDemoOrganization) {
    db.users.push(user);
    await writeDb(db);
    return res.json({ ok: true, message: "Organizacion demo creada y verificada automaticamente." });
  }

  const emailResult = await trySendAppEmail("registro", user.email, "Verifica tu correo", "Verifica tu cuenta", "Confirma tu correo para comprar, transferir y validar boletos seguros.", "Verificar correo", `${BASE_URL}/verify-email?token=${token}`);
  if (!emailResult.ok) {
    return res.status(502).json({ error: `No se creó la cuenta porque no se pudo enviar el correo de verificación: ${emailResult.error.message}` });
  }
  db.users.push(user);
  await writeDb(db);
  res.json({ ok: true, message: "Cuenta creada. Revisa tu correo para confirmar la cuenta." });
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
    const emailResult = await trySendAppEmail("recuperacion", user.email, "Restablece tu contrasena", "Restablecimiento seguro", "Recibimos una solicitud para cambiar tu contrasena. El enlace expira en 30 minutos.", "Cambiar contrasena", `${BASE_URL}/reset-password?token=${user.resetToken}`);
    if (!emailResult.ok) {
      delete user.resetToken;
      delete user.resetExpires;
      return res.status(502).json({ error: `No se pudo enviar el correo de recuperacion: ${emailResult.error.message}` });
    }
    await writeDb(db);
  }
  res.json({ ok: true, message: "Si el correo existe, recibirás un enlace de recuperación." });
});

app.get("/reset-password", (req, res) => res.sendFile(path.join(__dirname, "public", "reset.html")));

app.post("/api/auth/reset", async (req, res) => {
  const { token, password } = req.body;
  if (!validatePasswordPolicy(password)) return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
  const db = await loadDb();
  const user = db.users.find((item) => item.resetToken === token && item.resetExpires > Date.now());
  if (!user) return res.status(400).json({ error: "El enlace no es valido o ya expiro." });
  user.passwordHash = await bcrypt.hash(password, 10);
  const keys = generateUserKeyPairForPassword(password, "password_reset_new_crypto_identity");
  installUserKeyPair(user, keys);
  user.keyRotatedAt = new Date().toISOString();
  delete user.resetToken;
  delete user.resetExpires;
  await writeDb(db);
  res.json({ ok: true });
});

app.post("/api/events", requireAuth, requireOrganization, async (req, res) => {
  const db = await loadDb();
  const org = db.users.find((user) => user.id === req.session.userId);
  const { name, date, time, venue, organizer, price, currency } = req.body;
  if (!name || !date || !time || !venue) return res.status(400).json({ error: "Completa los datos del evento." });
  if (!price || Number(price) <= 0) return res.status(400).json({ error: "Ingresa un precio válido para el boleto." });
  const normalizedPrice = normalizePrice(price, currency || "MXN");
  const event = {
    id: nanoid(12),
    organizationId: org.id,
    name: String(name).trim(),
    date,
    time,
    venue: String(venue).trim(),
    organizer: String(organizer || org.organizationName || org.name).trim(),
    price: normalizedPrice.amount,
    currency: normalizedPrice.currency,
    priceMxn: normalizedPrice.mxn,
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
  for (const ticket of db.tickets.filter((item) => item.eventId === req.params.id)) {
    ticket.status = "cancelled";
    ticket.cancelledAt = new Date().toISOString();
    ticket.accessLog = [...(ticket.accessLog || []), { by: req.session.userId, at: ticket.cancelledAt, action: "evento_cancelado" }];
  }
  db.events[index].status = "deleted";
  db.events[index].deletedAt = new Date().toISOString();
  await writeDb(db);
  res.json({ ok: true });
});

app.get("/api/organization/stats", requireAuth, requireOrganization, async (req, res) => {
  const db = await loadDb();
  const events = db.events.filter((event) => event.organizationId === req.session.userId && event.status !== "deleted");
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

app.get("/api/events/:id/availability", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const event = db.events.find((item) => item.id === req.params.id && item.status !== "deleted");
  if (!event) return res.status(404).json({ error: "Evento no encontrado." });
  res.json({ eventId: event.id, capacityPerSection: SEAT_CAPACITY_PER_SECTION, zones: eventSeatAvailability(db, event.id) });
});

app.post("/api/tickets", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const user = db.users.find((item) => item.id === req.session.userId);
  const event = db.events.find((item) => item.id === req.body.eventId && item.status !== "deleted");
  if (!event) return res.status(404).json({ error: "Evento no encontrado." });
  const ownedForEvent = db.tickets.filter((ticket) => ticket.ownerId === user.id && ticket.eventId === event.id && !(ticket.hiddenFor || []).includes(user.id)).length;
  if (ownedForEvent >= MAX_TICKETS_PER_USER_EVENT) return res.status(400).json({ error: "Limite de 5 boletos por usuario para este evento." });
  if (!req.body.password || !(await bcrypt.compare(req.body.password, user.passwordHash))) {
    return res.status(401).json({ error: "Confirma tu contraseña para firmar el boleto con tu llave privada ECDSA." });
  }
  const zone = normalizeZone(req.body.zone);
  const section = normalizeSection(zone, req.body.section);
  if (!zone || !section) return res.status(400).json({ error: "Selecciona una zona y sección válidas." });
  const seatNumber = randomAvailableSeat(db, event.id, zone, section);
  if (!seatNumber) return res.status(409).json({ error: "Los boletos para esa sección están agotados." });
  const ticketId = nanoid(14);
  const issuedAt = new Date().toISOString();
  const visibleCode = makeVisibleCode(ticketId, issuedAt);
  const seat = { zone, section, seatNumber, capacity: SEAT_CAPACITY_PER_SECTION };
  const publicClaims = {
    ticketCode: ticketId,
    eventName: event.name,
    eventDate: event.date,
    eventTime: event.time,
    venue: event.venue,
    organizer: event.organizer,
    price: event.price,
    currency: event.currency || "MXN",
    issuedAt,
    seat,
  };
  const ticket = {
    id: ticketId,
    eventId: event.id,
    organizationId: event.organizationId,
    ownerId: user.id,
    buyerId: user.id,
    status: "valid",
    publicCode: nanoid(22),
    visibleCode,
    seat,
    purchasePrice: event.price,
    currency: event.currency || "MXN",
    publicClaims,
    encryptedHolder: encryptSensitive(db, {
      userId: user.id,
      name: user.name,
      email: user.email,
      purchasedAt: issuedAt,
      currentHolderSince: issuedAt,
    }, { ticketId, eventId: event.id }),
    accessLog: [],
    hiddenFor: [],
    createdAt: issuedAt,
    transferHistory: [],
  };
  ticket.crypto = signTicket(db, publicClaims, ticket.encryptedHolder);
  try {
    signTicketWithUser(ticket, user, req.body.password);
  } catch (error) {
    console.error("[Firma de boleto]", error);
    return res.status(400).json({ error: "No se pudo firmar el boleto con la llave ECDSA del usuario. Verifica la contraseña e intenta de nuevo." });
  }
  ticket.qrUrl = `${BASE_URL}/ticket/${ticket.publicCode}`;
  ticket.qrDataUrl = await QRCode.toDataURL(ticket.qrUrl, { margin: 1, width: 340, color: { dark: "#4C4842", light: "#FFFFFF" } });
  ticket.pdfUrl = await createTicketPdf(ticket);
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
    .filter((ticket) => ["pending", "gift"].includes(ticket.transfer?.status) && ticket.transfer.toUserId === req.session.userId)
    .map((ticket) => summarizeTicket(ticket, db, { incomingTransfer: true }));
  res.json({ tickets: owned, incomingTransfers });
});

app.get("/api/tickets/:code", async (req, res) => {
  const db = await loadDb();
  const ticket = findTicketByCode(db, req.params.code);
  if (!ticket) return res.status(404).json({ error: "Boleto no encontrado." });
  if (req.session?.role === "organization" && ticket.organizationId !== req.session.userId) {
    return res.status(403).json({ error: "Este boleto pertenece a otra organizacion." });
  }
  const verification = verifyTicket(db, ticket);
  const isOwnerOrganization = req.session?.role === "organization" && ticket.organizationId === req.session.userId;
  const payload = summarizeTicket(ticket, db, {
    verification,
    includeTrace: isOwnerOrganization,
  });
  if (isOwnerOrganization) {
    payload.holder = decryptSensitive(db, ticket.encryptedHolder);
  }
  res.json({ ticket: payload });
});

app.get("/api/tickets/:code/pdf", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const ticket = findTicketByCode(db, req.params.code);
  if (!ticket || ticket.ownerId !== req.session.userId) return res.status(404).send("Boleto no encontrado.");
  ensureTicketRuntimeFields(ticket);
  const buffer = await ticketPdfBuffer(ticket);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${ticketFilename(ticket)}"`);
  res.send(buffer);
});

app.post("/api/tickets/:code/sign", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const user = db.users.find((item) => item.id === req.session.userId);
  const ticket = findTicketByCode(db, req.params.code);
  if (!ticket || ticket.ownerId !== user.id) return res.status(404).json({ error: "Boleto no encontrado." });
  if (effectiveStatus(ticket, db.events) !== "valid") return res.status(400).json({ error: "Solo puedes firmar boletos validos." });
  if (ticket.holderSignature) return res.status(400).json({ error: "Este boleto ya fue firmado." });
  if (!req.body.password || !(await bcrypt.compare(req.body.password, user.passwordHash))) {
    return res.status(401).json({ error: "Contrasena incorrecta para usar tu llave privada." });
  }
  try {
    signTicketWithUser(ticket, user, req.body.password);
  } catch (error) {
    console.error("[Firma manual de boleto]", error);
    return res.status(400).json({ error: "No se pudo firmar el boleto con la llave ECDSA del usuario. Verifica la contraseña e intenta de nuevo." });
  }
  await writeDb(db);
  res.json({ ticket: summarizeTicket(ticket, db) });
});

app.get("/ticket/:code", (req, res) => res.sendFile(path.join(__dirname, "public", "ticket.html")));

app.post("/api/tickets/:code/delete", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const ticket = db.tickets.find((item) => (item.publicCode === req.params.code || item.id === req.params.code || item.visibleCode === String(req.params.code).toUpperCase()) && item.ownerId === req.session.userId);
  if (!ticket) return res.status(404).json({ error: "Boleto no encontrado." });
  if (ticket.transfer?.status === "pending") return res.status(409).json({ error: "No puedes eliminar un boleto con transferencia pendiente." });
  ticket.hiddenFor = [...new Set([...(ticket.hiddenFor || []), req.session.userId])];
  ticket.accessLog = [...(ticket.accessLog || []), { by: req.session.userId, at: new Date().toISOString(), action: "oculto_por_cliente" }];
  db.deletedTicketCounters ||= {};
  db.deletedTicketCounters[ticket.eventId] = (db.deletedTicketCounters[ticket.eventId] || 0) + 1;
  await writeDb(db);
  res.json({ ok: true });
});

app.post("/api/tickets/:code/transfer", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const ticket = db.tickets.find((item) => (item.publicCode === req.params.code || item.id === req.params.code || item.visibleCode === String(req.params.code).toUpperCase()) && item.ownerId === req.session.userId);
  if (!ticket) return res.status(404).json({ error: "Boleto no encontrado." });
  if (ticket.transfer?.status === "pending") return res.status(409).json({ error: "Este boleto ya tiene una transferencia pendiente." });
  if (effectiveStatus(ticket, db.events) !== "valid") return res.status(400).json({ error: "Solo puedes transferir boletos válidos." });
  if (!validateEmail(req.body.email)) return res.status(400).json({ error: "Correo destino inválido." });
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
  const emailResult = await trySendAppEmail("transferencia", recipient.email, "Te enviaron un boleto", "Transferencia de boleto", `Tienes 24 horas para aceptar el boleto de ${ticket.publicClaims.eventName}. Al aceptarlo se firmará con tu llave ECDSA de usuario.`, "Entrar y aceptar", BASE_URL);
  res.json({ ticket: summarizeTicket(ticket, db), emailWarning: emailResult.ok ? null : emailResult.error.message });
});

app.post("/api/transfers/:ticketId/accept", requireAuth, requireUser, async (req, res) => {
  const db = await loadDb();
  const ticket = db.tickets.find((item) => item.id === req.params.ticketId && item.transfer?.status === "pending" && item.transfer.toUserId === req.session.userId);
  const giftTicket = db.tickets.find((item) => item.id === req.params.ticketId && item.transfer?.status === "gift" && item.transfer.toUserId === req.session.userId);
  if (giftTicket) {
    delete giftTicket.transfer;
    await writeDb(db);
    return res.json({ ticket: summarizeTicket(giftTicket, db) });
  }
  if (!ticket) return res.status(404).json({ error: "Transferencia no encontrada." });
  if (ticket.transfer.expiresAt < Date.now()) {
    delete ticket.transfer;
    await writeDb(db);
    return res.status(410).json({ error: "La transferencia expiro." });
  }
  const recipient = db.users.find((user) => user.id === req.session.userId);
  if (!req.body.password || !(await bcrypt.compare(req.body.password, recipient.passwordHash))) {
    return res.status(401).json({ error: "Confirma tu contraseña para firmar el boleto transferido con tu llave privada." });
  }
  ticket.ownerId = recipient.id;
  ticket.transferHistory = [...(ticket.transferHistory || []), { ...ticket.transfer, acceptedAt: new Date().toISOString() }];
  delete ticket.transfer;
  try {
    await refreshTicketCrypto(db, ticket, recipient, req.body.password);
  } catch (error) {
    console.error("[Firma de transferencia]", error);
    return res.status(400).json({ error: "No se pudo firmar el boleto transferido con la llave ECDSA del usuario. Verifica la contraseña e intenta de nuevo." });
  }
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
  const ticket = findTicketByCode(db, req.params.code);
  if (!ticket) return res.status(404).json({ error: "Boleto no encontrado." });
  if (ticket.organizationId !== req.session.userId) return res.status(403).json({ error: "Este boleto pertenece a otra organizacion." });
  const verification = verifyTicket(db, ticket);
  if (!verification.authentic) return res.status(400).json({ error: "La firma o el hash no son validos." });
  if (effectiveStatus(ticket, db.events) !== "valid") return res.status(409).json({ error: `El boleto esta ${effectiveStatus(ticket, db.events)}.` });
  ticket.status = "used";
  ticket.usedAt = new Date().toISOString();
  ticket.accessLog.push({ by: req.session.userId, at: ticket.usedAt, action: "admitido" });
  await writeDb(db);
  const payload = summarizeTicket(ticket, db, { verification });
  payload.holder = decryptSensitive(db, ticket.encryptedHolder);
  payload.accessMode = ticket.holderSignature ? "signed_fast_access" : "identity_check";
  res.json({ ticket: payload });
});

app.get("/api/organization/access/:code", requireAuth, requireOrganization, async (req, res) => {
  const db = await loadDb();
  const ticket = findTicketByCode(db, req.params.code);
  if (!ticket) return res.status(404).json({ error: "Boleto no encontrado." });
  if (ticket.organizationId !== req.session.userId) return res.status(403).json({ error: "Este boleto pertenece a otra organizacion." });
  const verification = verifyTicket(db, ticket);
  const payload = summarizeTicket(ticket, db, { verification });
  payload.accessMode = ticket.holderSignature ? "signed_fast_access" : "identity_check";
  payload.holder = decryptSensitive(db, ticket.encryptedHolder);
  res.json({ ticket: payload });
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
  copy.pdfUrl = await createTicketPdf(copy);
  db.tickets.push(copy);
  await writeDb(db);
  res.json({ ticket: summarizeTicket(copy, db, { verification: verifyTicket(db, copy) }) });
});

function summarizeTicket(ticket, db, options = {}) {
  ensureTicketRuntimeFields(ticket);
  const status = effectiveStatus(ticket, db.events);
  const summary = {
    id: ticket.id,
    eventId: ticket.eventId,
    organizationId: ticket.organizationId,
    status: options.incomingTransfer ? "transfer_pending" : status,
    publicCode: ticket.publicCode,
    visibleCode: ticket.visibleCode,
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
    holderSignature: ticket.holderSignature || null,
    seat: ticket.seat || ticket.publicClaims?.seat || null,
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
    if (transfer.action === "holder_signed") {
      trace.push({
        type: "holder_signed",
        label: "Boleto firmado por titular",
        at: transfer.at,
        detail: `Firmante responsable: ${userName(transfer.byUserId, transfer.byEmail)}`,
      });
      continue;
    }
    trace.push({
      type: "transfer_requested",
      label: "Transferencia solicitada",
      at: new Date(transfer.createdAt).toISOString(),
      detail: `${userName(transfer.fromUserId, transfer.fromEmail)} -> ${userName(transfer.toUserId, transfer.toEmail)}`,
    });
    if (transfer.acceptedAt) {
      trace.push({
        type: "transfer_accepted",
        label: transfer.status === "gift" ? "Boleto firmado transferido" : "Transferencia aceptada",
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
