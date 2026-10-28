import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchMacControlUi } from "./mac-console.js";
import { launchSetupWizardServer } from "./setup-wizard-server.js";

export async function runMacAppHost(configPath: string): Promise<void> {
  const ui = process.env.BRIDGE_UI_MODE === "setup"
    ? await launchSetupWizardServer(configPath)
    : await launchMacControlUi(configPath, { openBrowser: false });
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try { await ui.close(); } catch { process.exitCode = 1; }
    process.stdin.pause();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  // The native app owns this pipe. EOF also cleans services if the app crashes.
  process.stdin.once("end", () => void stop());
  process.stdin.resume();
  process.stdout.write(JSON.stringify({ url: ui.url }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--config" || !args[1]) {
    console.error("Usage: mac-app-host --config <local config path>"); process.exitCode = 1;
  } else {
    runMacAppHost(path.resolve(args[1])).catch(() => {
      console.error("Mac 控制台启动失败，请检查本机配置、Node 和依赖。"); process.exitCode = 1;
    });
  }
}
