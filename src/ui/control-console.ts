import { launchLocalControlUi } from "./windows-console.js";
import { launchWindowsSetupWizardUi } from "./windows-setup-wizard.js";
import { launchNativeMacUi, launchNativeMacSetupUi } from "./native-mac-console.js";

export function launchControlUi(configPath: string): Promise<{ close(): Promise<void> }> {
  if (process.platform === "darwin") return launchNativeMacUi(configPath);
  return launchLocalControlUi(configPath);
}

export function launchSetupUi(configPath: string): Promise<{ close(): Promise<void> }> {
  if (process.platform === "darwin") return launchNativeMacSetupUi(configPath);
  return launchWindowsSetupWizardUi(configPath);
}