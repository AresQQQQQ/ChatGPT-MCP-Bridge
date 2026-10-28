import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { launchSetupWizardServer, type SetupWizardServer } from "./setup-wizard-server.js";

const WINDOWS_SETUP_SCRIPT = String.raw`
$ApiBase = $env:BRIDGE_SETUP_API_BASE
$Token = $env:BRIDGE_SETUP_TOKEN
if ([string]::IsNullOrWhiteSpace($ApiBase) -or [string]::IsNullOrWhiteSpace($Token)) { throw "Missing local setup session." }
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="ChatGPT MCP Bridge - Tunnel 配置向导"
        Width="650" Height="690" MinWidth="590" MinHeight="620"
        WindowStartupLocation="CenterScreen" Background="#F5F6F8"
        FontFamily="Microsoft YaHei UI" ResizeMode="CanResize">
  <Window.Resources>
    <SolidColorBrush x:Key="Accent" Color="#0F6CBD"/>
    <SolidColorBrush x:Key="PrimaryText" Color="#1D2939"/>
    <SolidColorBrush x:Key="SecondaryText" Color="#667085"/>
    <SolidColorBrush x:Key="Border" Color="#D0D5DD"/>
    <Style TargetType="TextBox">
      <Setter Property="Height" Value="36"/><Setter Property="Padding" Value="9,0"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/>
      <Setter Property="BorderBrush" Value="#D0D5DD"/><Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Background" Value="White"/><Setter Property="Foreground" Value="#344054"/>
    </Style>
    <Style TargetType="Button">
      <Setter Property="Height" Value="36"/><Setter Property="Padding" Value="16,0"/>
      <Setter Property="Background" Value="White"/><Setter Property="Foreground" Value="#344054"/>
      <Setter Property="BorderBrush" Value="#D0D5DD"/><Setter Property="BorderThickness" Value="1"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
    </Style>
  </Window.Resources>
  <Grid Margin="26,22,26,20">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/><RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>
    <StackPanel Grid.Row="0" Margin="0,0,0,18">
      <TextBlock Text="ChatGPT MCP Bridge" FontSize="11" FontWeight="Bold" Foreground="#667085" />
      <TextBlock Text="Tunnel 配置向导" FontSize="24" FontWeight="SemiBold" Foreground="#17202A" Margin="0,5,0,0"/>
      <TextBlock Text="在本机安全配置 Secure Tunnel" FontSize="12" Foreground="#667085" Margin="0,5,0,0"/>
    </StackPanel>
    <Border Grid.Row="1" Background="#FFFFFF" BorderBrush="#E2E6EC" BorderThickness="1" CornerRadius="9" Padding="18" Margin="0,0,0,14">
      <StackPanel>
        <TextBlock x:Name="ModeTitle" Text="准备配置本机 Tunnel" FontSize="14" FontWeight="SemiBold" Foreground="#1D2939"/>
        <TextBlock x:Name="ModeDescription" Text="配置仅保存在当前电脑，不会同步到 GitHub 或另一台电脑。" FontSize="11" Foreground="#667085" TextWrapping="Wrap" Margin="0,5,0,0"/>
        <TextBlock Text="Tunnel ID" FontSize="12" FontWeight="SemiBold" Foreground="#344054" Margin="0,17,0,6"/>
        <TextBox x:Name="TunnelIdBox" ToolTip="Tunnel ID 必须以 tunnel_ 开头" />
        <TextBlock Text="从 OpenAI Tunnel 管理页面复制完整 ID。" FontSize="10" Foreground="#667085" Margin="0,5,0,0"/>
        <TextBlock Text="Runtime API key" FontSize="12" FontWeight="SemiBold" Foreground="#344054" Margin="0,15,0,6"/>
        <PasswordBox x:Name="RuntimeKeyBox" Height="36" Padding="9,0" VerticalContentAlignment="Center" BorderBrush="#D0D5DD" BorderThickness="1" Background="White"/>
        <TextBlock x:Name="KeyHint" Text="首次配置需要填写 Runtime API key。" FontSize="10" Foreground="#667085" TextWrapping="Wrap" Margin="0,5,0,0"/>
        <Grid Margin="0,15,0,0">
          <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="125"/></Grid.ColumnDefinitions>
          <StackPanel Grid.Column="0" Margin="0,0,14,0">
            <TextBlock Text="Tunnel 健康检查端口" FontSize="12" FontWeight="SemiBold" Foreground="#344054" Margin="0,0,0,6"/>
            <TextBox x:Name="HealthPortBox" Text="8080"/>
            <TextBlock x:Name="PortHint" Text="需与 Bridge 监听端口不同。" FontSize="10" Foreground="#667085" Margin="0,5,0,0"/>
          </StackPanel>
          <Border Grid.Column="1" Background="#F5F6F8" BorderBrush="#E2E6EC" BorderThickness="1" CornerRadius="7" Padding="11,8" VerticalAlignment="Top" Margin="0,22,0,0">
            <StackPanel><TextBlock Text="Bridge 端口" FontSize="10" Foreground="#667085"/><TextBlock x:Name="BridgePort" Text="3000" FontFamily="Consolas" FontWeight="SemiBold" FontSize="13" Margin="0,3,0,0"/></StackPanel>
          </Border>
        </Grid>
        <CheckBox x:Name="ReuseClientCheck" Content="复用本机已安装的 Tunnel Client" FontSize="12" Foreground="#344054" Margin="0,16,0,0"/>
        <TextBlock x:Name="ReuseHint" Text="仍会创建独立 profile，不覆盖原 profile。" FontSize="10" Foreground="#667085" Margin="20,4,0,0"/>
      </StackPanel>
    </Border>
    <Border Grid.Row="2" Background="#F8FAFC" BorderBrush="#E2E6EC" BorderThickness="1" CornerRadius="8" Padding="13" Margin="0,0,0,12">
      <StackPanel>
        <DockPanel LastChildFill="False">
          <TextBlock x:Name="ProgressTitle" Text="等待配置" FontSize="12" FontWeight="SemiBold" Foreground="#344054" VerticalAlignment="Center"/>
          <Border x:Name="ProgressBadge" DockPanel.Dock="Right" Background="#F2F4F7" CornerRadius="5" Padding="7,3">
            <TextBlock x:Name="ProgressState" Text="就绪" FontSize="10" Foreground="#667085"/>
          </Border>
        </DockPanel>
        <ProgressBar x:Name="ProgressBar" Height="4" IsIndeterminate="True" Visibility="Collapsed" Margin="0,10,0,0"/>
        <TextBlock x:Name="ProgressDetail" Text="提交后将下载并校验官方客户端，然后初始化本机 profile。" FontSize="10" Foreground="#667085" TextWrapping="Wrap" Margin="0,7,0,0"/>
      </StackPanel>
    </Border>
    <ScrollViewer Grid.Row="3" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
      <TextBlock x:Name="ErrorText" Foreground="#B42318" FontSize="11" TextWrapping="Wrap" Visibility="Collapsed" Margin="2,0,2,8"/>
    </ScrollViewer>
    <StackPanel Grid.Row="4" Orientation="Horizontal" HorizontalAlignment="Right" Margin="0,14,0,0">
      <Button x:Name="CancelButton" Content="取消" MinWidth="90" Margin="0,0,8,0"/>
      <Button x:Name="ApplyButton" Content="验证并保存配置" MinWidth="145" Background="#0F6CBD" Foreground="White" BorderBrush="#0F6CBD"/>
    </StackPanel>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$tunnelIdBox=$window.FindName("TunnelIdBox")
$runtimeKeyBox=$window.FindName("RuntimeKeyBox")
$healthPortBox=$window.FindName("HealthPortBox")
$reuseClientCheck=$window.FindName("ReuseClientCheck")
$reuseHint=$window.FindName("ReuseHint")
$modeTitle=$window.FindName("ModeTitle")
$modeDescription=$window.FindName("ModeDescription")
$keyHint=$window.FindName("KeyHint")
$portHint=$window.FindName("PortHint")
$bridgePort=$window.FindName("BridgePort")
$progressTitle=$window.FindName("ProgressTitle")
$progressState=$window.FindName("ProgressState")
$progressBadge=$window.FindName("ProgressBadge")
$progressBar=$window.FindName("ProgressBar")
$progressDetail=$window.FindName("ProgressDetail")
$errorText=$window.FindName("ErrorText")
$cancelButton=$window.FindName("CancelButton")
$applyButton=$window.FindName("ApplyButton")
$script:ApiBase=$ApiBase
$script:Token=$Token
$script:busy=$false
$script:initialized=$false
$script:snapshot=$null

function Set-InputsEnabled([bool]$enabled) {
  $tunnelIdBox.IsEnabled=$enabled
  $runtimeKeyBox.IsEnabled=$enabled
  $healthPortBox.IsEnabled=$enabled
  $reuseClientCheck.IsEnabled=$enabled -and $script:snapshot -and $script:snapshot.tunnelConfigured
  $applyButton.IsEnabled=$enabled -and -not ($script:snapshot.configurationError)
  $cancelButton.IsEnabled=$enabled
}
function Read-SetupState {
  try {
    $state=Invoke-RestMethod -Method Get -Uri ($script:ApiBase + "/api/snapshot") -Headers @{Authorization=("Bearer " + $script:Token)} -TimeoutSec 3
    $script:snapshot=$state
    if(-not $script:initialized){
      $healthPortBox.Text=[string]$state.defaultHealthPort
      $reuseClientCheck.IsChecked=[bool]$state.reuseClientDefault
      $script:initialized=$true
    }
    $bridgePort.Text=[string]$state.bridgePort
    $portHint.Text="需与 Bridge 监听端口 " + [string]$state.bridgePort + " 不同。"
    $reuseClientCheck.Visibility=if($state.tunnelConfigured){'Visible'}else{'Collapsed'}
    $reuseHint.Visibility=if($state.tunnelConfigured){'Visible'}else{'Collapsed'}
    $modeTitle.Text=if($state.tunnelConfigured){"重新配置本机 Tunnel"}else{"首次配置本机 Tunnel"}
    $modeDescription.Text=if($state.tunnelConfigured){"将为本机创建新的独立 profile，并保留工作区、权限和其他配置。"}else{"向导会初始化本机 Bridge 配置与 Tunnel；所有配置只保存在当前电脑。"}
    $keyHint.Text=if($state.hasRuntimeKey){"留空保留本机已有密钥；输入新值则更新本机 .env。密钥不会显示在日志中。"}else{"首次配置需要填写 Runtime API key。密钥只写入本机 .env，不会同步到 GitHub。"}
    if($state.configurationError){
      $errorText.Text=[string]$state.configurationError
      $errorText.Visibility='Visible'
    }
    if($state.error){
      $errorText.Text=[string]$state.error
      $errorText.Visibility='Visible'
    }elseif($state.configurationError){
      $errorText.Text=[string]$state.configurationError
      $errorText.Visibility='Visible'
    }elseif(-not $script:busy){$errorText.Text='';$errorText.Visibility='Collapsed'}
    $progressTitle.Text=[string]$state.progress
    if($state.running -or $script:busy){
      $progressState.Text="进行中";$progressState.Foreground=[Windows.Media.Brushes]::DodgerBlue
      $progressBadge.Background=[Windows.Media.Brushes]::AliceBlue
      $progressBar.Visibility='Visible'
      $progressDetail.Text="请保持窗口打开。配置只作用于当前电脑。"
      Set-InputsEnabled $false
    }elseif($state.success){
      $progressState.Text="已完成";$progressState.Foreground=[Windows.Media.Brushes]::ForestGreen
      $progressBadge.Background=[Windows.Media.Brushes]::Honeydew
      $progressBar.Visibility='Collapsed'
      $progressDetail.Text="配置已保存。关闭此窗口后即可启动 Bridge。"
      $applyButton.Visibility='Collapsed'
      $cancelButton.Content="完成并关闭"
      Set-InputsEnabled $false
    }elseif($state.error -or $state.configurationError){
      $progressState.Text="需要处理";$progressState.Foreground=[Windows.Media.Brushes]::Firebrick
      $progressBadge.Background=[Windows.Media.Brushes]::MistyRose
      $progressBar.Visibility='Collapsed'
      $progressDetail.Text="配置失败时会保留原有配置。修正输入后可以重试。"
      Set-InputsEnabled (-not [bool]$state.configurationError)
    }else{
      $progressState.Text="就绪";$progressState.Foreground=[Windows.Media.Brushes]::DimGray
      $progressBadge.Background=[Windows.Media.Brushes]::Gainsboro
      $progressBar.Visibility='Collapsed'
      $progressDetail.Text="提交后将下载并校验官方客户端，然后初始化本机 profile。"
      Set-InputsEnabled $true
    }
  } catch {
    $errorText.Text="无法读取配置向导状态。请关闭后重新打开。"
    $errorText.Visibility='Visible'
    $progressState.Text="连接失败"
  }
}

$applyButton.Add_Click({
  if($script:busy){return}
  $id=$tunnelIdBox.Text.Trim()
  if($id -notmatch '^tunnel_[A-Za-z0-9_-]{1,128}$'){
    $errorText.Text="Tunnel ID 格式无效，应以 tunnel_ 开头。";$errorText.Visibility='Visible';return
  }
  $port=0
  if(-not [int]::TryParse($healthPortBox.Text,[ref]$port) -or $port -lt 1024 -or $port -gt 65535 -or $port -eq [int]$script:snapshot.bridgePort){
    $errorText.Text="健康端口须为 1024–65535，且不能与 Bridge 端口相同。";$errorText.Visibility='Visible';return
  }
  $key=$runtimeKeyBox.Password
  if([string]::IsNullOrWhiteSpace($key) -and -not $script:snapshot.hasRuntimeKey){
    $errorText.Text="首次配置需要填写 Runtime API key。";$errorText.Visibility='Visible';return
  }
  $payload=@{tunnelId=$id;runtimeKey=$key;healthPort=$port;reuseClient=[bool]$reuseClientCheck.IsChecked}
  $runtimeKeyBox.Password=''
  $script:busy=$true
  $errorText.Text='';$errorText.Visibility='Collapsed'
  Set-InputsEnabled $false
  $progressState.Text="进行中";$progressBar.Visibility='Visible';$progressDetail.Text="正在向本机配置服务提交请求…"
  $worker=New-Object System.ComponentModel.BackgroundWorker
  $worker.add_DoWork({
    param($sender,$eventArgs)
    $json=$eventArgs.Argument | ConvertTo-Json -Depth 4 -Compress
    $eventArgs.Result=Invoke-RestMethod -Method Post -Uri ($script:ApiBase + "/api/setup") -Headers @{Authorization=("Bearer " + $script:Token)} -ContentType "application/json" -Body $json -TimeoutSec 600
  })
  $worker.add_RunWorkerCompleted({
    param($sender,$eventArgs)
    $script:busy=$false
    if($eventArgs.Error){
      $errorText.Text=[string]$eventArgs.Error.Exception.Message
      $errorText.Visibility='Visible'
    }
    Read-SetupState
  })
  $worker.RunWorkerAsync($payload)
})
$cancelButton.Add_Click({ if(-not $script:busy){$window.Close()} })
$window.Add_Closing({ param($sender,$eventArgs) if($script:busy){$eventArgs.Cancel=$true} })
$timer=New-Object Windows.Threading.DispatcherTimer
$timer.Interval=[TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({Read-SetupState})
$timer.Start()
Read-SetupState
[void]$window.ShowDialog()
$timer.Stop()
`;

export interface WindowsSetupWizardUi {
  close(): Promise<void>;
}

function resolvePowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("无法定位 Windows PowerShell：SystemRoot/WINDIR 不可用。");
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export async function launchWindowsSetupWizardUi(configPath: string): Promise<WindowsSetupWizardUi> {
  if (process.platform !== "win32") throw new Error("Windows Tunnel 配置向导仅支持 Windows。");
  const server: SetupWizardServer = await launchSetupWizardServer(configPath);
  const temp = await mkdtemp(path.join(os.tmpdir(), "mcp-bridge-setup-ui-"));
  const scriptPath = path.join(temp, "setup-ui.ps1");
  await writeFile(scriptPath, "\uFEFF" + WINDOWS_SETUP_SCRIPT, "utf8");
  let child: ChildProcess | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let exited: Promise<unknown> | undefined;
  const cleanup = (terminateUi: boolean): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      if (terminateUi && child && child.exitCode === null && child.signalCode === null) {
        child.kill();
        if (exited) await exited;
      }
      await server.close();
      await rm(temp, { recursive: true, force: true }).catch(() => undefined);
    })();
    return cleanupPromise;
  };
  try {
    child = spawn(resolvePowerShell(), [
      "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", scriptPath,
    ], { shell: false, windowsHide: false, stdio: "ignore", env: { ...process.env, BRIDGE_SETUP_API_BASE: server.origin, BRIDGE_SETUP_TOKEN: server.token } });
    exited = once(child, "close");
    await new Promise<void>((resolve, reject) => {
      child?.once("spawn", resolve);
      child?.once("error", reject);
    });
    child.once("close", () => { void cleanup(false); });
    return { close: () => cleanup(true) };
  } catch (error) {
    await cleanup(true);
    throw error;
  }
}