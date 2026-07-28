import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertIsolatedWebServerEnvironment, buildWebServerEnvironment } from "./web-server-environment.mjs";

assertIsolatedWebServerEnvironment(process.env);
const environment = buildWebServerEnvironment(process.env);
const next = fileURLToPath(new URL("../../node_modules/next/dist/bin/next", import.meta.url));

const build = spawnSync(process.execPath, [next, "build"], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
});
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const server = spawnSync(process.execPath, [next, "start", "--port", "3000"], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
});
if (server.error) throw server.error;
process.exit(server.status ?? 1);
