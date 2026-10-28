import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { promptForLocalPassword } from "./local-password-prompt.js";
import { TerminalSessionManager, type TerminalView } from "./terminal-sessions.js";
import { WindowsCredentialVault, type CredentialVault } from "./windows-credential-vault.js";

export class SavedSshHostError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SavedSshHostError";
  }
}

export interface SavedSshHost {
  readonly workspaceId: string;
  readonly hostId: string;
  readonly host: string;
  readonly username: string;
  readonly port: number;
}

export interface SavedSshHostView extends SavedSshHost {
  readonly credentialAvailable: boolean;
}

export interface SaveSshHostRequest extends SavedSshHost {}

/** Local UI only: password is never accepted by an MCP tool or persisted in host metadata. */
export interface UiSaveSshHostRequest extends SaveSshHostRequest {
  readonly previousHostId?: string;
  readonly password?: string;
}

type PasswordEntry = (label: string) => Promise<string | null>;

const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const USERNAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u;
const DOMAIN_NAME_PATTERN = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;

function verifyIdentity(host: SavedSshHost): void {
  if (!WORKSPACE_ID_PATTERN.test(host.workspaceId) || !HOST_ID_PATTERN.test(host.hostId)) {
    throw new SavedSshHostError("Invalid workspace ID or SSH device alias");
  }
  if (!host.host || (!isIP(host.host) && !DOMAIN_NAME_PATTERN.test(host.host))) {
    throw new SavedSshHostError("SSH address must be an IPv4/IPv6 address or DNS hostname");
  }
  if (!USERNAME_PATTERN.test(host.username)) {
    throw new SavedSshHostError("Invalid SSH username");
  }
  if (!Number.isSafeInteger(host.port) || host.port < 1 || host.port > 65535) {
    throw new SavedSshHostError("Invalid SSH port");
  }
}

function credentialTarget(host: Pick<SavedSshHost, "workspaceId" | "hostId">): string {
  return "MCPBridge/SSH/" + host.workspaceId + "/" + host.hostId;
}

function requireWindowsCredentialManager(): void {
  if (process.platform !== "win32") {
    throw new SavedSshHostError("Saved SSH credentials are Windows-only; macOS Keychain support is not implemented.");
  }
}
function isEntry(value: unknown): value is SavedSshHost {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.workspaceId !== "string" || typeof v.hostId !== "string" ||
      typeof v.host !== "string" || typeof v.username !== "string" || typeof v.port !== "number") return false;
  try {
    verifyIdentity(v as unknown as SavedSshHost);
    return true;
  } catch {
    return false;
  }
}

function removeAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1b[()][A-Za-z0-9]/gu, "");
}

function isPasswordPrompt(text: string): boolean {
  const tail = removeAnsi(text).slice(-400).trimEnd();
  return /(?:password|passphrase)[^\r\n]{0,100}[:：]\s*$/iu.test(tail);
}

export class SavedSshHostManager {
  private entries: SavedSshHost[] | undefined;
  private pending = Promise.resolve();

  public constructor(
    private readonly stateFile: string,
    private readonly vault: CredentialVault = new WindowsCredentialVault(),
    private readonly prompt: PasswordEntry = promptForLocalPassword,
  ) {}

  private async initialize(): Promise<void> {
    // The UI and running MCP server own separate manager instances; always reload external edits.

    try {
      const parsed: unknown = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { hosts?: unknown }).hosts)) {
        throw new SavedSshHostError("Saved SSH host metadata is invalid");
      }
      const hosts = (parsed as { hosts: unknown[] }).hosts;
      if (!hosts.every(isEntry)) throw new SavedSshHostError("Saved SSH host metadata contains invalid entries");
      this.entries = hosts as SavedSshHost[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.entries = [];
        return;
      }
      if (error instanceof SavedSshHostError) throw error;
      throw new SavedSshHostError("Unable to read saved SSH host metadata");
    }
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const operation = this.pending.then(fn, fn);
    this.pending = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async persist(entries: readonly SavedSshHost[]): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const tempFile = this.stateFile + "." + process.pid + "." + randomUUID() + ".tmp";
    try {
      await writeFile(tempFile, JSON.stringify({ version: 1, hosts: entries }, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(tempFile, this.stateFile);
    } finally {
      await unlink(tempFile).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  public async list(workspaceId: string): Promise<SavedSshHostView[]> {
    await this.pending;
    await this.initialize();
    const hosts = this.entries!.filter((entry) => entry.workspaceId === workspaceId);
    return Promise.all(hosts.map(async (entry) => ({
      ...entry,
      credentialAvailable: await this.vault.exists(credentialTarget(entry)).catch(() => false),
    })));
  }

  public async save(request: SaveSshHostRequest): Promise<{ saved: boolean; host: SavedSshHost }> {
    requireWindowsCredentialManager();
    verifyIdentity(request);
    return this.locked(async () => {
      await this.initialize();
      const label = "保存 SSH 凭据：" + request.hostId + "（" + request.username + "@" + request.host + ":" + request.port + "）";
      const password = await this.prompt(label);
      if (password === null) return { saved: false, host: request };
      if (!password || password.length > 1200 || /[\r\n\u0000]/u.test(password)) {
        throw new SavedSshHostError("Invalid SSH password");
      }
      const old = this.entries!.find((entry) => entry.workspaceId === request.workspaceId && entry.hostId === request.hostId);
      // The local confirmation dialog displays the destination before allowing replacement.
      await this.vault.save(credentialTarget(request), request.username, password);
      const entries = this.entries!.filter((entry) => !(entry.workspaceId === request.workspaceId && entry.hostId === request.hostId));
      entries.push({ workspaceId: request.workspaceId, hostId: request.hostId, host: request.host, username: request.username, port: request.port });
      try { await this.persist(entries); }
      catch {
        if (!old) await this.vault.delete(credentialTarget(request)).catch(() => undefined);
        throw new SavedSshHostError("Could not save SSH host metadata");
      }
      this.entries = entries;
      return { saved: true, host: request };
    });
  }

  /** Save metadata and an optional replacement credential from the authenticated local desktop UI. */
  public async saveFromUi(request: UiSaveSshHostRequest): Promise<SavedSshHost> {
    requireWindowsCredentialManager();
    verifyIdentity(request);
    if (request.previousHostId !== undefined && !HOST_ID_PATTERN.test(request.previousHostId)) {
      throw new SavedSshHostError("Invalid previous SSH device alias");
    }
    const password = request.password;
    if (password !== undefined && (password.length < 1 || password.length > 1200 || /[\r\n\u0000]/u.test(password))) {
      throw new SavedSshHostError("Invalid SSH password");
    }
    return this.locked(async () => {
      await this.initialize();
      const previousId = request.previousHostId ?? request.hostId;
      const old = this.entries!.find(entry => entry.workspaceId === request.workspaceId && entry.hostId === previousId);
      if (!request.previousHostId && old) throw new SavedSshHostError("SSH host alias already exists; select it to edit");
      if (request.previousHostId && !old) throw new SavedSshHostError("Original SSH host was not found");
      const duplicate = this.entries!.find(entry => entry.workspaceId === request.workspaceId && entry.hostId === request.hostId && entry !== old);
      if (duplicate) throw new SavedSshHostError("SSH host alias already exists in this workspace");
      const target = credentialTarget(request);
      const oldTarget = old ? credentialTarget(old) : undefined;
      // For an edit, an empty password preserves the saved credential; new entries require one.
      if (!old && password === undefined) throw new SavedSshHostError("A password is required for a new SSH host");
      let priorSecret: string | undefined;
      if (old) {
        const hasOld = await this.vault.exists(oldTarget!);
        if (hasOld) priorSecret = await this.vault.read(oldTarget!);
        if (password === undefined && !priorSecret) {
          throw new SavedSshHostError("The saved credential is missing; enter a new password");
        }
      }
      const changedTarget = oldTarget !== target;
      if (changedTarget && await this.vault.exists(target)) {
        throw new SavedSshHostError("A credential already exists for the new SSH host alias");
      }
      const nextSecret = password ?? priorSecret!;
      const needsVaultWrite = !old || changedTarget || password !== undefined || old.username !== request.username;
      if (needsVaultWrite) await this.vault.save(target, request.username, nextSecret);
      const next: SavedSshHost = {
        workspaceId: request.workspaceId, hostId: request.hostId,
        host: request.host, port: request.port, username: request.username,
      };
      const entries = this.entries!.filter(entry => entry !== old);
      entries.push(next);
      try {
        await this.persist(entries);
      } catch {
        if (needsVaultWrite) {
          if (old && !changedTarget && priorSecret) {
            await this.vault.save(oldTarget!, old.username, priorSecret).catch(() => undefined);
          } else {
            await this.vault.delete(target).catch(() => undefined);
          }
        }
        throw new SavedSshHostError("Could not save SSH host metadata");
      }
      this.entries = entries;
      if (changedTarget && oldTarget) {
        // Remove the old name only after the new metadata and credential are durable.
        await this.vault.delete(oldTarget).catch(() => undefined);
      }
      return next;
    });
  }

  public async remove(workspaceId: string, hostId: string): Promise<{ removed: boolean }> {
    requireWindowsCredentialManager();
    if (!WORKSPACE_ID_PATTERN.test(workspaceId) || !HOST_ID_PATTERN.test(hostId)) {
      throw new SavedSshHostError("Invalid workspace ID or SSH device alias");
    }
    return this.locked(async () => {
      await this.initialize();
      const current = this.entries!.find((entry) => entry.workspaceId === workspaceId && entry.hostId === hostId);
      if (!current) return { removed: false };
      const target = credentialTarget(current);
      const priorPassword = await this.vault.exists(target) ? await this.vault.read(target) : undefined;
      await this.vault.delete(target);
      const entries = this.entries!.filter((entry) => entry !== current);
      try { await this.persist(entries); }
      catch {
        if (priorPassword) await this.vault.save(target, current.username, priorPassword).catch(() => undefined);
        throw new SavedSshHostError("Could not remove SSH host metadata");
      }
      this.entries = entries;
      return { removed: true };
    });
  }

  public async connect(
    workspaceId: string,
    workspaceRoot: string,
    hostId: string,
    sessions: TerminalSessionManager,
  ): Promise<TerminalView> {
    requireWindowsCredentialManager();
    if (!HOST_ID_PATTERN.test(hostId)) throw new SavedSshHostError("Invalid SSH device alias");
    await this.pending;
    await this.initialize();
    const host = this.entries!.find((entry) => entry.workspaceId === workspaceId && entry.hostId === hostId);
    if (!host) throw new SavedSshHostError("SSH device alias is not configured in this workspace");
    if (!(await this.vault.exists(credentialTarget(host)))) {
      throw new SavedSshHostError("SSH password is not saved in Windows Credential Manager");
    }
    const destination = isIP(host.host) === 6 ? host.username + "@[" + host.host + "]" : host.username + "@" + host.host;
    const session = await sessions.start(workspaceId, workspaceRoot, {
      executable: "ssh.exe",
      args: [
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UpdateHostKeys=no",
        "-o", "PubkeyAuthentication=no",
        "-o", "BatchMode=no",
        "-o", "PreferredAuthentications=password,keyboard-interactive",
        "-o", "NumberOfPasswordPrompts=1",
        "-o", "ConnectTimeout=8",
        "-o", "ConnectionAttempts=1",
        "-p", String(host.port),
        destination,
      ],
    });
    try {
      let cursor = 0;
      let recent = "";
      for (let attempt = 0; attempt < 8; attempt++) {
        const read = await sessions.read(workspaceId, session.sessionId, cursor, 1_500);
        cursor = read.nextCursor;
        recent = (recent + read.output).slice(-1600);
        if (isPasswordPrompt(recent)) {
          const password = await this.vault.read(credentialTarget(host));
          if (!password || /[\r\n\u0000]/u.test(password)) throw new SavedSshHostError("Saved SSH password is invalid");
          sessions.write(workspaceId, session.sessionId, password + "\r");
          return session;
        }
        if (read.state === "exited" || /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Permission denied|Connection refused/iu.test(recent)) {
          throw new SavedSshHostError("SSH connection failed before password authentication (check host key or connectivity)");
        }
      }
      throw new SavedSshHostError("SSH did not show a password prompt in time");
    } catch (error) {
      sessions.closeSession(workspaceId, session.sessionId);
      if (error instanceof SavedSshHostError) throw error;
      throw new SavedSshHostError("SSH connection could not use the saved credential");
    }
  }
}
