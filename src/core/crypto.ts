import crypto from "node:crypto";
import { config } from "../config.js";
import { log } from "./log.js";

let warned = false;

function key(): Buffer | undefined {
  if (!config.secretKey) {
    if (!warned) {
      log.warn("SECRET_KEY is not set: connection secrets and personal API keys are stored unencrypted.");
      warned = true;
    }
    return undefined;
  }
  return crypto.createHash("sha256").update(config.secretKey).digest();
}

export function encrypt(plain: string): string {
  const k = key();
  if (!k) return `plain:${Buffer.from(plain).toString("base64")}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

export function decrypt(stored: string): string {
  if (stored.startsWith("plain:")) return Buffer.from(stored.slice(6), "base64").toString("utf8");
  const [version, iv, tag, data] = stored.split(":");
  const k = key();
  if (version !== "v1" || !k || !iv || !tag || !data) throw new Error("Cannot decrypt secret: SECRET_KEY missing or changed.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
