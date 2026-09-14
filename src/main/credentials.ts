/**
 * Credential storage.
 *
 * The stock `@deepseek-ai/dsh-credentials-local` provider keeps API keys in
 * `$DSH_HOME/.credentials.yaml` — readable by any process running as the same OS
 * user, including the agent's own tool processes. A desktop app can do better:
 * Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on
 * Linux) wraps a key that never leaves the OS keychain.
 *
 * Delivery to the harness needs no custom provider, because dsh resolves
 * credentials in a fixed precedence and the **launching environment wins**:
 *
 *     launch environment  >  stored file  >  project .env  >  home .env
 *
 * so the main process decrypts the store and passes the values in the child's
 * environment. They then behave exactly like `DEEPSEEK_API_KEY=... dsh` does:
 * resolvable, and correctly reported as read-only in the settings UI.
 *
 * On-disk format (readable by the child process without Electron, if a custom
 * provider is ever added):
 *
 *   sealed.bin = "DSHD1" || iv(12) || authTag(16) || ciphertext
 *   key        = safeStorage.decryptString(keychainBlob)   (base64, 32 bytes)
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { safeStorage } from 'electron'

const MAGIC = Buffer.from('DSHD1', 'ascii')
const KEYCHAIN_FILE = 'keychain.bin'
const SEALED_FILE = 'sealed.bin'

/** A key/value credential map: environment variable name -> secret. */
export type CredentialMap = Record<string, string>

/**
 * Owns the encrypted credential file.
 *
 * Every write is a full rewrite of a small file, atomically replaced, so a crash
 * can never leave a half-written secret.
 */
export class CredentialStore {
  private readonly dir: string

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'credentials')
  }

  /** Absolute path of the sealed payload. */
  get sealedPath(): string {
    return join(this.dir, SEALED_FILE)
  }

  /** Whether this machine can encrypt at all (a Linux box without libsecret cannot). */
  get available(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  /**
   * Read every stored credential.
   * @returns the map, or an empty map when nothing is stored yet.
   */
  read(): CredentialMap {
    if (!this.available || !existsSync(this.sealedPath)) return {}
    try {
      const raw = readFileSync(this.sealedPath)
      if (raw.subarray(0, MAGIC.length).compare(MAGIC) !== 0) return {}
      const key = this.masterKey()
      if (key === undefined) return {}
      const iv = raw.subarray(MAGIC.length, MAGIC.length + 12)
      const tag = raw.subarray(MAGIC.length + 12, MAGIC.length + 28)
      const ciphertext = raw.subarray(MAGIC.length + 28)
      const decipher = createDecipher(key, iv, tag)
      return JSON.parse(decipher.update(ciphertext).toString('utf8') + decipher.final('utf8')) as CredentialMap
    } catch {
      return {}
    }
  }

  /**
   * Replace the whole credential map.
   * @param credentials - the map to persist.
   */
  write(credentials: CredentialMap): void {
    if (!this.available) throw new Error('dsh-desktop: OS encryption is unavailable on this system')
    mkdirSync(this.dir, { recursive: true })
    const key = this.masterKey(true)
    if (key === undefined) throw new Error('dsh-desktop: could not obtain a master key')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(JSON.stringify(credentials), 'utf8')),
      cipher.final(),
    ])
    const payload = Buffer.concat([MAGIC, iv, cipher.getAuthTag(), ciphertext])

    const temporary = `${this.sealedPath}.${process.pid}.tmp`
    writeFileSync(temporary, payload, { mode: 0o600 })
    renameSync(temporary, this.sealedPath)
  }

  /**
   * Get or create the 32-byte data key, wrapped by the OS keychain.
   * @param create - whether to generate a key when none exists.
   * @returns the raw key, or undefined when absent and `create` is false.
   */
  private masterKey(create = false): Buffer | undefined {
    const keychainPath = join(this.dir, KEYCHAIN_FILE)
    if (existsSync(keychainPath)) {
      try {
        const wrapped = readFileSync(keychainPath, 'utf8')
        const key = Buffer.from(safeStorage.decryptString(Buffer.from(wrapped, 'base64')), 'base64')
        if (key.length === 32) return key
      } catch {
        // A keychain entry that no longer decrypts (e.g. a restored profile on
        // another machine) is indistinguishable from "no store"; fall through.
      }
    }
    if (!create) return undefined
    const key = randomBytes(32)
    const wrapped = safeStorage.encryptString(key.toString('base64')).toString('base64')
    mkdirSync(dirname(keychainPath), { recursive: true })
    writeFileSync(keychainPath, wrapped, { mode: 0o600 })
    return key
  }
}

/** Build a GCM decipher for the sealed format. */
function createDecipher(key: Buffer, iv: Buffer, tag: Buffer) {
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return decipher
}
