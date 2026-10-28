import { execFile } from "node:child_process";

export const PASSWORD_UI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName PresentationFramework",
  "$window = New-Object System.Windows.Window",
  "$window.Title = 'MCP Bridge - SSH 密码输入'",
  "$window.Width = 430",
  "$window.Height = 210",
  "$window.ResizeMode = 'NoResize'",
  "$window.WindowStartupLocation = 'CenterScreen'",
  "$window.ShowInTaskbar = $true",
  "$window.Topmost = $true",
  "$panel = New-Object System.Windows.Controls.StackPanel",
  "$panel.Margin = '20'",
  "$label = New-Object System.Windows.Controls.TextBlock",
  "$label.Text = if ($env:MCP_BRIDGE_PASSWORD_LABEL) { $env:MCP_BRIDGE_PASSWORD_LABEL } else { '输入 SSH 密码。仅在本机使用。' }",
  "$label.TextWrapping = 'Wrap'",
  "$label.Margin = '0,0,0,12'",
  "$panel.Children.Add($label) | Out-Null",
  "$passwordBox = New-Object System.Windows.Controls.PasswordBox",
  "$passwordBox.Height = 30",
  "$passwordBox.Margin = '0,0,0,14'",
  "$panel.Children.Add($passwordBox) | Out-Null",
  "$buttons = New-Object System.Windows.Controls.StackPanel",
  "$buttons.Orientation = 'Horizontal'",
  "$buttons.HorizontalAlignment = 'Right'",
  "$ok = New-Object System.Windows.Controls.Button",
  "$ok.Content = '确认'",
  "$ok.Width = 86",
  "$ok.Height = 30",
  "$ok.IsDefault = $true",
  "$ok.Add_Click({ $window.DialogResult = $true })",
  "$buttons.Children.Add($ok) | Out-Null",
  "$cancel = New-Object System.Windows.Controls.Button",
  "$cancel.Content = '取消'",
  "$cancel.Width = 86",
  "$cancel.Height = 30",
  "$cancel.Margin = '10,0,0,0'",
  "$cancel.IsCancel = $true",
  "$cancel.Add_Click({ $window.DialogResult = $false })",
  "$buttons.Children.Add($cancel) | Out-Null",
  "$panel.Children.Add($buttons) | Out-Null",
  "$window.Content = $panel",
  "$window.Add_ContentRendered({ $passwordBox.Focus() | Out-Null })",
  "$result = $window.ShowDialog()",
  "if ($result -eq $true) {",
  "  $bytes = [System.Text.Encoding]::UTF8.GetBytes($passwordBox.Password)",
  "  $stream = [Console]::OpenStandardOutput()",
  "  $stream.Write($bytes, 0, $bytes.Length)",
  "  $stream.Flush()",
  "  exit 0",
  "}",
  "exit 2",
].join("\r\n");

/**
 * Opens a native modal window in the Bridge host's own Windows session.
 * The password is never accepted as an MCP argument, logged or persisted.
 * Cancellation returns null. The caller must not return the password to MCP.
 */
export async function promptForLocalPassword(label: string): Promise<string | null> {
  if (process.platform !== "win32") {
    throw new Error("Local password prompt requires an interactive Windows desktop");
  }
  const encodedCommand = Buffer.from(PASSWORD_UI_SCRIPT, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-STA", "-NonInteractive", "-EncodedCommand", encodedCommand],
      { windowsHide: true, encoding: "utf8", timeout: 90_000, maxBuffer: 8192, env: { ...process.env, MCP_BRIDGE_PASSWORD_LABEL: label.slice(0, 250) } },
      (error, stdout) => {
        if (!error) {
          resolve(stdout);
        } else if ("code" in error && error.code === 2) {
          resolve(null);
        } else {
          // Never include stderr or process error details: they may contain private data.
          reject(new Error("Local password window was not completed; check the Windows desktop session"));
        }
      },
    );
  });
}
