import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "native mac ui-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "src/ui/native-mac-console.ts");
  const executable = path.join(root, ".mcp-bridge-state/ChatGPT MCP Bridge.app/Contents/MacOS/BridgeControl");
  const host = path.join(root, "dist/ui/mac-app-host.js");
  const buildMarker = path.join(root, "build-called");
  const launchMarker = path.join(root, "launch-config");
  for (const file of [source, executable, host, path.join(root,"node_modules/typescript/bin/tsc"), path.join(root,"tools/build-mac-ui.mjs")]) await mkdir(path.dirname(file), {recursive:true});
  await writeFile(path.join(root,"package.json"), '{"type":"module"}');
  await copyFile(new URL("../src/ui/native-mac-console.ts", import.meta.url), source);
  await writeFile(host, "// Built host fixture\n");
  const sentinel = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(buildMarker)},'called'); throw Error('Launch must not execute build tools');\n`;
  await writeFile(path.join(root,"node_modules/typescript/bin/tsc"), sentinel);
  await writeFile(path.join(root,"tools/build-mac-ui.mjs"), sentinel);
  await writeFile(executable, `#!${process.execPath}\nimport {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(launchMarker)},process.env.BRIDGE_UI_CONFIG); setInterval(()=>{},1000);\n`, {mode:0o700});
  const { launchNativeMacUi } = await import(pathToFileURL(source).href);
  return {root, source, executable, host, buildMarker, launchMarker, launchNativeMacUi};
}

const supported = process.platform === "darwin" && process.arch === "arm64";

test("existing Mac app launches repeatedly without executing TypeScript or app builders", {skip:!supported}, async t => {
  const f=await fixture(t);
  const newer = new Date(Date.now() + 60_000);
  await utimes(f.source, newer, newer);
  for(let run=0;run<2;run++){
    await rm(f.launchMarker,{force:true});
    const configPath=path.join(f.root,`config ${run}.json`);
    const ui=await f.launchNativeMacUi(configPath);
    try{
      for(let attempt=0;attempt<100;attempt++){
        const config=await readFile(f.launchMarker,"utf8").catch(()=>undefined);
        if(config!==undefined){assert.equal(config,configPath);break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(await readFile(f.launchMarker,"utf8"),configPath);
      await assert.rejects(readFile(f.buildMarker),{code:"ENOENT"});
    }finally{await ui.close();}
  }
});

test("missing Mac app fails with the explicit ui:build instruction", {skip:!supported}, async t => {
  const f=await fixture(t);await rm(f.executable);
  await assert.rejects(f.launchNativeMacUi(path.join(f.root,"config.json")),/Mac 控制台尚未构建，请先运行 pnpm run ui:build。/);
  await assert.rejects(readFile(f.buildMarker),{code:"ENOENT"});
});

test("non-executable app and missing host fail before spawning", {skip:!supported}, async t => {
  const f=await fixture(t);const config=path.join(f.root,"config.json");
  await chmod(f.executable,0o600);
  await assert.rejects(f.launchNativeMacUi(config),/pnpm run ui:build/);
  await chmod(f.executable,0o700);await rm(f.host);
  await assert.rejects(f.launchNativeMacUi(config),/pnpm run ui:build/);
  await assert.rejects(readFile(f.launchMarker),{code:"ENOENT"});
});
