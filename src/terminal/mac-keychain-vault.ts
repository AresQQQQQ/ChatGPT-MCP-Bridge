import { spawn, execFile } from "node:child_process";
import { chmod, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import type { CredentialVault } from "./credential-vault.js";

const execFileAsync = promisify(execFile);
const HELPER_SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/terminal/mac-keychain-helper.swift");
const TARGET_PATTERN = /^MCPBridge\/SSH\/[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,64}$/u;

export class MacKeychainVaultError extends Error {
  public constructor(message = "macOS Keychain operation failed") {
    super(message);
    this.name = "MacKeychainVaultError";
  }
}

interface KeychainRequest {
  readonly operation: "save" | "read" | "exists" | "delete";
  readonly target: string;
  readonly username?: string;
  readonly password?: string;
}

/** Stores SSH passwords in the user's macOS Keychain; secrets travel over stdin/stdout, never argv. */
export class MacKeychainVault implements CredentialVault {
  private helperPromise: Promise<void> | undefined;
  private readonly helperPath: string;

  public constructor(stateDirectory: string) {
    this.helperPath = path.join(path.resolve(stateDirectory), "mac-ssh-keychain-helper");
  }

  private async ensureHelper(): Promise<void> {
    if (this.helperPromise) return this.helperPromise;
    this.helperPromise = (async () => {
      if (process.platform !== "darwin") throw new MacKeychainVaultError("macOS Keychain is only available on macOS");
      let sourceInfo;
      try {
        sourceInfo = await stat(HELPER_SOURCE);
      } catch {
        throw new MacKeychainVaultError("macOS Keychain helper source is missing");
      }
      const current = await stat(this.helperPath).catch(() => undefined);
      if (current?.isFile() && (current.mode & 0o111) !== 0 && current.mtimeMs >= sourceInfo.mtimeMs) return;

      await mkdir(path.dirname(this.helperPath), { recursive: true, mode: 0o700 });
      const temporaryPath = this.helperPath + "." + process.pid + "." + randomUUID() + ".tmp";
      try {
        await execFileAsync("/usr/bin/xcrun", [
          "swiftc", "-O", "-framework", "Security", "-o", temporaryPath, HELPER_SOURCE,
        ], { timeout: 120_000, maxBuffer: 16 * 1024, windowsHide: true });
        await chmod(temporaryPath, 0o700);
        await rename(temporaryPath, this.helperPath);
      } catch {
        throw new MacKeychainVaultError("Could not build the macOS Keychain helper; install Xcode Command Line Tools and retry");
      } finally {
        await unlink(temporaryPath).catch(() => undefined);
      }
    })().catch(error => {
      this.helperPromise = undefined;
      throw error instanceof MacKeychainVaultError ? error : new MacKeychainVaultError();
    });
    return this.helperPromise;
  }

  private validateTarget(target: string): void {
    if (!TARGET_PATTERN.test(target)) throw new MacKeychainVaultError("Invalid credential target");
  }

  private async operate(request: KeychainRequest): Promise<Buffer> {
    if (process.platform !== "darwin") throw new MacKeychainVaultError("macOS Keychain is only available on macOS");
    this.validateTarget(request.target);
    if (request.operation === "save") {
      if (!request.username || request.username.length > 64 || !request.password ||
          request.password.length > 1200 || /[\r\n\u0000]/u.test(request.password)) {
        throw new MacKeychainVaultError("Invalid SSH credential");
      }
    }
    await this.ensureHelper();
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(this.helperPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let settled = false;
      let outputBytes = 0;
      const chunks: Buffer[] = [];
      const finishError = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(new MacKeychainVaultError());
      };
      const timer = setTimeout(finishError, 60_000);
      child.on("error", finishError);
      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > 16 * 1024) {
          finishError();
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      // Keychain helper diagnostics are deliberately not relayed; they may contain local details.
      child.stderr.resume();
      child.on("close", code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          reject(new MacKeychainVaultError());
          return;
        }
        resolve(Buffer.concat(chunks));
      });
      child.stdin.on("error", finishError);
      child.stdin.end(Buffer.from(JSON.stringify(request), "utf8"));
    });
  }

  public async save(target: string, username: string, password: string): Promise<void> {
    const result = await this.operate({ operation: "save", target, username, password });
    if (result.toString("utf8") !== "ok") throw new MacKeychainVaultError();
  }

  public async read(target: string): Promise<string> {
    return (await this.operate({ operation: "read", target })).toString("utf8");
  }

  public async exists(target: string): Promise<boolean> {
    return (await this.operate({ operation: "exists", target })).toString("utf8") === "yes";
  }

  public async delete(target: string): Promise<void> {
    const result = await this.operate({ operation: "delete", target });
    if (result.toString("utf8") !== "ok") throw new MacKeychainVaultError();
  }
}
