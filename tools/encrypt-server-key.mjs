import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const [privateKeyPath, passphrase] = process.argv.slice(2);
if (!privateKeyPath || !passphrase) {
  console.error("Uso: node tools/encrypt-server-key.mjs <private-key.pem> <SERVER_KEY_SECRET>");
  process.exit(1);
}
const SCRYPT_PARAMS = { N: Number(process.env.SCRYPT_N || 131072), r: Number(process.env.SCRYPT_R || 8), p: Number(process.env.SCRYPT_P || 1), maxmem: Number(process.env.SCRYPT_MAXMEM || 256 * 1024 * 1024) };
const aad = "raizpass-server-key";
const privateKeyPem = readFileSync(privateKeyPath, "utf8");
const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT_PARAMS);
const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
cipher.setAAD(Buffer.from(aad, "utf8"));
const ciphertext = Buffer.concat([cipher.update(privateKeyPem, "utf8"), cipher.final()]);
console.log(JSON.stringify({ alg: "AES-256-GCM", kdf: "scrypt", scrypt: SCRYPT_PARAMS, aad, salt: salt.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }));
