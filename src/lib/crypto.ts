import { Buffer } from "node:buffer";

const ITERATIONS = 100_000;
const SALT_SIZE = 16;
const IV_SIZE = 12;
const KEY = "votre-mot-de-passe-securise";

/**
 * Génère une clé AES-256 à partir d'un mot de passe et d'un sel
 */
async function deriveKey(password: string, salt: NodeJS.BufferSource) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { hash: "SHA-256", iterations: ITERATIONS, name: "PBKDF2", salt },
    keyMaterial,
    { length: 256, name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Chiffre un fichier
 */
export async function encryptFile(filePath: string, content: string, password: string = KEY) {
  const enc = new TextEncoder();
  const data = enc.encode(content);
  const salt = crypto.getRandomValues(new Uint8Array(SALT_SIZE));
  const iv = crypto.getRandomValues(new Uint8Array(IV_SIZE));
  const key = await deriveKey(password, salt);

  const encrypted = await crypto.subtle.encrypt({ iv, name: "AES-GCM" }, key, data);

  // On concatène [SEL (16b)] + [IV (12b)] + [DATA CHIFFRÉE]
  const result = Buffer.concat([Buffer.from(salt), Buffer.from(iv), Buffer.from(encrypted)]);

  await Bun.write(filePath, result);
}

/**
 * Déchiffre un fichier
 */
export async function decryptFile(encryptedFilePath: string, password: string = KEY) {
  const buffer = await Bun.file(encryptedFilePath).arrayBuffer();
  const salt = buffer.slice(0, SALT_SIZE);
  const iv = buffer.slice(SALT_SIZE, SALT_SIZE + IV_SIZE);
  const encryptedData = buffer.slice(SALT_SIZE + IV_SIZE);

  const key = await deriveKey(password, new Uint8Array(salt));

  try {
    const decryptedBuffer = await crypto.subtle.decrypt(
      { iv: new Uint8Array(iv), name: "AES-GCM" },
      key,
      encryptedData
    );

    // Convertir l'ArrayBuffer en string UTF-8
    return new TextDecoder().decode(decryptedBuffer);
  } catch (error) {
    throw new Error("Déchiffrement échoué (mauvais mot de passe ou fichier corrompu)", { cause: error });
  }
}
