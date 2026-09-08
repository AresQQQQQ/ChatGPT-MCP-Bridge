import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_CONFIG_FILE } from "../config.js";
import { BridgeController, type BridgeControllerStatus, type LogEntry } from "../control/bridge-controller.js";
import { readWorkspaceConfig, writeWorkspaceConfig, type EditableWorkspace } from "./workspace-config.js";

const REFRESH_INTERVAL_MS = 800;
const COMMAND_POLL_INTERVAL_MS = 150;
const UI_ASSET_ROOT = fileURLToPath(new URL("../../assets/icons/", import.meta.url));
const UI_LOGO_FILES = ["chatgpt-mcp-bridge.png", "chatgpt.png", "secure-tunnel.png", "mcp.png", "mcp-bridge.png", "codex-desktop.png"] as const;

const WPF_SCRIPT = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$SnapshotPath,
  [Parameter(Mandatory=$true)][string]$CommandPath,
  [Parameter(Mandatory=$true)][string]$ConfigEditPath,
  [Parameter(Mandatory=$true)][string]$AssetRoot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport]
[Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
internal class FileOpenDialogCom { }

[ComImport]
[Guid("42F85136-DB7E-439C-85F1-E4075D135FC8")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IFileDialog
{
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int alignment);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
}

[ComImport]
[Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellItem
{
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, out IntPtr ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
}

public static class ModernFolderPicker
{
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string path,
        IntPtr bindContext,
        ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

    public static string PickFolder(IntPtr owner, string initialPath, string title)
    {
        IFileDialog dialog = (IFileDialog)new FileOpenDialogCom();
        IShellItem initialFolder = null;
        IShellItem result = null;
        try
        {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
            dialog.SetTitle(title ?? "选择项目文件夹");

            if (!string.IsNullOrWhiteSpace(initialPath) && System.IO.Directory.Exists(initialPath))
            {
                Guid shellItemId = typeof(IShellItem).GUID;
                SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref shellItemId, out initialFolder);
                dialog.SetFolder(initialFolder);
            }

            int hr = dialog.Show(owner);
            if (hr == ERROR_CANCELLED) return null;
            if (hr != 0) Marshal.ThrowExceptionForHR(hr);

            dialog.GetResult(out result);
            IntPtr displayName;
            result.GetDisplayName(SIGDN_FILESYSPATH, out displayName);
            try
            {
                return Marshal.PtrToStringUni(displayName);
            }
            finally
            {
                Marshal.FreeCoTaskMem(displayName);
            }
        }
        finally
        {
            if (result != null) Marshal.FinalReleaseComObject(result);
            if (initialFolder != null) Marshal.FinalReleaseComObject(initialFolder);
            Marshal.FinalReleaseComObject(dialog);
        }
    }
}
'@

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="ChatGPT MCP Bridge" Width="1120" Height="780" MinWidth="900" MinHeight="640"
        WindowStartupLocation="CenterScreen" Background="#F5F6F8" FontFamily="Microsoft YaHei UI">
  <Window.Resources>
    <SolidColorBrush x:Key="AccentBrush" Color="#0F6CBD"/>
    <SolidColorBrush x:Key="TextPrimaryBrush" Color="#1D2939"/>
    <SolidColorBrush x:Key="TextSecondaryBrush" Color="#667085"/>
    <SolidColorBrush x:Key="BorderBrush" Color="#E2E6EC"/>
    <SolidColorBrush x:Key="SurfaceBrush" Color="#FFFFFF"/>

    <!-- Tree icons use the final Microsoft Fluent geometry stored under assets/icons/tree/. -->
    <Geometry x:Key="IconProject">M6.75 8C7.16421 8 7.5 7.66421 7.5 7.25C7.5 6.83579 7.16421 6.5 6.75 6.5C6.33579 6.5 6 6.83579 6 7.25C6 7.66421 6.33579 8 6.75 8ZM7.5 10.25C7.5 10.6642 7.16421 11 6.75 11C6.33579 11 6 10.6642 6 10.25C6 9.83579 6.33579 9.5 6.75 9.5C7.16421 9.5 7.5 9.83579 7.5 10.25ZM6.75 14C7.16421 14 7.5 13.6642 7.5 13.25C7.5 12.8358 7.16421 12.5 6.75 12.5C6.33579 12.5 6 12.8358 6 13.25C6 13.6642 6.33579 14 6.75 14ZM9 7.5C9 7.22386 9.22386 7 9.5 7H13.5C13.7761 7 14 7.22386 14 7.5C14 7.77614 13.7761 8 13.5 8H9.5C9.22386 8 9 7.77614 9 7.5ZM9.5 10C9.22386 10 9 10.2239 9 10.5C9 10.7761 9.22386 11 9.5 11H13.5C13.7761 11 14 10.7761 14 10.5C14 10.2239 13.7761 10 13.5 10H9.5ZM9 13.5C9 13.2239 9.22386 13 9.5 13H13.5C13.7761 13 14 13.2239 14 13.5C14 13.7761 13.7761 14 13.5 14H9.5C9.22386 14 9 13.7761 9 13.5ZM5.75 3H14.25C15.7688 3 17 4.23122 17 5.75V14.25C17 15.7688 15.7688 17 14.25 17H5.75C4.23122 17 3 15.7688 3 14.25V5.75C3 4.23122 4.23122 3 5.75 3ZM4 5.75V14.25C4 15.2165 4.7835 16 5.75 16H14.25C15.2165 16 16 15.2165 16 14.25V5.75C16 4.7835 15.2165 4 14.25 4H5.75C4.7835 4 4 4.7835 4 5.75Z</Geometry>
    <Geometry x:Key="IconPersistentModule">M5.70295 6.04347C5.45061 5.93131 5.15513 6.04495 5.04298 6.29729C4.93082 6.54964 5.04447 6.84512 5.29681 6.95727L9.49975 8.8253V12.2061C9.75159 11.658 10.0909 11.1585 10.4998 10.7253V8.82531L14.7029 6.95728C14.9553 6.84513 15.0689 6.54965 14.9568 6.2973C14.8446 6.04496 14.5492 5.93131 14.2968 6.04346L9.99976 7.95321L5.70295 6.04347ZM9.07152 16.5904C9.1991 16.6415 9.32983 16.6816 9.46236 16.7108C9.62783 17.0873 9.83428 17.4417 10.0761 17.7684C9.60946 17.7786 9.14132 17.6954 8.70013 17.5189L2.94291 15.216C2.37343 14.9882 2 14.4367 2 13.8233V6.17738C2 5.56402 2.37343 5.01246 2.94291 4.78466L8.70013 2.48178C9.53457 2.148 10.4654 2.148 11.2999 2.48178L17.0571 4.78466C17.6266 5.01246 18 5.56402 18 6.17738V10.2572C17.6929 10.0035 17.3578 9.78261 17 9.59971V6.17738C17 5.97293 16.8755 5.78907 16.6857 5.71314L10.9285 3.41025C10.3324 3.17184 9.66755 3.17184 9.07152 3.41025L3.31431 5.71314C3.12448 5.78907 3 5.97293 3 6.17738V13.8233C3 14.0278 3.12448 14.2116 3.3143 14.2876L9.07152 16.5904ZM19 14.5C19 16.9853 16.9853 19 14.5 19C12.0147 19 10 16.9853 10 14.5C10 12.0147 12.0147 10 14.5 10C16.9853 10 19 12.0147 19 14.5ZM13.8536 16.3536L16.8536 13.3536C17.0488 13.1583 17.0488 12.8417 16.8536 12.6464C16.6583 12.4512 16.3417 12.4512 16.1464 12.6464L13.5 15.2929L12.8536 14.6464C12.6583 14.4512 12.3417 14.4512 12.1464 14.6464C11.9512 14.8417 11.9512 15.1583 12.1464 15.3536L13.1464 16.3536C13.3417 16.5488 13.6583 16.5488 13.8536 16.3536Z</Geometry>
    <Geometry x:Key="IconTemporaryModule">M5.70295 6.04249C5.45061 5.93033 5.15513 6.04398 5.04298 6.29632C4.93082 6.54866 5.04447 6.84414 5.29681 6.9563L9.49975 8.82433V12.2056C9.75159 11.6575 10.0909 11.158 10.4998 10.7248V8.82433L14.7029 6.9563C14.9553 6.84415 15.0689 6.54867 14.9568 6.29633C14.8446 6.04398 14.5492 5.93034 14.2968 6.04248L9.99976 7.95223L5.70295 6.04249ZM9.07152 16.5895C9.19902 16.6405 9.32967 16.6806 9.46213 16.7097C9.62756 17.0863 9.83396 17.4407 10.0757 17.7675C9.60922 17.7775 9.14121 17.6944 8.70013 17.5179L2.94291 15.2151C2.37343 14.9873 2 14.4357 2 13.8223V6.1764C2 5.56305 2.37343 5.01148 2.94291 4.78369L8.70013 2.4808C9.53457 2.14702 10.4654 2.14702 11.2999 2.4808L17.0571 4.78369C17.6266 5.01148 18 5.56305 18 6.1764V10.2567C17.6929 10.003 17.3578 9.78212 17 9.59922V6.1764C17 5.97195 16.8755 5.7881 16.6857 5.71216L10.9285 3.40928C10.3324 3.17087 9.66755 3.17087 9.07152 3.40928L3.31431 5.71216C3.12448 5.7881 3 5.97195 3 6.1764V13.8223C3 14.0268 3.12448 14.2106 3.3143 14.2866L9.07152 16.5895ZM10 14.4995C10 16.9848 12.0147 18.9995 14.5 18.9995C16.9853 18.9995 19 16.9848 19 14.4995C19 12.0142 16.9853 9.99951 14.5 9.99951C12.0147 9.99951 10 12.0142 10 14.4995ZM16.5 11.4995C16.7761 11.4995 17 11.7234 17 11.9995V13.4995C17 13.7757 16.7761 13.9995 16.5 13.9995H15C14.7239 13.9995 14.5 13.7757 14.5 13.4995C14.5 13.2234 14.7239 12.9995 15 12.9995H15.4682C15.4179 12.9717 15.3663 12.946 15.3135 12.9225C15.0682 12.8132 14.8034 12.7545 14.535 12.7498C14.2665 12.7451 13.9998 12.7945 13.7508 12.8951C13.5018 12.9957 13.2756 13.1454 13.0857 13.3353C12.8905 13.5306 12.5739 13.5306 12.3786 13.3353C12.1834 13.14 12.1834 12.8235 12.3786 12.6282C12.6635 12.3434 13.0027 12.1188 13.3762 11.9679C13.7497 11.8171 14.1497 11.7429 14.5524 11.75C14.9552 11.757 15.3524 11.8451 15.7203 12.009C15.8162 12.0516 15.9095 12.0992 16 12.1515V11.9995C16 11.7234 16.2239 11.4995 16.5 11.4995ZM15.6238 17.0311C15.2503 17.182 14.8503 17.2561 14.4476 17.2491C14.0448 17.242 13.6476 17.1539 13.2797 16.9901C13.1838 16.9474 13.0905 16.8998 13 16.8476V16.9995C13 17.2757 12.7761 17.4995 12.5 17.4995C12.2239 17.4995 12 17.2757 12 16.9995V15.4995C12 15.2234 12.2239 14.9995 12.5 14.9995H14C14.2761 14.9995 14.5 15.2234 14.5 15.4995C14.5 15.7757 14.2761 15.9995 14 15.9995H13.5318C13.5821 16.0274 13.6337 16.0531 13.6865 16.0766C13.9318 16.1858 14.1966 16.2445 14.465 16.2492C14.7335 16.2539 15.0002 16.2045 15.2492 16.1039C15.4982 16.0033 15.7244 15.8536 15.9143 15.6637C16.1095 15.4685 16.4261 15.4685 16.6214 15.6637C16.8166 15.859 16.8166 16.1756 16.6214 16.3708C16.3365 16.6557 15.9973 16.8802 15.6238 17.0311Z</Geometry>

    <Style x:Key="PanelBorderStyle" TargetType="Border">
      <Setter Property="Background" Value="{StaticResource SurfaceBrush}"/>
      <Setter Property="BorderBrush" Value="{StaticResource BorderBrush}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="8"/>
    </Style>
    <Style TargetType="Button">
      <Setter Property="Height" Value="34"/>
      <Setter Property="Padding" Value="14,0"/>
      <Setter Property="Background" Value="#FFFFFF"/>
      <Setter Property="Foreground" Value="#344054"/>
      <Setter Property="BorderBrush" Value="#D0D5DD"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="HorizontalContentAlignment" Value="Center"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="{x:Type Button}">
            <Border x:Name="ButtonChrome"
                    Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}"
                    CornerRadius="5"
                    SnapsToDevicePixels="True"
                    RenderTransformOrigin="0.5,0.5">
              <Border.RenderTransform><TranslateTransform Y="0"/></Border.RenderTransform>
              <ContentPresenter Margin="{TemplateBinding Padding}"
                                HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}"
                                VerticalAlignment="{TemplateBinding VerticalContentAlignment}"
                                RecognizesAccessKey="True"/>
            </Border>
            <ControlTemplate.Triggers>
              <EventTrigger RoutedEvent="MouseEnter">
                <BeginStoryboard>
                  <Storyboard>
                    <DoubleAnimation Storyboard.TargetName="ButtonChrome" Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.Y)" To="-1" Duration="0:0:0.12">
                      <DoubleAnimation.EasingFunction><QuadraticEase EasingMode="EaseOut"/></DoubleAnimation.EasingFunction>
                    </DoubleAnimation>
                    <DoubleAnimation Storyboard.TargetName="ButtonChrome" Storyboard.TargetProperty="Opacity" To="0.96" Duration="0:0:0.10"/>
                  </Storyboard>
                </BeginStoryboard>
              </EventTrigger>
              <EventTrigger RoutedEvent="MouseLeave">
                <BeginStoryboard>
                  <Storyboard>
                    <DoubleAnimation Storyboard.TargetName="ButtonChrome" Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.Y)" To="0" Duration="0:0:0.10">
                      <DoubleAnimation.EasingFunction><QuadraticEase EasingMode="EaseOut"/></DoubleAnimation.EasingFunction>
                    </DoubleAnimation>
                    <DoubleAnimation Storyboard.TargetName="ButtonChrome" Storyboard.TargetProperty="Opacity" To="1" Duration="0:0:0.10"/>
                  </Storyboard>
                </BeginStoryboard>
              </EventTrigger>
              <Trigger Property="IsPressed" Value="True"><Setter TargetName="ButtonChrome" Property="Opacity" Value="0.82"/></Trigger>
              <Trigger Property="IsEnabled" Value="False"><Setter TargetName="ButtonChrome" Property="Opacity" Value="0.52"/></Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="PrimaryButtonStyle" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Background" Value="#0F6CBD"/>
      <Setter Property="Foreground" Value="White"/>
      <Setter Property="BorderBrush" Value="#0F6CBD"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
    </Style>
    <Style x:Key="DangerButtonStyle" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Foreground" Value="#B42318"/>
      <Setter Property="BorderBrush" Value="#FDA29B"/>
      <Setter Property="Background" Value="#FFFFFF"/>
    </Style>
    <Style TargetType="TextBox">
      <Setter Property="Height" Value="34"/>
      <Setter Property="Padding" Value="8,0"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/>
      <Setter Property="BorderBrush" Value="#D0D5DD"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Background" Value="#FFFFFF"/>
      <Setter Property="Foreground" Value="#344054"/>
    </Style>
    <Style TargetType="ComboBox">
      <Setter Property="Height" Value="34"/>
      <Setter Property="Padding" Value="7,0"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/>
      <Setter Property="BorderBrush" Value="#D0D5DD"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="Background" Value="#FFFFFF"/>
      <Setter Property="Foreground" Value="#344054"/>
    </Style>
  </Window.Resources>

  <Grid Margin="20,16,20,18">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="Auto"/>
    </Grid.RowDefinitions>

    <Grid Grid.Row="0" Margin="2,0,2,14">
      <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
      <StackPanel Orientation="Horizontal" VerticalAlignment="Center">
        <Border Width="42" Height="42" CornerRadius="9" Background="#E7F1FB" Margin="0,0,12,0">
          <Image x:Name="TitleLogoImage" Width="29" Height="29" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality" HorizontalAlignment="Center" VerticalAlignment="Center"/>
        </Border>
        <StackPanel VerticalAlignment="Center">
          <StackPanel Orientation="Horizontal">
            <TextBlock Text="ChatGPT MCP Bridge" FontSize="21" FontWeight="SemiBold" Foreground="#17202A" VerticalAlignment="Center"/>
            <Border x:Name="OverallStatusBadge" Margin="14,0,0,0" Padding="9,3" CornerRadius="5" Background="#F2F4F7" VerticalAlignment="Center">
              <StackPanel Orientation="Horizontal">
                <Ellipse x:Name="OverallStatusDot" Width="8" Height="8" Fill="#98A2B3" Margin="0,0,6,0" VerticalAlignment="Center"/>
                <TextBlock x:Name="OverallStatusText" Text="读取状态…" FontSize="12" FontWeight="SemiBold" Foreground="#475467"/>
              </StackPanel>
            </Border>
          </StackPanel>
          <TextBlock Text="本地 MCP Bridge 控制台" Margin="0,3,0,0" FontSize="12" Foreground="#667085"/>
        </StackPanel>
      </StackPanel>
      <StackPanel Grid.Column="1" Orientation="Horizontal" VerticalAlignment="Center">
        <Button x:Name="StartButton" MinWidth="104" Style="{StaticResource PrimaryButtonStyle}">
          <StackPanel Orientation="Horizontal"><Path Width="16" Height="16" Stretch="Uniform" Margin="0,0,7,0" Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType={x:Type Button}}}" Data="M17.2204 8.68703C18.2558 9.25661 18.2558 10.7434 17.2204 11.313L7.2234 16.812C6.22371 17.362 5 16.6393 5 15.4991L5 4.50093C5 3.36068 6.22371 2.63805 7.2234 3.18795L17.2204 8.68703ZM16.7381 10.4377C17.0833 10.2478 17.0833 9.7522 16.7381 9.56234L6.74113 4.06327C6.4079 3.87997 6 4.12084 6 4.50093L6 15.4991C6 15.8792 6.4079 16.12 6.74114 15.9367L16.7381 10.4377Z"/><TextBlock Text="启动服务" VerticalAlignment="Center"/></StackPanel>
        </Button>
        <Button x:Name="StopButton" MinWidth="104" Margin="8,0,0,0" Style="{StaticResource PrimaryButtonStyle}">
          <StackPanel Orientation="Horizontal"><Path Width="16" Height="16" Stretch="Uniform" Margin="0,0,7,0" Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType={x:Type Button}}}" Data="M15.5 4C15.7761 4 16 4.22386 16 4.5V15.5C16 15.7761 15.7761 16 15.5 16H4.5C4.22386 16 4 15.7761 4 15.5V4.5C4 4.22386 4.22386 4 4.5 4H15.5ZM4.5 3C3.67157 3 3 3.67157 3 4.5V15.5C3 16.3284 3.67157 17 4.5 17H15.5C16.3284 17 17 16.3284 17 15.5V4.5C17 3.67157 16.3284 3 15.5 3H4.5Z"/><TextBlock Text="停止服务" VerticalAlignment="Center"/></StackPanel>
        </Button>
        <Button x:Name="LocalMcpButton" MinWidth="126" Margin="8,0,0,0" ToolTip="查看并管理 Bridge 当前热挂载的本地 MCP">
          <StackPanel Orientation="Horizontal">
            <Path Width="16" Height="16" Stretch="Uniform" Margin="0,0,7,0" Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType={x:Type Button}}}" Data="M5.5 3C4.67157 3 4 3.67157 4 4.5V6H3.5C2.67157 6 2 6.67157 2 7.5V12.5C2 13.3284 2.67157 14 3.5 14H4V15.5C4 16.3284 4.67157 17 5.5 17H8V14H7V16H5.5C5.22386 16 5 15.7761 5 15.5V14H6.5C7.32843 14 8 13.3284 8 12.5V7.5C8 6.67157 7.32843 6 6.5 6H5V4.5C5 4.22386 5.22386 4 5.5 4H8V3H5.5ZM3.5 7H6.5C6.77614 7 7 7.22386 7 7.5V12.5C7 12.7761 6.77614 13 6.5 13H3.5C3.22386 13 3 12.7761 3 12.5V7.5C3 7.22386 3.22386 7 3.5 7ZM12 3V6H13V4H15.5C15.7761 4 16 4.22386 16 4.5V6H14.5C13.6716 6 13 6.67157 13 7.5V12.5C13 13.3284 13.6716 14 14.5 14H16V15.5C16 15.7761 15.7761 16 15.5 16H13V17H15.5C16.3284 17 17 16.3284 17 15.5V14H17.5C18.3284 14 19 13.3284 19 12.5V7.5C19 6.67157 18.3284 6 17.5 6H17V4.5C17 3.67157 16.3284 3 15.5 3H12ZM14 7.5C14 7.22386 14.2239 7 14.5 7H17.5C17.7761 7 18 7.22386 18 7.5V12.5C18 12.7761 17.7761 13 17.5 13H14.5C14.2239 13 14 12.7761 14 12.5V7.5ZM8.5 9.5H12.5V10.5H8.5V9.5Z"/>
            <TextBlock Text="本地 MCP" VerticalAlignment="Center"/>
            <Border Margin="8,0,0,0" Padding="6,1" CornerRadius="8" Background="#F2F4F7" VerticalAlignment="Center"><TextBlock x:Name="LocalMcpCountText" Text="0" FontSize="10" Foreground="#667085"/></Border>
          </StackPanel>
        </Button>
      </StackPanel>
      <Popup x:Name="LocalMcpPopup" Grid.Column="1" PlacementTarget="{Binding ElementName=LocalMcpButton}" Placement="Bottom" HorizontalOffset="-388" VerticalOffset="8" StaysOpen="False" AllowsTransparency="True" PopupAnimation="Fade">
        <Border Width="520" Background="#FFFFFF" BorderBrush="#D0D5DD" BorderThickness="1" CornerRadius="9" Padding="16">
          <Border.Effect><DropShadowEffect BlurRadius="18" ShadowDepth="4" Opacity="0.16" Color="#344054"/></Border.Effect>
          <Grid>
            <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
            <Grid Grid.Row="0" Margin="0,0,0,4">
              <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
              <StackPanel><TextBlock Text="本地 MCP 热挂载" FontSize="14" FontWeight="SemiBold" Foreground="#344054"/><TextBlock x:Name="LocalMcpSummaryText" Text="暂无配置" Margin="0,3,0,0" FontSize="10" Foreground="#98A2B3"/></StackPanel>
              <Border Grid.Column="1" Padding="8,3" CornerRadius="5" Background="#EEF4FF" VerticalAlignment="Top"><TextBlock Text="Runtime Registry" FontSize="10" Foreground="#0F6CBD"/></Border>
            </Grid>
            <TextBlock Grid.Row="1" Text="加载 / 卸载只控制 Bridge 是否代理该 MCP，不会启动或关闭下游进程。" FontSize="10" Foreground="#667085" Margin="0,4,0,10"/>
            <Grid Grid.Row="2">
              <ListView x:Name="LocalMcpList" Height="225" BorderBrush="#EAECF0" BorderThickness="1" Background="#FFFFFF" ScrollViewer.HorizontalScrollBarVisibility="Disabled">
                <ListView.ItemContainerStyle>
                  <Style TargetType="ListViewItem">
                    <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
                    <Setter Property="Padding" Value="0"/>
                    <Setter Property="Margin" Value="0"/>
                    <Setter Property="BorderThickness" Value="0"/>
                    <Setter Property="Background" Value="Transparent"/>
                    <Style.Triggers>
                      <Trigger Property="IsMouseOver" Value="True"><Setter Property="Background" Value="#F8FAFC"/></Trigger>
                      <Trigger Property="IsSelected" Value="True"><Setter Property="Background" Value="#EEF4FF"/></Trigger>
                    </Style.Triggers>
                  </Style>
                </ListView.ItemContainerStyle>
                <ListView.ItemTemplate>
                  <DataTemplate>
                    <Grid Margin="11,9">
                      <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                      <StackPanel>
                        <StackPanel Orientation="Horizontal">
                          <TextBlock Text="{Binding displayName}" FontWeight="SemiBold" Foreground="#344054"/>
                          <Border Margin="8,0,0,0" Padding="6,1" CornerRadius="7" Background="{Binding loadBadgeBrush}"><TextBlock Text="{Binding loadText}" FontSize="9" Foreground="{Binding loadBrush}"/></Border>
                        </StackPanel>
                        <TextBlock Text="{Binding url}" Margin="0,4,12,0" FontFamily="Consolas" FontSize="10" Foreground="#667085" TextTrimming="CharacterEllipsis" ToolTip="{Binding url}"/>
                      </StackPanel>
                      <StackPanel Grid.Column="1" HorizontalAlignment="Right" VerticalAlignment="Center">
                        <StackPanel Orientation="Horizontal" HorizontalAlignment="Right"><Ellipse Width="7" Height="7" Fill="{Binding stateBrush}" Margin="0,0,5,0" VerticalAlignment="Center"/><TextBlock Text="{Binding stateText}" FontSize="10" Foreground="{Binding stateBrush}"/></StackPanel>
                        <TextBlock Text="{Binding detailText}" Margin="0,3,0,0" HorizontalAlignment="Right" FontSize="9" Foreground="#98A2B3"/>
                      </StackPanel>
                    </Grid>
                  </DataTemplate>
                </ListView.ItemTemplate>
              </ListView>
              <TextBlock x:Name="LocalMcpEmptyText" Text="尚未配置本地 MCP" HorizontalAlignment="Center" VerticalAlignment="Center" Foreground="#98A2B3" Visibility="Collapsed"/>
            </Grid>
            <TextBlock x:Name="LocalMcpMessage" Grid.Row="3" Margin="0,9,0,0" FontSize="10" Foreground="#667085" TextWrapping="Wrap"/>
            <Grid Grid.Row="4" Margin="0,12,0,0">
              <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
              <TextBlock Text="选择一个 MCP 后可检测或切换挂载状态" FontSize="10" Foreground="#98A2B3" VerticalAlignment="Center"/>
              <StackPanel Grid.Column="1" Orientation="Horizontal">
                <Button x:Name="LocalMcpProbeButton" MinWidth="78" IsEnabled="False"><TextBlock Text="检测"/></Button>
                <Button x:Name="LocalMcpLoadButton" MinWidth="78" Margin="8,0,0,0" IsEnabled="False" Style="{StaticResource PrimaryButtonStyle}"><TextBlock Text="加载"/></Button>
                <Button x:Name="LocalMcpUnloadButton" MinWidth="78" Margin="8,0,0,0" IsEnabled="False" Style="{StaticResource DangerButtonStyle}" Visibility="Collapsed"><TextBlock Text="卸载"/></Button>
              </StackPanel>
            </Grid>
          </Grid>
        </Border>
      </Popup>
    </Grid>

    <Border Grid.Row="1" Style="{StaticResource PanelBorderStyle}" Padding="14,12" Margin="0,0,0,12">
      <Grid>
        <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
        <Grid Grid.Row="0" Margin="2,0,2,9">
          <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
          <TextBlock Text="连接链路" FontSize="12" FontWeight="SemiBold" Foreground="#475467"/>
          <WrapPanel Grid.Column="1">
            <TextBlock x:Name="StateValue" Text="读取中…" Margin="0,0,14,0" Foreground="#667085" FontSize="11"/>
            <TextBlock x:Name="PidValue" Margin="0,0,14,0" Foreground="#98A2B3" FontSize="11"/>
            <TextBlock x:Name="PortValue" Margin="0,0,14,0" Foreground="#98A2B3" FontSize="11"/>
            <TextBlock x:Name="StartedValue" Foreground="#98A2B3" FontSize="11"/>
          </WrapPanel>
        </Grid>
        <Grid Grid.Row="1">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*"/><ColumnDefinition Width="26"/>
            <ColumnDefinition Width="*"/><ColumnDefinition Width="26"/>
            <ColumnDefinition Width="*"/><ColumnDefinition Width="26"/>
            <ColumnDefinition Width="*"/><ColumnDefinition Width="26"/>
            <ColumnDefinition Width="*"/>
          </Grid.ColumnDefinitions>

          <Border Grid.Column="0" Background="#FAFBFC" BorderBrush="#E6E9EE" BorderThickness="1" CornerRadius="7" Padding="10,10">
            <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="34"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
              <Border Width="30" Height="30" CornerRadius="15" Background="#EAF2FF"><Image x:Name="ChatGptLogoImage" Width="20" Height="20" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality" HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
              <StackPanel Grid.Column="1" Margin="8,0,0,0"><TextBlock Text="ChatGPT" FontWeight="SemiBold" Foreground="#344054"/><TextBlock Text="MCP Client" Foreground="#667085" FontSize="11" Margin="0,3,0,0"/><TextBlock Text="Developer Mode" Foreground="#98A2B3" FontSize="10" Margin="0,2,0,0"/></StackPanel>
            </Grid>
          </Border>
          <Grid Grid.Column="1" VerticalAlignment="Center"><Border Height="1" Background="#C9D2DC"/><Border Background="#FFFFFF" HorizontalAlignment="Center" Padding="5,3"><Path Data="M 0,0 L 4,4.5 L 0,9" Width="5" Height="9" Stretch="Fill" Stroke="#98A2B3" StrokeThickness="1.35" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"/></Border></Grid>

          <Border Grid.Column="2" Background="#FAFBFC" BorderBrush="#E6E9EE" BorderThickness="1" CornerRadius="7" Padding="10,10">
            <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="34"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
              <Border Width="30" Height="30" CornerRadius="15" Background="#E7F1FB"><Image x:Name="TunnelLogoImage" Width="20" Height="20" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality" HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
              <StackPanel Grid.Column="1" Margin="8,0,0,0"><TextBlock Text="Secure Tunnel" FontWeight="SemiBold" Foreground="#344054"/><StackPanel Orientation="Horizontal" Margin="0,3,0,0"><Ellipse x:Name="TunnelDot" Width="7" Height="7" Fill="#98A2B3" Margin="0,0,6,0" VerticalAlignment="Center"/><TextBlock x:Name="TunnelValue" Text="读取中…" Foreground="#667085" FontSize="11"/></StackPanel><TextBlock x:Name="TunnelMeta" Text="OpenAI Secure MCP Tunnel" Foreground="#98A2B3" FontSize="10" Margin="0,2,0,0" TextTrimming="CharacterEllipsis"/></StackPanel>
            </Grid>
          </Border>
          <Grid Grid.Column="3" VerticalAlignment="Center"><Border Height="1" Background="#C9D2DC"/><Border Background="#FFFFFF" HorizontalAlignment="Center" Padding="5,3"><Path Data="M 0,0 L 4,4.5 L 0,9" Width="5" Height="9" Stretch="Fill" Stroke="#98A2B3" StrokeThickness="1.35" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"/></Border></Grid>

          <Border Grid.Column="4" Background="#FAFBFC" BorderBrush="#E6E9EE" BorderThickness="1" CornerRadius="7" Padding="10,10">
            <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="34"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
              <Border Width="30" Height="30" CornerRadius="15" Background="#EDF6EC"><Image x:Name="McpLogoImage" Width="20" Height="20" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality" HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
              <StackPanel Grid.Column="1" Margin="8,0,0,0"><TextBlock Text="MCP" FontWeight="SemiBold" Foreground="#344054"/><StackPanel Orientation="Horizontal" Margin="0,3,0,0"><Ellipse x:Name="McpDot" Width="7" Height="7" Fill="#98A2B3" Margin="0,0,6,0" VerticalAlignment="Center"/><TextBlock x:Name="McpValue" Text="读取中…" Foreground="#667085" FontSize="11"/></StackPanel><TextBlock x:Name="McpMeta" Text="HTTP /mcp" Foreground="#98A2B3" FontSize="10" Margin="0,2,0,0"/></StackPanel>
            </Grid>
          </Border>
          <Grid Grid.Column="5" VerticalAlignment="Center"><Border Height="1" Background="#C9D2DC"/><Border Background="#FFFFFF" HorizontalAlignment="Center" Padding="5,3"><Path Data="M 0,0 L 4,4.5 L 0,9" Width="5" Height="9" Stretch="Fill" Stroke="#98A2B3" StrokeThickness="1.35" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"/></Border></Grid>

          <Border Grid.Column="6" Background="#FAFBFC" BorderBrush="#E6E9EE" BorderThickness="1" CornerRadius="7" Padding="10,10">
            <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="34"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
              <Border Width="30" Height="30" CornerRadius="15" Background="#EEF4FF"><Image x:Name="McpBridgeLogoImage" Width="20" Height="20" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality" HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
              <StackPanel Grid.Column="1" Margin="8,0,0,0"><TextBlock Text="MCP Bridge" FontWeight="SemiBold" Foreground="#344054"/><StackPanel Orientation="Horizontal" Margin="0,3,0,0"><Ellipse x:Name="BridgeDot" Width="7" Height="7" Fill="#98A2B3" Margin="0,0,6,0" VerticalAlignment="Center"/><TextBlock x:Name="BridgeValue" Text="读取中…" Foreground="#667085" FontSize="11"/></StackPanel><TextBlock x:Name="BridgeMeta" Text="127.0.0.1" Foreground="#98A2B3" FontSize="10" Margin="0,2,0,0"/></StackPanel>
            </Grid>
          </Border>
          <Grid Grid.Column="7" VerticalAlignment="Center"><Border Height="1" Background="#C9D2DC"/><Border Background="#FFFFFF" HorizontalAlignment="Center" Padding="5,3"><Path Data="M 0,0 L 4,4.5 L 0,9" Width="5" Height="9" Stretch="Fill" Stroke="#98A2B3" StrokeThickness="1.35" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round"/></Border></Grid>

          <Border Grid.Column="8" Background="#FAFBFC" BorderBrush="#E6E9EE" BorderThickness="1" CornerRadius="7" Padding="10,10">
            <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="34"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
              <Border Width="30" Height="30" CornerRadius="15" Background="#ECFDF3"><Image x:Name="CodexDesktopLogoImage" Width="20" Height="20" Stretch="Uniform" RenderOptions.BitmapScalingMode="HighQuality" HorizontalAlignment="Center" VerticalAlignment="Center"/></Border>
              <StackPanel Grid.Column="1" Margin="8,0,0,0"><TextBlock Text="Codex Desktop" FontWeight="SemiBold" Foreground="#344054"/><StackPanel Orientation="Horizontal" Margin="0,3,0,0"><Ellipse x:Name="CodexDot" Width="7" Height="7" Fill="#98A2B3" Margin="0,0,6,0" VerticalAlignment="Center"/><TextBlock x:Name="CodexValue" Text="读取中…" Foreground="#667085" FontSize="11"/></StackPanel><TextBlock x:Name="CodexMeta" Text="Desktop IPC" Foreground="#98A2B3" FontSize="10" Margin="0,2,0,0"/></StackPanel>
            </Grid>
          </Border>
        </Grid>
        <TextBlock x:Name="ErrorValue" Grid.Row="2" Visibility="Collapsed" Margin="2,8,2,0" TextWrapping="Wrap" Foreground="#B42318" FontWeight="SemiBold"/>
      </Grid>
    </Border>

    <Grid Grid.Row="2" Margin="0,0,0,12">
      <Grid.ColumnDefinitions><ColumnDefinition Width="330"/><ColumnDefinition Width="8"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>

      <Border Grid.Column="0" Style="{StaticResource PanelBorderStyle}" Padding="0">
        <Grid>
          <Grid.RowDefinitions><RowDefinition Height="52"/><RowDefinition Height="*"/></Grid.RowDefinitions>
          <Grid Grid.Row="0" Margin="14,0,10,0">
            <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
            <StackPanel VerticalAlignment="Center"><TextBlock Text="项目 / Module" FontSize="14" FontWeight="SemiBold" Foreground="#344054"/><TextBlock Text="Workspace 与当前 Codex 工作分类" FontSize="10" Foreground="#98A2B3" Margin="0,2,0,0"/></StackPanel>
            <Button x:Name="AddWorkspaceButton" Grid.Column="1" Width="32" Height="30" Padding="0" ToolTip="添加项目" VerticalAlignment="Center"><Path Width="17" Height="17" Stretch="Uniform" Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType={x:Type Button}}}" Data="M10 2.5C10.2761 2.5 10.5 2.72386 10.5 3V9.5H17C17.2761 9.5 17.5 9.72386 17.5 10C17.5 10.2761 17.2761 10.5 17 10.5H10.5V17C10.5 17.2761 10.2761 17.5 10 17.5C9.72386 17.5 9.5 17.2761 9.5 17V10.5H3C2.72386 10.5 2.5 10.2761 2.5 10C2.5 9.72386 2.72386 9.5 3 9.5H9.5V3C9.5 2.72386 9.72386 2.5 10 2.5Z"/></Button>
          </Grid>
          <Border Grid.Row="0" VerticalAlignment="Bottom" Height="1" Background="#EAECF0"/>
          <TreeView x:Name="ProjectTree" Grid.Row="1" BorderThickness="0" Background="Transparent" Padding="4,8,6,8" HorizontalContentAlignment="Stretch" ScrollViewer.HorizontalScrollBarVisibility="Disabled">
            <TreeView.Resources>
              <SolidColorBrush x:Key="{x:Static SystemColors.HighlightBrushKey}" Color="Transparent"/>
              <SolidColorBrush x:Key="{x:Static SystemColors.HighlightTextBrushKey}" Color="#1D2939"/>
              <Style x:Key="CompactTreeExpanderStyle" TargetType="{x:Type ToggleButton}">
                <Setter Property="Width" Value="12"/>
                <Setter Property="Height" Value="24"/>
                <Setter Property="Padding" Value="0"/>
                <Setter Property="Margin" Value="0"/>
                <Setter Property="Focusable" Value="False"/>
                <Setter Property="Background" Value="Transparent"/>
                <Setter Property="BorderThickness" Value="0"/>
                <Setter Property="Template">
                  <Setter.Value>
                    <ControlTemplate TargetType="{x:Type ToggleButton}">
                      <Grid Background="Transparent">
                        <Path x:Name="Chevron" Data="M 0,0 L 4,4.5 L 0,9" Width="5" Height="9" Stretch="Fill" Stroke="#667085" StrokeThickness="1.35" StrokeStartLineCap="Round" StrokeEndLineCap="Round" StrokeLineJoin="Round" HorizontalAlignment="Center" VerticalAlignment="Center" RenderTransformOrigin="0.5,0.5">
                          <Path.RenderTransform><RotateTransform x:Name="ChevronRotate" Angle="0"/></Path.RenderTransform>
                        </Path>
                      </Grid>
                      <ControlTemplate.Triggers>
                        <Trigger Property="IsChecked" Value="True">
                          <Trigger.EnterActions>
                            <BeginStoryboard><Storyboard><DoubleAnimation Storyboard.TargetName="ChevronRotate" Storyboard.TargetProperty="Angle" To="90" Duration="0:0:0.12"/></Storyboard></BeginStoryboard>
                          </Trigger.EnterActions>
                          <Trigger.ExitActions>
                            <BeginStoryboard><Storyboard><DoubleAnimation Storyboard.TargetName="ChevronRotate" Storyboard.TargetProperty="Angle" To="0" Duration="0:0:0.12"/></Storyboard></BeginStoryboard>
                          </Trigger.ExitActions>
                        </Trigger>
                        <Trigger Property="IsMouseOver" Value="True"><Setter TargetName="Chevron" Property="Stroke" Value="#0F6CBD"/></Trigger>
                      </ControlTemplate.Triggers>
                    </ControlTemplate>
                  </Setter.Value>
                </Setter>
              </Style>
              <Style TargetType="{x:Type TreeViewItem}">
                <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
                <Setter Property="Padding" Value="0"/>
                <Setter Property="Margin" Value="0"/>
                <Setter Property="Template">
                  <Setter.Value>
                    <ControlTemplate TargetType="{x:Type TreeViewItem}">
                      <Grid>
                        <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
                        <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
                        <ToggleButton x:Name="Expander" Grid.Row="0" Grid.Column="0" Style="{StaticResource CompactTreeExpanderStyle}" IsChecked="{Binding IsExpanded, RelativeSource={RelativeSource TemplatedParent}}" ClickMode="Press"/>
                        <ContentPresenter x:Name="PART_Header" Grid.Row="0" Grid.Column="1" ContentSource="Header" HorizontalAlignment="{TemplateBinding HorizontalContentAlignment}"/>
                        <ItemsPresenter x:Name="ItemsHost" Grid.Row="1" Grid.Column="1"/>
                      </Grid>
                      <ControlTemplate.Triggers>
                        <Trigger Property="IsExpanded" Value="False"><Setter TargetName="ItemsHost" Property="Visibility" Value="Collapsed"/></Trigger>
                        <Trigger Property="HasItems" Value="False"><Setter TargetName="Expander" Property="Visibility" Value="Collapsed"/></Trigger>
                        <Trigger Property="IsEnabled" Value="False"><Setter Property="Opacity" Value="0.56"/></Trigger>
                      </ControlTemplate.Triggers>
                    </ControlTemplate>
                  </Setter.Value>
                </Setter>
              </Style>
              <DataTemplate x:Key="TreeRowTemplate">
                <Border x:Name="TreeRowSurface" MinWidth="260" CornerRadius="4" Padding="4,4" Margin="0,1,2,1" RenderTransformOrigin="0.5,0.5">
                  <Border.RenderTransform><TranslateTransform X="0"/></Border.RenderTransform>
                  <Border.Style>
                    <Style TargetType="Border">
                      <Setter Property="Background" Value="Transparent"/>
                      <Style.Triggers>
                        <Trigger Property="IsMouseOver" Value="True"><Setter Property="Background" Value="#F4F7FA"/></Trigger>
                        <EventTrigger RoutedEvent="MouseEnter">
                          <BeginStoryboard>
                            <Storyboard>
                              <DoubleAnimation Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.X)" To="1" Duration="0:0:0.11">
                                <DoubleAnimation.EasingFunction><QuadraticEase EasingMode="EaseOut"/></DoubleAnimation.EasingFunction>
                              </DoubleAnimation>
                            </Storyboard>
                          </BeginStoryboard>
                        </EventTrigger>
                        <EventTrigger RoutedEvent="MouseLeave">
                          <BeginStoryboard>
                            <Storyboard>
                              <DoubleAnimation Storyboard.TargetProperty="(UIElement.RenderTransform).(TranslateTransform.X)" To="0" Duration="0:0:0.09">
                                <DoubleAnimation.EasingFunction><QuadraticEase EasingMode="EaseOut"/></DoubleAnimation.EasingFunction>
                              </DoubleAnimation>
                            </Storyboard>
                          </BeginStoryboard>
                        </EventTrigger>
                      </Style.Triggers>
                    </Style>
                  </Border.Style>
                  <Grid>
                    <Grid.ColumnDefinitions><ColumnDefinition Width="3"/><ColumnDefinition Width="24"/><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                    <Border x:Name="TreeSelectionAccent" Grid.Column="0" Width="3" Background="#0F6CBD" CornerRadius="2" Visibility="Collapsed"/>
                    <Path Grid.Column="1" Data="{Binding iconData}" Fill="{Binding iconBrush}" Stroke="Transparent" Width="16" Height="16" Stretch="Uniform" VerticalAlignment="Center" HorizontalAlignment="Center"/>
                    <TextBlock Grid.Column="2" Text="{Binding title}" Foreground="{Binding titleBrush}" FontWeight="{Binding titleWeight}" VerticalAlignment="Center" TextTrimming="CharacterEllipsis"/>
                    <Border Grid.Column="3" Background="{Binding badgeBrush}" CornerRadius="4" Padding="6,2" Margin="8,0,0,0" VerticalAlignment="Center" Visibility="{Binding badgeVisibility}">
                      <TextBlock Text="{Binding kindText}" Foreground="{Binding badgeForeground}" FontSize="10"/>
                    </Border>
                    <TextBlock Grid.Column="4" Text="{Binding stateText}" Foreground="{Binding stateBrush}" FontSize="10" Margin="8,0,2,0" VerticalAlignment="Center"/>
                  </Grid>
                </Border>
                <DataTemplate.Triggers>
                  <DataTrigger Binding="{Binding IsSelected, RelativeSource={RelativeSource AncestorType={x:Type TreeViewItem}}}" Value="True">
                    <Setter TargetName="TreeRowSurface" Property="Background" Value="#EAF2FF"/>
                    <Setter TargetName="TreeSelectionAccent" Property="Visibility" Value="Visible"/>
                  </DataTrigger>
                </DataTemplate.Triggers>
              </DataTemplate>
            </TreeView.Resources>
          </TreeView>
        </Grid>
      </Border>

      <GridSplitter Grid.Column="1" Width="8" HorizontalAlignment="Stretch" Background="Transparent"/>

      <Border Grid.Column="2" Style="{StaticResource PanelBorderStyle}" Padding="20,16">
        <Grid>
          <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="1"/><RowDefinition Height="*"/></Grid.RowDefinitions>
          <Grid Grid.Row="0" Margin="0,0,0,14">
            <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
            <StackPanel>
              <StackPanel Orientation="Horizontal">
                <TextBlock x:Name="SelectionStatus" Text="请选择一个项目" FontSize="19" FontWeight="SemiBold" Foreground="#1D2939" VerticalAlignment="Center"/>
                <Border x:Name="ModuleTypeBadge" Visibility="Collapsed" Background="#EEF3F8" CornerRadius="4" Padding="7,2" Margin="10,1,0,0" VerticalAlignment="Center">
                  <TextBlock x:Name="ModuleSelectionTitle" Text="长期 Module" Foreground="#60758F" FontSize="10" FontWeight="SemiBold"/>
                </Border>
              </StackPanel>
              <TextBlock Text="当前选择对象的详细信息" FontSize="11" Foreground="#98A2B3" Margin="0,3,0,0"/>
            </StackPanel>
            <TextBlock x:Name="ConfigStatus" Grid.Column="1" Foreground="#667085" VerticalAlignment="Center"/>
          </Grid>
          <Border Grid.Row="1" Background="#EAECF0"/>

          <Grid x:Name="ProjectActions" Grid.Row="2" Margin="0,16,0,0">
            <Grid.RowDefinitions><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
            <ScrollViewer Grid.Row="0" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
              <Grid Margin="0,0,8,8">
                <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
                <Grid Grid.Row="0" Margin="0,0,0,14">
                  <Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                  <TextBlock Text="项目配置" FontSize="13" FontWeight="SemiBold" Foreground="#344054" VerticalAlignment="Center"/>
                  <Border x:Name="ProjectModeBadge" Grid.Column="1" Background="#F2F4F7" CornerRadius="4" Padding="7,2" VerticalAlignment="Center" Visibility="Collapsed">
                    <TextBlock x:Name="ProjectModeText" Text="只读" Foreground="#667085" FontSize="10" FontWeight="SemiBold"/>
                  </Border>
                </Grid>

                <Grid x:Name="ProjectReadOnlyPanel" Grid.Row="1">
                  <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
                  <Grid Grid.Row="0" Margin="0,0,0,14"><Grid.ColumnDefinitions><ColumnDefinition Width="110"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="Workspace ID" Foreground="#667085"/><TextBlock x:Name="ProjectIdValue" Grid.Column="1" Foreground="#344054" FontWeight="SemiBold"/></Grid>
                  <Grid Grid.Row="1" Margin="0,0,0,14"><Grid.ColumnDefinitions><ColumnDefinition Width="110"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="本地路径" Foreground="#667085"/><TextBlock x:Name="ProjectPathValue" Grid.Column="1" Foreground="#344054" FontFamily="Consolas" TextTrimming="CharacterEllipsis"/></Grid>
                  <Grid Grid.Row="2" Margin="0,0,0,14"><Grid.ColumnDefinitions><ColumnDefinition Width="110"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="权限模式" Foreground="#667085"/><TextBlock x:Name="ProjectModeValue" Grid.Column="1" Foreground="#344054" FontWeight="SemiBold"/></Grid>
                  <Grid Grid.Row="3"><Grid.ColumnDefinitions><ColumnDefinition Width="110"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="Codex Modules" Foreground="#667085"/><TextBlock x:Name="ProjectModuleCountValue" Grid.Column="1" Foreground="#344054"/></Grid>
                </Grid>

                <Grid x:Name="ProjectEditPanel" Grid.Row="1" Visibility="Collapsed">
                  <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
                  <Grid Grid.Row="0" Margin="0,0,0,12">
                    <Grid.ColumnDefinitions><ColumnDefinition Width="105"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
                    <TextBlock Text="Workspace ID" Foreground="#667085" VerticalAlignment="Center"/>
                    <TextBox x:Name="ProjectIdBox" Grid.Column="1"/>
                  </Grid>
                  <Grid Grid.Row="1" Margin="0,0,0,12">
                    <Grid.ColumnDefinitions><ColumnDefinition Width="105"/><ColumnDefinition Width="*"/><ColumnDefinition Width="8"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
                    <TextBlock Text="本地路径" Foreground="#667085" VerticalAlignment="Center"/>
                    <TextBox x:Name="ProjectPathBox" Grid.Column="1"/>
                    <Button x:Name="BrowseWorkspaceButton" Grid.Column="3" MinWidth="76"><StackPanel Orientation="Horizontal"><Path Width="16" Height="16" Stretch="Uniform" Margin="0,0,6,0" Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType={x:Type Button}}}" Data="M3.00026 5.5V12.1041L4.50091 9.50488C5.03681 8.57668 6.02719 8.00488 7.09898 8.00488L15.0003 8.00488V7.5C15.0003 6.67157 14.3287 6 13.5003 6H9.50026C9.36765 6 9.24047 5.94732 9.1467 5.85355L7.4396 4.14645C7.34583 4.05268 7.21865 4 7.08604 4H4.50026C3.67183 4 3.00026 4.67157 3.00026 5.5ZM4.28361 15.9845C4.35498 15.9947 4.42844 16 4.50373 16H13.9012C14.6157 16 15.276 15.6188 15.6332 15L17.7955 11.2549C18.3728 10.2549 17.6511 9.00488 16.4964 9.00488L7.09898 9.00488C6.38445 9.00488 5.7242 9.38608 5.36694 10.0049L3.20469 13.75C2.78223 14.4817 3.0553 15.3473 3.68462 15.7591C3.86197 15.8742 4.06517 15.9529 4.28361 15.9845ZM2.00026 14.4607V5.5C2.00026 4.11929 3.11955 3 4.50026 3H7.08604C7.48387 3 7.8654 3.15804 8.1467 3.43934L9.70736 5H13.5003C14.881 5 16.0003 6.11929 16.0003 7.5V8.00488H16.4964C18.4209 8.00488 19.6237 10.0882 18.6615 11.7549L16.4992 15.5C15.9633 16.4282 14.973 17 13.9012 17H4.50026C4.4378 17 4.37588 16.9977 4.31457 16.9932C3.75344 16.9527 3.26124 16.7329 2.87665 16.4011C2.36561 15.9642 2.03283 15.3249 2.00252 14.6073C2.00031 14.5586 1.99955 14.5097 2.00026 14.4607Z"/><TextBlock Text="浏览…" VerticalAlignment="Center"/></StackPanel></Button>
                  </Grid>
                  <Grid Grid.Row="2">
                    <Grid.ColumnDefinitions><ColumnDefinition Width="105"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
                    <TextBlock Text="权限模式" Foreground="#667085" VerticalAlignment="Center"/>
                    <ComboBox x:Name="ProjectModeBox" Grid.Column="1">
                      <ComboBoxItem Content="只读（readonly）" Tag="readonly"/>
                      <ComboBoxItem Content="普通工作区（workspace）" Tag="workspace"/>
                      <ComboBoxItem Content="可信开发（trusted-dev）" Tag="trusted-dev"/>
                      <ComboBoxItem Content="交接模式（handoff）" Tag="handoff"/>
                    </ComboBox>
                  </Grid>
                </Grid>
              </Grid>
            </ScrollViewer>

            <Border x:Name="ProjectButtonBar" Grid.Row="1" BorderBrush="#EAECF0" BorderThickness="0,1,0,0" Padding="0,12,0,0" Visibility="Collapsed">
              <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
                <Button x:Name="DeleteWorkspaceButton" MinWidth="104" Margin="0,0,8,0" Style="{StaticResource DangerButtonStyle}"><StackPanel Orientation="Horizontal"><Path Width="16" Height="16" Stretch="Uniform" Margin="0,0,7,0" Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType={x:Type Button}}}" Data="M8.5 4H11.5C11.5 3.17157 10.8284 2.5 10 2.5C9.17157 2.5 8.5 3.17157 8.5 4ZM7.5 4C7.5 2.61929 8.61929 1.5 10 1.5C11.3807 1.5 12.5 2.61929 12.5 4H17.5C17.7761 4 18 4.22386 18 4.5C18 4.77614 17.7761 5 17.5 5H16.4456L15.2521 15.3439C15.0774 16.8576 13.7957 18 12.2719 18H7.72813C6.20431 18 4.92256 16.8576 4.7479 15.3439L3.55437 5H2.5C2.22386 5 2 4.77614 2 4.5C2 4.22386 2.22386 4 2.5 4H7.5ZM5.74131 15.2292C5.85775 16.2384 6.71225 17 7.72813 17H12.2719C13.2878 17 14.1422 16.2384 14.2587 15.2292L15.439 5H4.56101L5.74131 15.2292ZM8.5 7.5C8.77614 7.5 9 7.72386 9 8V14C9 14.2761 8.77614 14.5 8.5 14.5C8.22386 14.5 8 14.2761 8 14V8C8 7.72386 8.22386 7.5 8.5 7.5ZM12 8C12 7.72386 11.7761 7.5 11.5 7.5C11.2239 7.5 11 7.72386 11 8V14C11 14.2761 11.2239 14.5 11.5 14.5C11.7761 14.5 12 14.2761 12 14V8Z"/><TextBlock Text="删除项目" VerticalAlignment="Center"/></StackPanel></Button>
                <Button x:Name="SaveConfigButton" MinWidth="104" Style="{StaticResource PrimaryButtonStyle}"><StackPanel Orientation="Horizontal"><Path Width="16" Height="16" Stretch="Uniform" Margin="0,0,7,0" Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType={x:Type Button}}}" Data="M3 5C3 3.89543 3.89543 3 5 3H13.3787C13.9091 3 14.4178 3.21071 14.7929 3.58579L16.4142 5.20711C16.7893 5.58218 17 6.09089 17 6.62132V15C17 16.1046 16.1046 17 15 17H5C3.89543 17 3 16.1046 3 15V5ZM5 4C4.44772 4 4 4.44772 4 5V15C4 15.5523 4.44772 16 5 16L5 11.5C5 10.6716 5.67157 10 6.5 10H13.5C14.3284 10 15 10.6716 15 11.5V16C15.5523 16 16 15.5523 16 15V6.62132C16 6.3561 15.8946 6.10175 15.7071 5.91421L14.0858 4.29289C13.8983 4.10536 13.6439 4 13.3787 4L13 4V6.5C13 7.32843 12.3284 8 11.5 8L7.5 8C6.67157 8 6 7.32843 6 6.5L6 4H5ZM7 4L7 6.5C7 6.77614 7.22386 7 7.5 7L11.5 7C11.7761 7 12 6.77614 12 6.5V4L7 4ZM14 16V11.5C14 11.2239 13.7761 11 13.5 11H6.5C6.22386 11 6 11.2239 6 11.5V16H14Z"/><TextBlock Text="保存配置" VerticalAlignment="Center"/></StackPanel></Button>
              </StackPanel>
            </Border>
          </Grid>

          <Grid x:Name="ModuleActions" Grid.Row="2" Margin="0,16,0,0" Visibility="Collapsed">
            <Grid.RowDefinitions><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
            <ScrollViewer Grid.Row="0" VerticalScrollBarVisibility="Auto" HorizontalScrollBarVisibility="Disabled">
              <Grid Margin="0,0,8,8">
                <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
                <Grid Grid.Row="0" Margin="0,0,0,10"><Grid.ColumnDefinitions><ColumnDefinition Width="120"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="Module ID" Foreground="#667085"/><TextBlock x:Name="ModuleIdValue" Grid.Column="1" Foreground="#344054" FontFamily="Consolas" TextTrimming="CharacterEllipsis"/></Grid>
                <Grid Grid.Row="1" Margin="0,0,0,10"><Grid.ColumnDefinitions><ColumnDefinition Width="120"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="绑定状态" Foreground="#667085"/><TextBlock x:Name="ModuleBindingValue" Grid.Column="1" Foreground="#344054"/></Grid>
                <Grid Grid.Row="2" Margin="0,0,0,10"><Grid.ColumnDefinitions><ColumnDefinition Width="120"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="Codex Thread" Foreground="#667085"/><TextBlock x:Name="ThreadNameValue" Grid.Column="1" Foreground="#344054" TextTrimming="CharacterEllipsis"/></Grid>
                <Grid Grid.Row="3" Margin="0,0,0,10"><Grid.ColumnDefinitions><ColumnDefinition Width="120"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="Thread ID" Foreground="#667085"/><TextBlock x:Name="ThreadIdValue" Grid.Column="1" Foreground="#475467" FontFamily="Consolas" TextTrimming="CharacterEllipsis"/></Grid>
                <Grid Grid.Row="4"><Grid.ColumnDefinitions><ColumnDefinition Width="120"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions><TextBlock Text="Desktop Owner" Foreground="#667085"/><TextBlock x:Name="OwnerValue" Grid.Column="1" Foreground="#344054"/></Grid>
                <TextBlock x:Name="CodexBindingStatus" Grid.Row="5" Visibility="Collapsed"/>
              </Grid>
            </ScrollViewer>
            <Border Grid.Row="1" BorderBrush="#EAECF0" BorderThickness="0,1,0,0" Padding="0,12,0,0">
              <StackPanel Orientation="Horizontal" HorizontalAlignment="Right">
                <Button x:Name="RefreshCodexButton" MinWidth="104" Margin="0,0,8,0"><StackPanel Orientation="Horizontal"><Path Width="16" Height="16" Stretch="Uniform" Margin="0,0,7,0" Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType={x:Type Button}}}" Data="M4 10C4 6.68629 6.68629 4 10 4C11.7766 4 13.3732 4.77191 14.4723 6H12.5C12.2239 6 12 6.22386 12 6.5C12 6.77614 12.2239 7 12.5 7H15.5C15.7761 7 16 6.77614 16 6.5V3.5C16 3.22386 15.7761 3 15.5 3C15.2239 3 15 3.22386 15 3.5V5.10109C13.7299 3.80499 11.9591 3 10 3C6.13401 3 3 6.13401 3 10C3 13.866 6.13401 17 10 17C13.866 17 17 13.866 17 10C17 9.8191 16.9931 9.6397 16.9796 9.46207C16.9587 9.18673 16.7185 8.98049 16.4431 9.00144C16.1678 9.02239 15.9615 9.26258 15.9825 9.53793C15.9941 9.69034 16 9.84443 16 10C16 13.3137 13.3137 16 10 16C6.68629 16 4 13.3137 4 10Z"/><TextBlock Text="刷新绑定" VerticalAlignment="Center"/></StackPanel></Button>
                <Button x:Name="UnbindCodexButton" MinWidth="104" Style="{StaticResource DangerButtonStyle}"><StackPanel Orientation="Horizontal"><Path Width="16" Height="16" Stretch="Uniform" Margin="0,0,7,0" Fill="{Binding Foreground, RelativeSource={RelativeSource AncestorType={x:Type Button}}}" Data="M8 4C8.27614 4 8.5 4.22386 8.5 4.5C8.5 4.74546 8.32312 4.94961 8.08988 4.99194L8 5H6C4.34315 5 3 6.34315 3 8C3 9.59058 4.23784 10.892 5.80275 10.9936L6 11H8C8.27614 11 8.5 11.2239 8.5 11.5C8.5 11.7455 8.32312 11.9496 8.08988 11.9919L8 12H6C3.79086 12 2 10.2091 2 8C2 5.8645 3.67346 4.11986 5.78053 4.00592L6 4H8ZM14 4C16.2091 4 18 5.79086 18 8C18 8.68859 17.826 9.33654 17.5196 9.90229C17.242 9.71965 16.947 9.56146 16.6375 9.43079C16.8687 9.00552 17 8.5181 17 8C17 6.40942 15.7622 5.10795 14.1973 5.00638L14 5H12C11.7239 5 11.5 4.77614 11.5 4.5C11.5 4.25454 11.6769 4.05039 11.9101 4.00806L12 4H14ZM6 7.5H14C14.2761 7.5 14.5 7.72386 14.5 8C14.5 8.24546 14.3231 8.44961 14.0899 8.49194L14 8.5H6C5.72386 8.5 5.5 8.27614 5.5 8C5.5 7.75454 5.67688 7.55039 5.91012 7.50806L6 7.5ZM19 14.5C19 16.9853 16.9853 19 14.5 19C12.0147 19 10 16.9853 10 14.5C10 12.0147 12.0147 10 14.5 10C16.9853 10 19 12.0147 19 14.5ZM16.2678 13.4393C16.463 13.2441 16.463 12.9275 16.2678 12.7322C16.0725 12.537 15.7559 12.537 15.5607 12.7322L14.5 13.7929L13.4393 12.7322C13.2441 12.537 12.9275 12.537 12.7322 12.7322C12.537 12.9275 12.537 13.2441 12.7322 13.4393L13.7929 14.5L12.7322 15.5607C12.537 15.7559 12.537 16.0725 12.7322 16.2678C12.9275 16.463 13.2441 16.463 13.4393 16.2678L14.5 15.2071L15.5607 16.2678C15.7559 16.463 16.0725 16.463 16.2678 16.2678C16.463 16.0725 16.463 15.7559 16.2678 15.5607L15.2071 14.5L16.2678 13.4393Z"/><TextBlock Text="解除绑定" VerticalAlignment="Center"/></StackPanel></Button>
              </StackPanel>
            </Border>
          </Grid>
        </Grid>
      </Border>
    </Grid>

    <Expander x:Name="LogExpander" Grid.Row="3" Header="运行日志" IsExpanded="True" Foreground="#344054" FontWeight="SemiBold">
      <Border Style="{StaticResource PanelBorderStyle}" Margin="0,6,0,0" Padding="0" Height="152">
        <ListView x:Name="LogList" BorderThickness="0" Background="White" FontWeight="Normal" ScrollViewer.HorizontalScrollBarVisibility="Disabled">
          <ListView.ItemContainerStyle>
            <Style TargetType="ListViewItem">
              <Setter Property="HorizontalContentAlignment" Value="Stretch"/>
              <Setter Property="Padding" Value="2,3"/>
              <Setter Property="Foreground" Value="#475467"/>
              <Style.Triggers>
                <DataTrigger Binding="{Binding isWarning}" Value="True"><Setter Property="Background" Value="#FFFAEB"/><Setter Property="Foreground" Value="#B54708"/></DataTrigger>
                <DataTrigger Binding="{Binding isError}" Value="True"><Setter Property="Background" Value="#FFF4F2"/><Setter Property="Foreground" Value="#B42318"/></DataTrigger>
              </Style.Triggers>
            </Style>
          </ListView.ItemContainerStyle>
          <ListView.View>
            <GridView AllowsColumnReorder="False">
              <GridViewColumn Header="时间" Width="92" DisplayMemberBinding="{Binding time}"/>
              <GridViewColumn Header="级别" Width="72" DisplayMemberBinding="{Binding level}"/>
              <GridViewColumn Header="来源" Width="92" DisplayMemberBinding="{Binding source}"/>
              <GridViewColumn Header="消息" Width="760" DisplayMemberBinding="{Binding message}"/>
            </GridView>
          </ListView.View>
        </ListView>
      </Border>
    </Expander>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$titleLogoImage = $window.FindName('TitleLogoImage'); $chatGptLogoImage = $window.FindName('ChatGptLogoImage'); $tunnelLogoImage = $window.FindName('TunnelLogoImage'); $mcpLogoImage = $window.FindName('McpLogoImage'); $mcpBridgeLogoImage = $window.FindName('McpBridgeLogoImage'); $codexDesktopLogoImage = $window.FindName('CodexDesktopLogoImage')
$startButton = $window.FindName('StartButton'); $stopButton = $window.FindName('StopButton')
$localMcpButton = $window.FindName('LocalMcpButton'); $localMcpCountText = $window.FindName('LocalMcpCountText'); $localMcpPopup = $window.FindName('LocalMcpPopup'); $localMcpList = $window.FindName('LocalMcpList'); $localMcpSummaryText = $window.FindName('LocalMcpSummaryText'); $localMcpEmptyText = $window.FindName('LocalMcpEmptyText'); $localMcpMessage = $window.FindName('LocalMcpMessage'); $localMcpProbeButton = $window.FindName('LocalMcpProbeButton'); $localMcpLoadButton = $window.FindName('LocalMcpLoadButton'); $localMcpUnloadButton = $window.FindName('LocalMcpUnloadButton')
$bridgeValue = $window.FindName('BridgeValue'); $mcpValue = $window.FindName('McpValue'); $tunnelValue = $window.FindName('TunnelValue'); $codexValue = $window.FindName('CodexValue')
$bridgeDot = $window.FindName('BridgeDot'); $mcpDot = $window.FindName('McpDot'); $tunnelDot = $window.FindName('TunnelDot'); $codexDot = $window.FindName('CodexDot')
$bridgeMeta = $window.FindName('BridgeMeta'); $mcpMeta = $window.FindName('McpMeta'); $tunnelMeta = $window.FindName('TunnelMeta'); $codexMeta = $window.FindName('CodexMeta')
$overallStatusBadge = $window.FindName('OverallStatusBadge'); $overallStatusDot = $window.FindName('OverallStatusDot'); $overallStatusText = $window.FindName('OverallStatusText')
$stateValue = $window.FindName('StateValue'); $pidValue = $window.FindName('PidValue'); $portValue = $window.FindName('PortValue'); $startedValue = $window.FindName('StartedValue'); $errorValue = $window.FindName('ErrorValue'); $logList = $window.FindName('LogList')
$projectTree = $window.FindName('ProjectTree'); $treeRowTemplate = $projectTree.Resources['TreeRowTemplate']; $addWorkspaceButton = $window.FindName('AddWorkspaceButton'); $deleteWorkspaceButton = $window.FindName('DeleteWorkspaceButton'); $browseWorkspaceButton = $window.FindName('BrowseWorkspaceButton'); $saveConfigButton = $window.FindName('SaveConfigButton'); $configStatus = $window.FindName('ConfigStatus'); $selectionStatus = $window.FindName('SelectionStatus'); $projectActions = $window.FindName('ProjectActions'); $moduleActions = $window.FindName('ModuleActions'); $projectReadOnlyPanel = $window.FindName('ProjectReadOnlyPanel'); $projectEditPanel = $window.FindName('ProjectEditPanel'); $projectButtonBar = $window.FindName('ProjectButtonBar'); $projectModeBadge = $window.FindName('ProjectModeBadge'); $projectModeText = $window.FindName('ProjectModeText'); $projectIdValue = $window.FindName('ProjectIdValue'); $projectPathValue = $window.FindName('ProjectPathValue'); $projectModeValue = $window.FindName('ProjectModeValue'); $projectModuleCountValue = $window.FindName('ProjectModuleCountValue'); $projectIdBox = $window.FindName('ProjectIdBox'); $projectPathBox = $window.FindName('ProjectPathBox'); $projectModeBox = $window.FindName('ProjectModeBox'); $moduleSelectionTitle = $window.FindName('ModuleSelectionTitle')
$moduleTypeBadge = $window.FindName('ModuleTypeBadge'); $moduleIdValue = $window.FindName('ModuleIdValue'); $moduleBindingValue = $window.FindName('ModuleBindingValue'); $threadNameValue = $window.FindName('ThreadNameValue'); $threadIdValue = $window.FindName('ThreadIdValue'); $ownerValue = $window.FindName('OwnerValue')
$refreshCodexButton = $window.FindName('RefreshCodexButton'); $unbindCodexButton = $window.FindName('UnbindCodexButton'); $codexBindingStatus = $window.FindName('CodexBindingStatus')

function Load-LocalPng([string]$fileName) {
  $fullPath = [IO.Path]::Combine($AssetRoot, $fileName)
  if (-not [IO.File]::Exists($fullPath)) { throw ('UI 图标资源不存在：' + $fullPath) }
  $stream = [IO.File]::OpenRead($fullPath)
  try {
    $bitmap = New-Object Windows.Media.Imaging.BitmapImage
    $bitmap.BeginInit()
    $bitmap.CacheOption = [Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bitmap.StreamSource = $stream
    $bitmap.EndInit()
    $bitmap.Freeze()
    return $bitmap
  } finally {
    $stream.Dispose()
  }
}
$titleLogoImage.Source = (Load-LocalPng 'chatgpt-mcp-bridge.png')
$chatGptLogoImage.Source = (Load-LocalPng 'chatgpt.png')
$tunnelLogoImage.Source = (Load-LocalPng 'secure-tunnel.png')
$mcpLogoImage.Source = (Load-LocalPng 'mcp.png')
$mcpBridgeLogoImage.Source = (Load-LocalPng 'mcp-bridge.png')
$codexDesktopLogoImage.Source = (Load-LocalPng 'codex-desktop.png')

$brushConverter = [Windows.Media.BrushConverter]::new()
$green = $brushConverter.ConvertFromString('#178B4E'); $amber = $brushConverter.ConvertFromString('#B54708'); $red = $brushConverter.ConvertFromString('#D92D20'); $muted = $brushConverter.ConvertFromString('#98A2B3'); $textPrimary = $brushConverter.ConvertFromString('#344054'); $textSecondary = $brushConverter.ConvertFromString('#667085'); $accent = $brushConverter.ConvertFromString('#0F6CBD'); $moduleIconBrush = $brushConverter.ConvertFromString('#60758F'); $handoffBrush = $brushConverter.ConvertFromString('#7A5A9E')
$softGreen = $brushConverter.ConvertFromString('#ECFDF3'); $softAmber = $brushConverter.ConvertFromString('#FFF7ED'); $softRed = $brushConverter.ConvertFromString('#FEF3F2'); $softGray = $brushConverter.ConvertFromString('#F2F4F7'); $softBlue = $brushConverter.ConvertFromString('#EEF4FF'); $moduleLongTermBadge = $brushConverter.ConvertFromString('#EEF3F8'); $blueText = $brushConverter.ConvertFromString('#60758F')
 $projectIconGeometry = $window.Resources['IconProject']; $persistentModuleIconGeometry = $window.Resources['IconPersistentModule']; $temporaryModuleIconGeometry = $window.Resources['IconTemporaryModule']

$script:lastSnapshot = ''; $script:lastLogKey = ''; $script:lastConfigKey = ''; $script:lastTreeKey = ''; $script:busy = $false; $script:configDirty = $false; $script:currentState = 'stopped'; $script:updatingProjectEditor = $false
$script:workspaceTable = New-Object System.Data.DataTable
[void]$script:workspaceTable.Columns.Add('originalId', [string]); [void]$script:workspaceTable.Columns.Add('id', [string]); [void]$script:workspaceTable.Columns.Add('root', [string]); [void]$script:workspaceTable.Columns.Add('mode', [string])
$script:selectedModule = $null; $script:selectedProjectRow = $null; $script:selectedWorkspaceId = ''; $script:selectedModuleId = ''; $script:selectedLocalMcp = $null; $script:lastLocalMcpKey = ''

function Send-Command([string]$command) { $record = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds().ToString()) + '|' + $command; [IO.File]::WriteAllText($CommandPath, $record, [Text.Encoding]::UTF8) }
function Set-StateText($element, [string]$text, $brush) { $element.Text = $text; $element.Foreground = $brush }
function Set-StatusDot($dot, $brush) { if($null -ne $dot){$dot.Fill=$brush} }
function Set-OverallStatus([string]$text, $foreground, $background) { $overallStatusText.Text=$text; $overallStatusText.Foreground=$foreground; $overallStatusDot.Fill=$foreground; $overallStatusBadge.Background=$background }
function Get-ModeLabel([string]$mode) {
  switch($mode){
    'readonly' {'只读（readonly）'}
    'trusted-dev' {'可信开发（trusted-dev）'}
    'handoff' {'交接模式（handoff）'}
    default {'普通工作区（workspace）'}
  }
}
function Select-ModeItem([string]$mode) {
  foreach($item in $projectModeBox.Items){ if([string]$item.Tag -eq $mode){ $projectModeBox.SelectedItem=$item; return } }
  $projectModeBox.SelectedIndex=1
}
function Set-ConfigEnabled([bool]$enabled) {
  $projectIdBox.IsReadOnly = -not $enabled; $projectPathBox.IsReadOnly = -not $enabled; $projectModeBox.IsEnabled = $enabled
  $hasProject = $null -ne $script:selectedProjectRow
  $addWorkspaceButton.IsEnabled = $enabled; $deleteWorkspaceButton.IsEnabled = $enabled -and $hasProject; $browseWorkspaceButton.IsEnabled = $enabled -and $hasProject; $saveConfigButton.IsEnabled = $enabled -and $hasProject -and -not $script:busy
  $projectReadOnlyPanel.Visibility = if($enabled){'Collapsed'}else{'Visible'}; $projectEditPanel.Visibility = if($enabled){'Visible'}else{'Collapsed'}; $projectButtonBar.Visibility = if($enabled -and $hasProject){'Visible'}else{'Collapsed'}
  $projectModeBadge.Visibility = if($hasProject){'Visible'}else{'Collapsed'}
  if($hasProject){
    $mode=[string]$script:selectedProjectRow.mode
    $projectModeText.Text=Get-ModeLabel $mode
    if($mode -eq 'trusted-dev'){ $projectModeText.Foreground=$amber; $projectModeBadge.Background=$softAmber }
    elseif($mode -eq 'readonly'){ $projectModeText.Foreground=$textSecondary; $projectModeBadge.Background=$softGray }
    else{ $projectModeText.Foreground=$accent; $projectModeBadge.Background=$softBlue }
    $projectModeBadge.ToolTip=if($enabled){'Bridge 已停止，可以修改 Workspace 权限模式。'}else{'当前 Workspace 权限模式；停止 Bridge 后可以修改。'}
  }
}
function Show-ProjectActions($row) {
  $script:selectedModule=$null; $script:selectedModuleId=''; $script:selectedProjectRow=$row; $script:selectedWorkspaceId=if($null -ne $row){[string]$row.id}else{''}
  $projectActions.Visibility='Visible'; $moduleActions.Visibility='Collapsed'; $moduleTypeBadge.Visibility='Collapsed'
  $script:updatingProjectEditor=$true
  if($null -ne $row){
    $selectionStatus.Text=[string]$row.id; $projectIdBox.Text=[string]$row.id; $projectPathBox.Text=[string]$row.root; Select-ModeItem ([string]$row.mode); $projectIdValue.Text=[string]$row.id; $projectPathValue.Text=[string]$row.root; $projectPathValue.ToolTip=[string]$row.root; $projectModeValue.Text=Get-ModeLabel ([string]$row.mode)
    $moduleCount=@((Get-CurrentBindings)|Where-Object{[string]$_.workspaceId -eq [string]$row.id}).Count; $projectModuleCountValue.Text=$moduleCount.ToString()
  }else{$selectionStatus.Text='请选择一个项目'; $projectIdBox.Text=''; $projectPathBox.Text=''; $projectModeBox.SelectedIndex=1; $projectIdValue.Text='—'; $projectPathValue.Text='—'; $projectModeValue.Text='—'; $projectModuleCountValue.Text='0'}
  $script:updatingProjectEditor=$false
  Set-ConfigEnabled ($script:currentState -eq 'stopped')
}
function Show-ModuleActions($module) {
  $script:selectedProjectRow=$null; $script:selectedModule=$module; $script:selectedWorkspaceId=[string]$module.workspaceId; $script:selectedModuleId=[string]$module.moduleId
  $projectActions.Visibility='Collapsed'; $moduleActions.Visibility='Visible'; $moduleTypeBadge.Visibility='Visible'
  $selectionStatus.Text=[string]$module.uiName
  $isTemporary=[string]$module.moduleType -eq '临时'
  $moduleSelectionTitle.Text=if($isTemporary){'临时 Module'}else{'长期 Module'}
  $moduleTypeBadge.Background=if($isTemporary){$softGray}else{$moduleLongTermBadge}; $moduleSelectionTitle.Foreground=if($isTemporary){$textSecondary}else{$blueText}
  $moduleTypeBadge.ToolTip=if($isTemporary){'临时 Module'+[Environment]::NewLine+'由 ChatGPT 在运行时动态创建；当前 thread 结束、丢失或手动解绑后，临时 Module 记录会自动移除，但不会删除或归档 Codex 历史对话。'}else{'长期 Module'+[Environment]::NewLine+'由项目配置定义的稳定工作分类；解除绑定后 Module 本身继续保留，只清除与当前 Codex thread 的绑定关系。'}
  $moduleIdValue.Text=[string]$module.moduleId
  $moduleBindingValue.Text=if([string]$module.bindingText -eq '已绑定'){'●  已绑定'}else{'○  未绑定'}; $moduleBindingValue.Foreground=if([string]$module.bindingText -eq '已绑定'){$green}else{$muted}
  $threadNameValue.Text=if([string]::IsNullOrWhiteSpace([string]$module.threadName)){'—'}else{[string]$module.threadName}
  $threadIdValue.Text=if([string]::IsNullOrWhiteSpace([string]$module.threadId)){'—'}else{[string]$module.threadId}; $threadIdValue.ToolTip=[string]$module.threadId
  $ownerValue.Text=if([string]$module.bindingText -ne '已绑定'){'—'}elseif([string]$module.ownerText -eq '在线'){'●  在线'}else{'○  未占用'}; $ownerValue.Foreground=if([string]$module.ownerText -eq '在线'){$green}else{$muted}
  $codexBindingStatus.Text=if([string]::IsNullOrWhiteSpace([string]$module.threadId)){'未绑定 Codex thread'}else{'Thread：'+[string]$module.threadId+' · '+[string]$module.bindingText+' · Owner '+[string]$module.ownerText}
  $running=$script:currentState -eq 'running'; $refreshCodexButton.IsEnabled=$running; $unbindCodexButton.IsEnabled=$running -and -not [string]::IsNullOrWhiteSpace([string]$module.threadId)
}

function Select-ProjectFolder([string]$initialPath) {
  $owner = (New-Object System.Windows.Interop.WindowInteropHelper($window)).Handle
  return [ModernFolderPicker]::PickFolder($owner, $initialPath, '选择项目文件夹')
}

function Get-AutoProjectId([string]$folderPath) {
  $trimmedPath = $folderPath.TrimEnd([char[]]'\\/')
  $name = [IO.Path]::GetFileName($trimmedPath)
  if ([string]::IsNullOrWhiteSpace($name)) { $name = 'project' }
  $base = [regex]::Replace($name, '[^A-Za-z0-9._-]+', '-').Trim([char[]]'-_.')
  if ([string]::IsNullOrWhiteSpace($base)) { $base = 'project' }
  if ($base -notmatch '^[A-Za-z0-9]') { $base = 'project-' + $base }
  if ($base.Length -gt 48) { $base = $base.Substring(0, 48).TrimEnd([char[]]'-_.') }
  if ([string]::IsNullOrWhiteSpace($base)) { $base = 'project' }

  return $base
}

function Update-Status($status) {
  $state = [string]$status.state; $script:currentState = $state
  $stateText = switch ($state) { 'stopped' {'已停止'} 'starting' {'启动中'} 'running' {'运行中'} 'stopping' {'停止中'} 'error' {'异常'} default {$state} }
  if ($state -eq 'starting') { Set-StateText $bridgeValue '启动中' $amber; Set-StatusDot $bridgeDot $amber } elseif ($state -eq 'stopping') { Set-StateText $bridgeValue '停止中' $amber; Set-StatusDot $bridgeDot $amber } elseif ($status.bridge -eq 'running') { Set-StateText $bridgeValue '运行中' $green; Set-StatusDot $bridgeDot $green } elseif ($status.bridge -eq 'error') { Set-StateText $bridgeValue '异常' $red; Set-StatusDot $bridgeDot $red } else { Set-StateText $bridgeValue '已停止' $muted; Set-StatusDot $bridgeDot $muted }
  if ($status.mcp -eq 'available') { Set-StateText $mcpValue '可用' $green; Set-StatusDot $mcpDot $green } else { Set-StateText $mcpValue '不可用' $muted; Set-StatusDot $mcpDot $muted }
  if ($status.tunnel -eq 'connected') { Set-StateText $tunnelValue '已连接' $green; Set-StatusDot $tunnelDot $green } elseif ($status.tunnel -eq 'error') { Set-StateText $tunnelValue '异常' $red; Set-StatusDot $tunnelDot $red } else { Set-StateText $tunnelValue '未连接' $muted; Set-StatusDot $tunnelDot $muted }
  $bridgeMeta.Text=if($null -ne $status.port){'127.0.0.1:'+$status.port}else{'127.0.0.1'}; $mcpMeta.Text='HTTP /mcp'; $tunnelMeta.Text='OpenAI Secure Tunnel'; $codexMeta.Text='Desktop IPC'
  $stateValue.Text = $stateText; $pidValue.Text = if ($null -ne $status.pid) {'PID ' + $status.pid} else {''}; $portValue.Text = if ($null -ne $status.port) {'端口 ' + $status.port} else {''}
  if ($null -ne $status.startedAt -and [string]$status.startedAt -ne '') { try { $startedValue.Text = '启动于 ' + ([DateTimeOffset]::Parse([string]$status.startedAt).LocalDateTime.ToString('HH:mm:ss')) } catch { $startedValue.Text = '' } } else { $startedValue.Text = '' }
  if ($null -ne $status.error -and [string]$status.error -ne '') { $errorValue.Text = '错误：' + [string]$status.error; $errorValue.Visibility = 'Visible' } else { $errorValue.Text = ''; $errorValue.Visibility = 'Collapsed' }
  $transitioning = $state -eq 'starting' -or $state -eq 'stopping'; if (-not $transitioning) { $script:busy = $false }
  $startButton.IsEnabled = -not $script:busy -and -not $transitioning -and $state -ne 'running'; $stopButton.IsEnabled = -not $script:busy -and -not $transitioning -and $state -ne 'stopped'
  $startButton.Visibility = if($state -eq 'running' -or $transitioning){'Collapsed'}else{'Visible'}; $stopButton.Visibility = if($state -eq 'running' -or $transitioning){'Visible'}else{'Collapsed'}
  Set-ConfigEnabled ($state -eq 'stopped')
}

function Update-OverallStatus($status,$codexStatus) {
  $state=[string]$status.state
  if($state -eq 'error'){Set-OverallStatus '服务异常' $red $softRed; return}
  if($state -eq 'stopped'){Set-OverallStatus '已停止' $muted $softGray; return}
  if($state -eq 'starting'){Set-OverallStatus '启动中' $accent $softBlue; return}
  if($state -eq 'stopping'){Set-OverallStatus '停止中' $amber $softAmber; return}
  $codexReady=$null -ne $codexStatus -and $codexStatus.enabled -eq $true -and $codexStatus.ipcConnected -eq $true
  if($status.mcp -eq 'available' -and $status.tunnel -eq 'connected' -and $codexReady){Set-OverallStatus '运行正常' $green $softGreen}
  elseif($status.mcp -eq 'available' -and $status.tunnel -eq 'connected'){Set-OverallStatus 'Bridge 正常 · Codex 未连接' $amber $softAmber}
  else{Set-OverallStatus '运行中 · 链路不完整' $amber $softAmber}
}

function Update-LocalMcpSelection {
  $item=$localMcpList.SelectedItem; $script:selectedLocalMcp=$item
  $running=$script:currentState -eq 'running'
  if($null -eq $item){
    $localMcpProbeButton.IsEnabled=$false; $localMcpLoadButton.IsEnabled=$false; $localMcpUnloadButton.IsEnabled=$false; $localMcpLoadButton.Visibility='Visible'; $localMcpUnloadButton.Visibility='Collapsed'; return
  }
  $localMcpProbeButton.IsEnabled=$running
  if($item.loaded -eq $true){
    $localMcpLoadButton.Visibility='Collapsed'; $localMcpUnloadButton.Visibility='Visible'; $localMcpUnloadButton.IsEnabled=$running; $localMcpLoadButton.IsEnabled=$false
  }else{
    $localMcpLoadButton.Visibility='Visible'; $localMcpUnloadButton.Visibility='Collapsed'; $localMcpLoadButton.IsEnabled=$running; $localMcpUnloadButton.IsEnabled=$false
  }
}

function Update-LocalMcpServers($message) {
  $localMcpMessage.Text=if($null -ne $message.localMcpMessage){[string]$message.localMcpMessage}else{''}
  $entries=@($message.localMcpServers); $count=$entries.Count; $loadedCount=@($entries|Where-Object{$_.loaded -eq $true}).Count
  $localMcpCountText.Text=if($count -gt 0){$loadedCount.ToString()+'/'+$count.ToString()}else{'0'}
  $localMcpSummaryText.Text=if($count -gt 0){'已加载 '+$loadedCount.ToString()+' / 已配置 '+$count.ToString()}else{'暂无已配置的本地 MCP'}
  $localMcpEmptyText.Visibility=if($count -eq 0){'Visible'}else{'Collapsed'}
  $key=[string]$message.localMcpKey
  if($key -ne $script:lastLocalMcpKey){
    $selectedKey=''; if($null -ne $script:selectedLocalMcp){$selectedKey=[string]$script:selectedLocalMcp.workspaceId+'|'+[string]$script:selectedLocalMcp.serverId}
    $script:lastLocalMcpKey=$key; $localMcpList.Items.Clear(); $restore=$null
    foreach($entry in $entries){
      $loaded=$entry.loaded -eq $true
      $stateText='未检测'; $stateBrush=$muted; $detailText=''
      if($script:currentState -ne 'running'){$stateText='Bridge 已停止'; $stateBrush=$muted}
      elseif([string]$entry.probeStatus -eq 'available'){$stateText='可用'; $stateBrush=$green; $parts=@(); if($null -ne $entry.toolCount){$parts += ([string]$entry.toolCount+' tools')}; if($null -ne $entry.latencyMs){$parts += ([string]$entry.latencyMs+'ms')}; $detailText=$parts -join ' · '}
      elseif([string]$entry.probeStatus -eq 'unavailable'){$stateText='不可用'; $stateBrush=$red; $detailText='检测失败'}
      $row=[pscustomobject]@{
        workspaceId=[string]$entry.workspaceId; serverId=[string]$entry.serverId; url=[string]$entry.url; loaded=$loaded
        displayName=([string]$entry.workspaceId+' / '+[string]$entry.serverId); loadText=if($loaded){'已加载'}else{'未加载'}; loadBrush=if($loaded){$green}else{$muted}; loadBadgeBrush=if($loaded){$softGreen}else{$softGray}
        stateText=$stateText; stateBrush=$stateBrush; detailText=$detailText
      }
      [void]$localMcpList.Items.Add($row)
      if(([string]$row.workspaceId+'|'+[string]$row.serverId) -eq $selectedKey){$restore=$row}
    }
    if($null -ne $restore){$localMcpList.SelectedItem=$restore}elseif($localMcpList.Items.Count -gt 0){$localMcpList.SelectedIndex=0}else{$script:selectedLocalMcp=$null}
  }
  Update-LocalMcpSelection
}

function Update-Logs($message) {
  $key = [string]$message.logKey; if ($key -eq $script:lastLogKey) { return }; $script:lastLogKey = $key; $logList.Items.Clear()
  foreach ($entry in $message.logs) {
    $time='--:--:--'; try {$time=([DateTimeOffset]::Parse([string]$entry.timestamp).LocalDateTime.ToString('HH:mm:ss'))} catch {}
    $source=switch([string]$entry.source){'bridge'{'Bridge'}'tunnel'{'Tunnel'}default{'Controller'}}
    $messageText=[string]$entry.message; $explicitLevel=''
    if($messageText -match '(?i)"level"\s*:\s*"(?<level>TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)"'){$explicitLevel=$matches['level'].ToUpperInvariant()}
    elseif($messageText -match '(?i)(?:^|[\[\s])(WARN|WARNING|ERROR|FATAL|DEBUG|INFO)(?:\]|:|\s)'){$explicitLevel=$matches[1].ToUpperInvariant()}
    if($explicitLevel -in @('ERROR','FATAL')){$level='错误';$isError=$true;$isWarning=$false}
    elseif($explicitLevel -in @('WARN','WARNING')){$level='警告';$isError=$false;$isWarning=$true}
    elseif($explicitLevel -eq 'DEBUG' -or $explicitLevel -eq 'TRACE'){$level='调试';$isError=$false;$isWarning=$false}
    elseif($explicitLevel -eq 'INFO'){$level='信息';$isError=$false;$isWarning=$false}
    elseif([string]$entry.stream -eq 'stderr'){$level='错误';$isError=$true;$isWarning=$false}
    else{$level='信息';$isError=$false;$isWarning=$false}
    $row=[pscustomobject]@{time=$time;level=$level;source=$source;message=$messageText;isError=$isError;isWarning=$isWarning}
    [void]$logList.Items.Add($row)
  }
  if($logList.Items.Count -gt 0){$logList.ScrollIntoView($logList.Items[$logList.Items.Count-1])}
}

function Get-CurrentBindings {
  if([string]::IsNullOrWhiteSpace($script:lastSnapshot)){return @()}
  try{$snapshot=$script:lastSnapshot|ConvertFrom-Json; return @($snapshot.codexBindings)}catch{return @()}
}

function New-ModuleNode($binding) {
  $isConfigured=[string]$binding.moduleKind -eq 'configured'
  $uiName=([string]$binding.displayName) -replace '^\[ChatGPT\]\s*',''
  $threadName=if($null -ne $binding.threadName){([string]$binding.threadName) -replace '^\[ChatGPT\]\s*',''}else{''}
  $threadId=if($null -ne $binding.threadId){[string]$binding.threadId}else{''}
  $bound=[string]$binding.bindingStatus -eq 'bound'; $ownerOnline=$bound -and $binding.ownerPresent -eq $true
  return [pscustomobject]@{
    nodeType='module'; workspaceId=[string]$binding.workspaceId; moduleId=[string]$binding.moduleId; displayName=$uiName; moduleType=if($isConfigured){'长期'}else{'临时'}; uiName=$uiName
    kindText=if($isConfigured){''}else{'临时'}; badgeVisibility=if($isConfigured){'Collapsed'}else{'Visible'}; title=$uiName; titleWeight='Normal'; titleBrush=$textPrimary; iconData=if($isConfigured){$persistentModuleIconGeometry}else{$temporaryModuleIconGeometry}; iconBrush=$moduleIconBrush; badgeBrush=if($isConfigured){$softBlue}else{$softGray}; badgeForeground=if($isConfigured){$blueText}else{$textSecondary}
    detail=if([string]::IsNullOrWhiteSpace($threadName)){'—'}else{$threadName}; detailFull=if([string]::IsNullOrWhiteSpace($threadId)){$threadName}else{($threadName+'  ·  '+$threadId)}
    threadName=$threadName; threadId=$threadId; bindingText=if($bound){'已绑定'}else{'未绑定'}; ownerText=if(-not $bound){'—'}elseif($ownerOnline){'在线'}else{'未占用'}
    stateText=if(-not $bound){'未绑定'}elseif($ownerOnline){'● 在线'}else{'○ 未占用'}; stateBrush=if($ownerOnline){$green}else{$muted}
  }
}

function Build-ProjectTree($bindings) {
  $expanded=@{}; foreach($item in $projectTree.Items){if($item.Tag -and [string]$item.Tag.nodeType -eq 'project'){$expanded[[string]$item.Tag.workspaceId]=[bool]$item.IsExpanded}}
  $selectedWorkspace=$script:selectedWorkspaceId; $selectedModuleId=$script:selectedModuleId
  $projectTree.Items.Clear(); $selectedTreeItem=$null
  foreach($row in $script:workspaceTable.Rows){
    if($row.RowState -eq [System.Data.DataRowState]::Deleted){continue}
    $workspaceId=[string]$row.id; $workspaceBindings=@($bindings|Where-Object{[string]$_.workspaceId -eq $workspaceId})
    $mode=[string]$row.mode
    $projectTitleBrush=if($mode -eq 'trusted-dev'){$amber}elseif($mode -eq 'readonly'){$muted}elseif($mode -eq 'handoff'){$handoffBrush}else{$moduleIconBrush}
    $projectData=[pscustomobject]@{nodeType='project';workspaceId=$workspaceId;kindText='';badgeVisibility='Collapsed';title=$workspaceId;titleWeight='SemiBold';titleBrush=$projectTitleBrush;iconData=$projectIconGeometry;iconBrush=$moduleIconBrush;badgeBrush=$softBlue;badgeForeground=$accent;stateText=if($workspaceBindings.Count -gt 0){$workspaceBindings.Count.ToString()+' Modules'}else{''};stateBrush=$muted;detail=[string]$row.root;detailFull=[string]$row.root;bindingText='';ownerText='';row=$row}
    $projectItem=New-Object Windows.Controls.TreeViewItem; $projectItem.Header=$projectData; $projectItem.HeaderTemplate=$treeRowTemplate; $projectItem.Tag=$projectData; $projectItem.HorizontalContentAlignment='Stretch'
    if($expanded.ContainsKey($workspaceId)){$projectItem.IsExpanded=[bool]$expanded[$workspaceId]}
    foreach($binding in $workspaceBindings){
      $moduleData=New-ModuleNode $binding
      $moduleItem=New-Object Windows.Controls.TreeViewItem; $moduleItem.Header=$moduleData; $moduleItem.HeaderTemplate=$treeRowTemplate; $moduleItem.Tag=$moduleData; $moduleItem.HorizontalContentAlignment='Stretch'
      [void]$projectItem.Items.Add($moduleItem)
      if($workspaceId -eq $selectedWorkspace -and [string]$moduleData.moduleId -eq $selectedModuleId){$selectedTreeItem=$moduleItem; $projectItem.IsExpanded=$true}
    }
    if($workspaceId -eq $selectedWorkspace -and [string]::IsNullOrWhiteSpace($selectedModuleId)){$selectedTreeItem=$projectItem; $projectItem.IsExpanded=$true}
    [void]$projectTree.Items.Add($projectItem)
  }
  if($null -ne $selectedTreeItem){$selectedTreeItem.IsSelected=$true; $selectedTreeItem.BringIntoView()}
}

function Update-Workspaces($message) {
  $key=[string]$message.configKey
  if($key -ne $script:lastConfigKey -and -not $script:configDirty){
    $script:lastConfigKey=$key; $script:workspaceTable.Rows.Clear()
    foreach($workspace in $message.workspaces){$row=$script:workspaceTable.NewRow(); $row.originalId=[string]$workspace.originalId; $row.id=[string]$workspace.id; $row.root=[string]$workspace.root; $row.mode=[string]$workspace.mode; [void]$script:workspaceTable.Rows.Add($row)}
  }
  Build-ProjectTree $message.codexBindings
}

function Update-CodexBindings($message) {
  Build-ProjectTree $message.codexBindings
  if(-not [string]::IsNullOrWhiteSpace($script:selectedModuleId)){
    foreach($binding in $message.codexBindings){if([string]$binding.workspaceId -eq $script:selectedWorkspaceId -and [string]$binding.moduleId -eq $script:selectedModuleId){Show-ModuleActions (New-ModuleNode $binding); return}}
  } elseif($null -ne $script:selectedProjectRow) {
    Show-ProjectActions $script:selectedProjectRow
  }
}

function Read-Snapshot {
  if (-not [IO.File]::Exists($SnapshotPath)) { return }
  $stream = $null; $reader = $null
  try {
    $share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
    $stream = New-Object IO.FileStream($SnapshotPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, $share)
    $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8, $true)
    $raw = $reader.ReadToEnd()
    if([string]::IsNullOrWhiteSpace($raw)-or $raw -eq $script:lastSnapshot){return}
    $message=$raw|ConvertFrom-Json
    if([string]$message.type -ne 'snapshot'){return}
    $script:lastSnapshot=$raw
    Update-Status $message.status
    if($null -eq $message.codexStatus -or $message.codexStatus.enabled -ne $true){Set-StateText $codexValue '未启用' $muted; Set-StatusDot $codexDot $muted}elseif($message.codexStatus.ipcConnected -eq $true){Set-StateText $codexValue '已连接' $green; Set-StatusDot $codexDot $green}elseif($message.codexStatus.available -eq $true){Set-StateText $codexValue '未连接' $muted; Set-StatusDot $codexDot $muted}else{Set-StateText $codexValue '不可用' $muted; Set-StatusDot $codexDot $muted}
    Update-OverallStatus $message.status $message.codexStatus
    Update-LocalMcpServers $message
    Update-Logs $message
    if($null -ne $message.configMessage -and [string]$message.configMessage -ne ''){$configStatus.Text=[string]$message.configMessage; if(([string]$message.configMessage).StartsWith('配置已保存')){$script:configDirty=$false; $script:lastConfigKey=''}}
    Update-Workspaces $message
    Update-CodexBindings $message
  } catch {
  } finally {
    if($null -ne $reader){$reader.Dispose()} elseif($null -ne $stream){$stream.Dispose()}
  }
}

$projectTree.Add_SelectedItemChanged({
  $item=$projectTree.SelectedItem
  if($null -eq $item -or $null -eq $item.Tag){Show-ProjectActions $null; return}
  $node=$item.Tag
  if([string]$node.nodeType -eq 'project'){$item.IsExpanded=$true; Show-ProjectActions $node.row}else{Show-ModuleActions $node}
})
$projectIdBox.Add_TextChanged({
  if($script:updatingProjectEditor -or $script:currentState -ne 'stopped' -or $null -eq $script:selectedProjectRow){return}
  $script:selectedProjectRow.id=$projectIdBox.Text; $script:selectedWorkspaceId=$projectIdBox.Text; $script:configDirty=$true; $configStatus.Text='有未保存修改'
})
$projectPathBox.Add_TextChanged({
  if($script:updatingProjectEditor -or $script:currentState -ne 'stopped' -or $null -eq $script:selectedProjectRow){return}
  $script:selectedProjectRow.root=$projectPathBox.Text; $script:configDirty=$true; $configStatus.Text='有未保存修改'
})
$projectModeBox.Add_SelectionChanged({
  if($script:updatingProjectEditor -or $script:currentState -ne 'stopped' -or $null -eq $script:selectedProjectRow -or $null -eq $projectModeBox.SelectedItem){return}
  $script:selectedProjectRow.mode=[string]$projectModeBox.SelectedItem.Tag; $script:configDirty=$true; $configStatus.Text='有未保存修改'; Set-ConfigEnabled $true; Build-ProjectTree (Get-CurrentBindings)
})
$addWorkspaceButton.Add_Click({
  if($script:currentState -ne 'stopped'){return}
  $selectedPath=Select-ProjectFolder ''; if([string]::IsNullOrWhiteSpace($selectedPath)){return}
  $row=$script:workspaceTable.NewRow(); $row.originalId=''; $row.id=Get-AutoProjectId $selectedPath; $row.root=$selectedPath; $row.mode='workspace'; [void]$script:workspaceTable.Rows.Add($row)
  $script:selectedWorkspaceId=[string]$row.id; $script:selectedModuleId=''; $script:configDirty=$true; $configStatus.Text='有未保存修改'; Build-ProjectTree (Get-CurrentBindings)
})
$deleteWorkspaceButton.Add_Click({
  if($script:currentState -ne 'stopped' -or $null -eq $script:selectedProjectRow){return}
  $activeRows=@($script:workspaceTable.Rows|Where-Object{$_.RowState -ne [System.Data.DataRowState]::Deleted}); if($activeRows.Count -le 1){[Windows.MessageBox]::Show('至少保留一个项目配置。','MCP Bridge 控制台')|Out-Null; return}
  $script:selectedProjectRow.Delete(); $script:selectedProjectRow=$null; $script:selectedWorkspaceId=''; $script:configDirty=$true; $configStatus.Text='有未保存修改'; Build-ProjectTree (Get-CurrentBindings); Show-ProjectActions $null
})
$browseWorkspaceButton.Add_Click({
  if($script:currentState -ne 'stopped' -or $null -eq $script:selectedProjectRow){return}
  $selectedPath=Select-ProjectFolder ([string]$script:selectedProjectRow.root)
  if(-not [string]::IsNullOrWhiteSpace($selectedPath)){$script:selectedProjectRow.root=$selectedPath; $script:updatingProjectEditor=$true; $projectPathBox.Text=$selectedPath; $script:updatingProjectEditor=$false; $script:configDirty=$true; $configStatus.Text='有未保存修改'; Build-ProjectTree (Get-CurrentBindings)}
})
$saveConfigButton.Add_Click({
  if($script:currentState -ne 'stopped' -or $script:busy){return}
  $items=@(); foreach($row in $script:workspaceTable.Rows){if($row.RowState -eq [System.Data.DataRowState]::Deleted){continue}; $items += @{originalId=[string]$row.originalId;id=[string]$row.id;root=[string]$row.root;mode=[string]$row.mode}}
  $payload=@{workspaces=$items}|ConvertTo-Json -Depth 5 -Compress; $utf8NoBom=New-Object Text.UTF8Encoding($false); [IO.File]::WriteAllText($ConfigEditPath,$payload,$utf8NoBom); $script:busy=$true; $saveConfigButton.IsEnabled=$false; $configStatus.Text='正在保存…'; Send-Command 'save-config'
})
$refreshCodexButton.Add_Click({ if($script:currentState -ne 'running' -or $null -eq $script:selectedModule){return}; $workspaceId=[string]$script:selectedModule.workspaceId; $codexBindingStatus.Text='正在刷新 Codex 绑定状态…'; Send-Command ('refresh-codex:'+$workspaceId) })
$unbindCodexButton.Add_Click({
  if($script:currentState -ne 'running' -or $null -eq $script:selectedModule){return}
  $item=$script:selectedModule; if([string]::IsNullOrWhiteSpace([string]$item.threadId)){return}
  $message='确定解除模块“'+[string]$item.displayName+'”与当前 Codex 对话的绑定吗？'+[Environment]::NewLine+[Environment]::NewLine+'这不会归档或删除 Codex 对话。'
  $result=[Windows.MessageBox]::Show($message,'解除 Codex 绑定',[Windows.MessageBoxButton]::YesNo,[Windows.MessageBoxImage]::Question)
  if($result -ne [Windows.MessageBoxResult]::Yes){return}
  $codexBindingStatus.Text='正在解除绑定…'; Send-Command ('unbind-codex:'+[string]$item.workspaceId+':'+[string]$item.moduleId)
})
$localMcpButton.Add_Click({ $localMcpPopup.IsOpen = -not $localMcpPopup.IsOpen })
$localMcpList.Add_SelectionChanged({ Update-LocalMcpSelection })
$localMcpProbeButton.Add_Click({
  $item=$localMcpList.SelectedItem; if($script:currentState -ne 'running' -or $null -eq $item){return}
  $localMcpProbeButton.IsEnabled=$false; $localMcpLoadButton.IsEnabled=$false; $localMcpUnloadButton.IsEnabled=$false; $localMcpMessage.Text='正在检测 '+[string]$item.workspaceId+' / '+[string]$item.serverId+'…'; Send-Command ('local-mcp-probe:'+[string]$item.workspaceId+':'+[string]$item.serverId)
})
$localMcpLoadButton.Add_Click({
  $item=$localMcpList.SelectedItem; if($script:currentState -ne 'running' -or $null -eq $item){return}
  $localMcpProbeButton.IsEnabled=$false; $localMcpLoadButton.IsEnabled=$false; $localMcpUnloadButton.IsEnabled=$false; $localMcpMessage.Text='正在加载 '+[string]$item.workspaceId+' / '+[string]$item.serverId+'…'; Send-Command ('local-mcp-load:'+[string]$item.workspaceId+':'+[string]$item.serverId)
})
$localMcpUnloadButton.Add_Click({
  $item=$localMcpList.SelectedItem; if($script:currentState -ne 'running' -or $null -eq $item){return}
  $localMcpProbeButton.IsEnabled=$false; $localMcpLoadButton.IsEnabled=$false; $localMcpUnloadButton.IsEnabled=$false; $localMcpMessage.Text='正在卸载 '+[string]$item.workspaceId+' / '+[string]$item.serverId+'…'; Send-Command ('local-mcp-unload:'+[string]$item.workspaceId+':'+[string]$item.serverId)
})
$startButton.Add_Click({ if($script:busy){return}; $script:busy=$true; $startButton.IsEnabled=$false; $stopButton.IsEnabled=$false; Send-Command 'start' })
$stopButton.Add_Click({ if($script:busy){return}; $script:busy=$true; $startButton.IsEnabled=$false; $stopButton.IsEnabled=$false; Send-Command 'stop' })
$window.Add_Closed({ try{Send-Command 'close'}catch{} })

$timer=New-Object Windows.Threading.DispatcherTimer; $timer.Interval=[TimeSpan]::FromMilliseconds(250); $timer.Add_Tick({Read-Snapshot}); $timer.Start(); Read-Snapshot; [void]$window.ShowDialog(); $timer.Stop()
`;

interface SnapshotMessage {
  readonly type: "snapshot";
  readonly status: BridgeControllerStatus;
  readonly logs: readonly LogEntry[];
  readonly logKey: string;
  readonly workspaces: readonly EditableWorkspace[];
  readonly configKey: string;
  readonly codexStatus: { readonly enabled: boolean; readonly available: boolean; readonly ipcConnected: boolean };
  readonly codexBindings: readonly import("../codex/codex-tasks.js").CodexModuleView[];
  readonly localMcpServers: readonly import("../control/bridge-controller.js").LocalMcpControllerView[];
  readonly localMcpKey: string;
  readonly configMessage?: string;
  readonly localMcpMessage?: string;
}

interface ConfigEditPayload { readonly workspaces?: unknown }
export interface LocalControlUi { close(): Promise<void> }

function resolvePowerShell(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("无法定位 Windows PowerShell：SystemRoot/WINDIR 不可用");
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function logKey(logs: readonly LogEntry[]): string { const first=logs[0]; const last=logs[logs.length-1]; return `${logs.length}:${first?.timestamp ?? ""}:${last?.timestamp ?? ""}:${last?.message ?? ""}` }
function parseCommandRecord(raw: string): string | undefined {
  const trimmed=raw.trim().replace(/^\uFEFF/u, ""); if(!trimmed)return undefined;
  const separator=trimmed.indexOf("|"); const command=separator>=0?trimmed.slice(separator+1):trimmed;
  if (["start","stop","close","save-config"].includes(command)) return command;
  if (/^refresh-codex:[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(command)) return command;
  if (/^unbind-codex:[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(command)) return command;
  if (/^local-mcp-(?:load|unload|probe):[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(command)) return command;
  return undefined;
}
function parseWorkspacePayload(value: unknown): EditableWorkspace[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("项目配置数据无效");
  const workspaces=(value as ConfigEditPayload).workspaces; if(!Array.isArray(workspaces))throw new Error("项目配置数据无效");
  const validModes=new Set(["readonly","workspace","trusted-dev","handoff"]);
  return workspaces.map((item)=>{ if(typeof item!=="object"||item===null||Array.isArray(item))throw new Error("项目配置数据无效"); const record=item as Record<string,unknown>; if(typeof record.id!=="string"||typeof record.root!=="string")throw new Error("项目 ID 或路径无效"); if(typeof record.mode!=="string"||!validModes.has(record.mode))throw new Error("项目权限模式无效"); return { ...(typeof record.originalId==="string"&&record.originalId?{originalId:record.originalId}:{}), id:record.id, root:record.root, mode:record.mode as EditableWorkspace["mode"] } });
}

export async function launchLocalControlUi(configPath = path.resolve(process.cwd(), DEFAULT_CONFIG_FILE)): Promise<LocalControlUi> {
  if (process.platform !== "win32") throw new Error("本地控制台 UI 当前仅支持 Windows");
  await Promise.all(UI_LOGO_FILES.map(async (fileName) => {
    const filePath = path.join(UI_ASSET_ROOT, fileName);
    const info = await stat(filePath).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`本地控制台 UI 图标资源不存在：${filePath}`);
  }));
  const controller=new BridgeController({configPath,captureTunnelOutput:true});
  const temporaryDirectory=await mkdtemp(path.join(os.tmpdir(),"mcp-bridge-ui-"));
  const scriptPath=path.join(temporaryDirectory,"control-ui.ps1"); const snapshotPath=path.join(temporaryDirectory,"snapshot.json"); const snapshotTempPath=path.join(temporaryDirectory,"snapshot.next.json"); const commandPath=path.join(temporaryDirectory,"command.txt"); const configEditPath=path.join(temporaryDirectory,"workspace-edit.json");
  await Promise.all([writeFile(scriptPath,`\uFEFF${WPF_SCRIPT}`,"utf8"),writeFile(commandPath,"","utf8"),writeFile(configEditPath,"{}","utf8")]);

  let closed=false,snapshotWriting=false,actionInFlight=false,lastCommandRecord="",commandPolling=false; let child:ChildProcess|undefined; let configMessage="", localMcpMessage="";
  const isTransientSnapshotError=(error:unknown):boolean=>error instanceof Error&&"code" in error&&["EBUSY","EPERM","EACCES"].includes(String((error as NodeJS.ErrnoException).code));
  const writeSnapshot=async():Promise<void>=>{
    if(closed||snapshotWriting)return;
    snapshotWriting=true;
    try{
      let workspaceConfig:Awaited<ReturnType<typeof readWorkspaceConfig>>;
      try{workspaceConfig=await readWorkspaceConfig(configPath)}catch(error){controller.addLog("controller","stderr",`读取项目配置失败：${error instanceof Error?error.message:String(error)}`);return}
      const status=await controller.getStatus();
      const logs=controller.getLogs();
      const codexStatus = status.state === "running"
        ? await controller.getCodexStatus().catch(() => ({ enabled: true, available: false, ipcConnected: false }))
        : { enabled: false, available: false, ipcConnected: false };
      const codexBindings=status.state==="running"
        ? (await Promise.all(workspaceConfig.workspaces.map((workspace)=>controller.getCodexModuleBindings(workspace.id).catch(()=>[])))).flat()
        : [];
      const localMcpServers=await controller.getLocalMcpServers().catch(()=>[]);
      const localMcpKey=JSON.stringify({state:status.state,servers:localMcpServers});
      const message:SnapshotMessage={type:"snapshot",status,logs,logKey:logKey(logs),workspaces:workspaceConfig.workspaces,configKey:workspaceConfig.key,codexStatus,codexBindings,localMcpServers,localMcpKey,...(configMessage?{configMessage}:{}),...(localMcpMessage?{localMcpMessage}:{})};
      try{
        await writeFile(snapshotTempPath,JSON.stringify(message),"utf8");
        await rename(snapshotTempPath,snapshotPath);
      }catch(error){
        await unlink(snapshotTempPath).catch(()=>undefined);
        if(!isTransientSnapshotError(error)&&!closed)controller.addLog("controller","stderr",`更新 UI 状态快照失败：${error instanceof Error?error.message:String(error)}`);
      }
    }finally{snapshotWriting=false}
  };
  await writeSnapshot();

  const cleanup=async(terminateUi:boolean):Promise<void>=>{ if(closed)return; closed=true; clearInterval(refreshTimer); clearInterval(commandTimer); await controller.stop().catch(()=>undefined); if(terminateUi&&child&&child.exitCode===null&&child.signalCode===null)child.kill(); await rm(temporaryDirectory,{recursive:true,force:true}).catch(()=>undefined) };
  const close=async():Promise<void>=>cleanup(true);
  const handleCommand=async(command:string):Promise<void>=>{ if(closed)return; if(command==="close"){await close();return} if(actionInFlight)return; actionInFlight=true; try{
    if(command.startsWith("refresh-codex:")){
      const workspaceId=command.slice("refresh-codex:".length);
      try{ await controller.getCodexModuleBindings(workspaceId,true); configMessage=`Codex 绑定状态已刷新：${workspaceId}`; controller.addLog("controller","stdout",configMessage) }
      catch(error){ configMessage=`刷新 Codex 绑定失败：${error instanceof Error?error.message:String(error)}`; controller.addLog("controller","stderr",configMessage) }
      await writeSnapshot(); return
    }
    if(command.startsWith("unbind-codex:")){
      const [,workspaceId,moduleId]=command.split(":");
      if(!workspaceId||!moduleId){configMessage="解除 Codex 绑定失败：命令参数无效";await writeSnapshot();return}
      try{ await controller.unbindCodexModule(workspaceId,moduleId); configMessage=`已解除 Codex 绑定：${workspaceId}/${moduleId}`; controller.addLog("controller","stdout",configMessage) }
      catch(error){ configMessage=`解除 Codex 绑定失败：${error instanceof Error?error.message:String(error)}`; controller.addLog("controller","stderr",configMessage) }
      await writeSnapshot(); return
    }
    if(command.startsWith("local-mcp-")){
      const parts=command.split(":"); const action=parts[0]; const workspaceId=parts[1]; const serverId=parts[2];
      if(!workspaceId||!serverId){localMcpMessage="本地 MCP 操作失败：命令参数无效";await writeSnapshot();return}
      try{
        if(action==="local-mcp-load"){await controller.loadLocalMcpServer(workspaceId,serverId); localMcpMessage=`已加载：${workspaceId} / ${serverId}`}
        else if(action==="local-mcp-unload"){await controller.unloadLocalMcpServer(workspaceId,serverId); localMcpMessage=`已卸载：${workspaceId} / ${serverId}`}
        else if(action==="local-mcp-probe"){
          const result=await controller.probeLocalMcpServer(workspaceId,serverId);
          localMcpMessage=result.probeStatus==="available"
            ? `检测通过：${workspaceId} / ${serverId} · ${result.toolCount ?? 0} tools · ${result.latencyMs ?? 0}ms`
            : `检测失败：${workspaceId} / ${serverId}${result.probeError?` · ${result.probeError}`:""}`;
        }
      }catch(error){localMcpMessage=`本地 MCP 操作失败：${error instanceof Error?error.message:String(error)}`;controller.addLog("controller","stderr",localMcpMessage)}
      await writeSnapshot(); return
    }
    if(command==="save-config"){
      if(controller.lifecycleState!=="stopped"){configMessage="请先停止 Bridge 再保存配置"; await writeSnapshot(); return}
      try{ const rawPayload=(await readFile(configEditPath,"utf8")).replace(/^\uFEFF/u,""); const payload=JSON.parse(rawPayload) as unknown; const workspaces=parseWorkspacePayload(payload); await writeWorkspaceConfig(configPath,workspaces); configMessage="配置已保存"; controller.addLog("controller","stdout","项目配置已保存"); }catch(error){ configMessage=`保存失败：${error instanceof Error?error.message:String(error)}`; controller.addLog("controller","stderr",configMessage) }
      await writeSnapshot(); return
    }
    configMessage=""; localMcpMessage=""; const operation=command==="start"?controller.start():controller.stop(); await writeSnapshot(); await operation.catch(()=>undefined); await writeSnapshot();
  }finally{actionInFlight=false} };
  const pollCommand=async():Promise<void>=>{ if(closed||commandPolling)return; commandPolling=true; try{ const raw=await readFile(commandPath,"utf8").catch(()=>""); if(!raw||raw===lastCommandRecord)return; lastCommandRecord=raw; const command=parseCommandRecord(raw); if(command)void handleCommand(command) }finally{commandPolling=false} };
  const refreshTimer=setInterval(()=>void writeSnapshot(),REFRESH_INTERVAL_MS); const commandTimer=setInterval(()=>void pollCommand(),COMMAND_POLL_INTERVAL_MS);

  try{ child=spawn(resolvePowerShell(),["-NoLogo","-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-STA","-File",scriptPath,"-SnapshotPath",snapshotPath,"-CommandPath",commandPath,"-ConfigEditPath",configEditPath,"-AssetRoot",UI_ASSET_ROOT],{shell:false,windowsHide:true,stdio:"ignore"}); await new Promise<void>((resolve,reject)=>{child?.once("spawn",resolve);child?.once("error",reject)}) }catch(error){await cleanup(false);throw error}
  child.once("exit",()=>{void cleanup(false)}); return {close};
}
