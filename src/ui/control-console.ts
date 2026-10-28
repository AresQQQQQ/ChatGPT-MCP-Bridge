import { launchLocalControlUi } from "./windows-console.js";
import { launchNativeMacUi } from "./native-mac-console.js";

export function launchControlUi(configPath: string): Promise<{ close(): Promise<void> }> {
  if (process.platform === "darwin") return launchNativeMacUi(configPath);
  return launchLocalControlUi(configPath);
}
