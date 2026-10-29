import { spawn } from "node:child_process";
import type { CredentialVault } from "./credential-vault.js";
export type { CredentialVault } from "./credential-vault.js";

export class CredentialVaultError extends Error {
  public constructor(message = "Windows Credential Manager operation failed") {
    super(message);
    this.name = "CredentialVaultError";
  }
}

// Uses the Windows Credential Manager API, not a plaintext password file.
// A secret is sent only over the local PowerShell child's stdin/stdout pipes;
// neither secrets nor raw PowerShell errors are surfaced to MCP tool callers.
export const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class BridgeCredentialStore
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }
    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr result);
    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern void CredFree(IntPtr buffer);

    public static void Save(string target, string username, byte[] utf8Password)
    {
        string password = Encoding.UTF8.GetString(utf8Password);
        byte[] blob = Encoding.Unicode.GetBytes(password);
        if (blob.Length == 0 || blob.Length > 2560) throw new InvalidOperationException("Invalid password length");
        IntPtr pointer = Marshal.AllocHGlobal(blob.Length);
        try
        {
            Marshal.Copy(blob, 0, pointer, blob.Length);
            Credential credential = new Credential {
                Type = 1, TargetName = target, UserName = username, CredentialBlobSize = (uint)blob.Length,
                CredentialBlob = pointer, Persist = 2
            };
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally {
            for (int i = 0; i < blob.Length; i++) { blob[i] = 0; Marshal.WriteByte(pointer, i, 0); }
            for (int i = 0; i < utf8Password.Length; i++) utf8Password[i] = 0;
            Marshal.FreeHGlobal(pointer);
        }
    }
    public static byte[] Read(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try
        {
            Credential credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            if (credential.CredentialBlobSize > 2560) throw new InvalidOperationException("Invalid saved credential");
            byte[] blob = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
            try { return Encoding.UTF8.GetBytes(Encoding.Unicode.GetString(blob)); }
            finally { Array.Clear(blob, 0, blob.Length); }
        }
        finally { CredFree(pointer); }
    }
    public static bool Exists(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer))
        {
            if (Marshal.GetLastWin32Error() == 1168) return false;
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        CredFree(pointer);
        return true;
    }
    public static void Delete(string target)
    {
        if (!CredDelete(target, 1, 0) && Marshal.GetLastWin32Error() != 1168)
            throw new Win32Exception(Marshal.GetLastWin32Error());
    }
}
'@
switch ($env:MCP_BRIDGE_VAULT_OPERATION) {
  'save' {
    $memory = New-Object System.IO.MemoryStream
    [Console]::OpenStandardInput().CopyTo($memory)
    $bytes = $memory.ToArray()
    try { [BridgeCredentialStore]::Save($env:MCP_BRIDGE_VAULT_TARGET, $env:MCP_BRIDGE_VAULT_USERNAME, $bytes) }
    finally { [Array]::Clear($bytes, 0, $bytes.Length); $memory.Dispose() }
    [Console]::Write('ok')
  }
  'read' {
    $bytes = [BridgeCredentialStore]::Read($env:MCP_BRIDGE_VAULT_TARGET)
    try {
      $stdout = [Console]::OpenStandardOutput()
      $stdout.Write($bytes, 0, $bytes.Length)
      $stdout.Flush()
    } finally { [Array]::Clear($bytes, 0, $bytes.Length) }
  }
  'exists' { if ([BridgeCredentialStore]::Exists($env:MCP_BRIDGE_VAULT_TARGET)) { [Console]::Write('yes') } else { [Console]::Write('no') } }
  'delete' { [BridgeCredentialStore]::Delete($env:MCP_BRIDGE_VAULT_TARGET); [Console]::Write('ok') }
  default { exit 10 }
}
`;

type VaultAction = "save" | "read" | "exists" | "delete";

function validateTarget(target: string): void {
  if (!/^MCPBridge\/SSH\/[A-Za-z0-9._-]{1,128}\/[A-Za-z0-9._-]{1,64}$/u.test(target)) {
    throw new CredentialVaultError("Invalid credential target");
  }
}

async function operate(action: VaultAction, target: string, username = "", secret?: string): Promise<Buffer> {
  if (process.platform !== "win32") throw new CredentialVaultError("Windows Credential Manager requires Windows");
  validateTarget(target);
  if (secret !== undefined && (secret.length < 1 || secret.length > 1200 || /[\r\n\u0000]/u.test(secret))) {
    throw new CredentialVaultError("Invalid password length or characters");
  }
  const encoded = Buffer.from(WINDOWS_CREDENTIAL_SCRIPT, "utf16le").toString("base64");
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded,
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        MCP_BRIDGE_VAULT_OPERATION: action,
        MCP_BRIDGE_VAULT_TARGET: target,
        MCP_BRIDGE_VAULT_USERNAME: username,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let failed = false;
    let size = 0;
    const chunks: Buffer[] = [];
    const fail = (): void => {
      if (failed) return;
      failed = true;
      reject(new CredentialVaultError());
      child.kill();
    };
    const timer = setTimeout(fail, 15_000);
    child.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8192) { fail(); return; }
      chunks.push(chunk);
    });
    // Do not relay PowerShell stderr; errors may contain private process details.
    child.stderr.resume();
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return;
      if (code !== 0) { reject(new CredentialVaultError()); return; }
      resolve(Buffer.concat(chunks));
    });
    if (secret !== undefined) child.stdin.end(Buffer.from(secret, "utf8"));
    else child.stdin.end();
  });
}

export class WindowsCredentialVault implements CredentialVault {
  public async save(target: string, username: string, password: string): Promise<void> {
    const response = await operate("save", target, username, password);
    if (response.toString("utf8") !== "ok") throw new CredentialVaultError();
  }
  public async read(target: string): Promise<string> {
    const response = await operate("read", target);
    return response.toString("utf8");
  }
  public async exists(target: string): Promise<boolean> {
    return (await operate("exists", target)).toString("utf8") === "yes";
  }
  public async delete(target: string): Promise<void> {
    const response = await operate("delete", target);
    if (response.toString("utf8") !== "ok") throw new CredentialVaultError();
  }
}
