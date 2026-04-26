const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");

const { OMO_PLUGIN } = require("../runtime-config");
const {
  DEFAULT_STATE_PATH,
  ensureOhMyPluginCache,
  getDeploymentId,
  getDeploymentState,
  refreshPluginCache,
} = require("../plugin-refresh");

const mkdir = (dir) => fs.mkdirSync(dir, { recursive: true });
const write = (filePath, value = "x") => {
  mkdir(path.dirname(filePath));
  fs.writeFileSync(filePath, value);
};

const run = () => {
  assert.equal(getDeploymentId({ RAILWAY_DEPLOYMENT_ID: "dep-1" }), "dep-1");
  assert.equal(getDeploymentId({ RAILWAY_SNAPSHOT_ID: "snap-1" }), "snap-1");
  assert.equal(getDeploymentId({ RAILWAY_DEPLOYMENT_ID: "dep-1", RAILWAY_SNAPSHOT_ID: "snap-1" }), "dep-1:snap-1");
  assert.equal(getDeploymentId({}), "");
  assert.deepEqual(getDeploymentState({ RAILWAY_DEPLOYMENT_ID: "dep-1", RAILWAY_SNAPSHOT_ID: "snap-1" }), {
    RAILWAY_DEPLOYMENT_ID: "dep-1",
    RAILWAY_SNAPSHOT_ID: "snap-1",
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-plugin-refresh-"));
  const cacheDir = path.join(dir, "cache");
  const statePath = path.join(dir, "state.json");
  const specDir = path.join(cacheDir, "packages", OMO_PLUGIN);
  const legacySpecDir = path.join(cacheDir, "packages", "oh-my-opencode@latest");
  const nodeModules = path.join(cacheDir, "node_modules");
  const workspaceModules = path.join(cacheDir, "packages", "node_modules");

  write(path.join(specDir, "package.json"));
  write(path.join(legacySpecDir, "package.json"));
  write(path.join(nodeModules, "oh-my-openagent", "package.json"));
  write(path.join(nodeModules, "oh-my-opencode-linux-x64", "package.json"));
  write(path.join(nodeModules, ".bin", "oh-my-openagent"));
  write(path.join(workspaceModules, "oh-my-opencode", "package.json"));
  write(path.join(workspaceModules, ".bin", "oh-my-opencode"));

  const result = refreshPluginCache({
    cacheDir,
    statePath,
    env: { RAILWAY_DEPLOYMENT_ID: "dep-1" },
  });

  assert.equal(result.action, "refreshed");
  assert.equal(result.deployment, "dep-1");
  assert.equal(fs.existsSync(specDir), false);
  assert.equal(fs.existsSync(legacySpecDir), false);
  assert.equal(fs.existsSync(path.join(nodeModules, "oh-my-openagent")), false);
  assert.equal(fs.existsSync(path.join(nodeModules, "oh-my-opencode-linux-x64")), false);
  assert.equal(fs.existsSync(path.join(workspaceModules, "oh-my-opencode")), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), {
    deployment: "dep-1",
    RAILWAY_DEPLOYMENT_ID: "dep-1",
  });

  const noop = refreshPluginCache({
    cacheDir,
    statePath,
    env: { RAILWAY_DEPLOYMENT_ID: "dep-1" },
  });
  assert.deepEqual(noop, { action: "noop", deployment: "dep-1" });

  const refreshedSnapshot = refreshPluginCache({
    cacheDir,
    statePath,
    env: { RAILWAY_DEPLOYMENT_ID: "dep-1", RAILWAY_SNAPSHOT_ID: "snap-2" },
  });
  assert.equal(refreshedSnapshot.action, "refreshed");
  assert.equal(refreshedSnapshot.deployment, "dep-1:snap-2");

  const skipped = refreshPluginCache({
    cacheDir,
    statePath,
    env: {},
  });
  assert.deepEqual(skipped, { action: "skipped", reason: "missing_deployment_id" });

  const disabled = refreshPluginCache({
    cacheDir,
    statePath,
    env: { RAILWAY_DEPLOYMENT_ID: "dep-2", ENABLE_OMO_REDEPLOY_REFRESH: "false" },
  });
  assert.deepEqual(disabled, { action: "skipped", reason: "refresh_disabled" });

  const bin = path.join(dir, "bin");
  const fake = path.join(bin, "npm");
  const calls = path.join(dir, "npm-calls");
  mkdir(bin);
  fs.writeFileSync(fake, `#!/bin/sh
set -eu
echo "$*" >> "${calls}"
dir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--prefix" ]; then
    dir="$arg"
    break
  fi
  prev="$arg"
done
mkdir -p "$dir/node_modules/oh-my-openagent"
printf '{"name":"oh-my-openagent"}' > "$dir/node_modules/oh-my-openagent/package.json"
`);
  fs.chmodSync(fake, 0o755);

  const warmCache = path.join(dir, "warm-cache");
  const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const warm = ensureOhMyPluginCache({
    cacheDir: warmCache,
    env,
  });
  assert.equal(warm.action, "installed");
  assert.equal(fs.existsSync(path.join(warm.dir, "node_modules", "oh-my-openagent", "package.json")), true);
  assert.match(fs.readFileSync(calls, "utf8"), /oh-my-openagent@latest/);

  fs.rmSync(calls, { force: true });
  const ready = ensureOhMyPluginCache({
    cacheDir: warmCache,
    env,
  });
  assert.equal(ready.action, "noop");
  assert.equal(fs.existsSync(calls), false);

  const prewarmDisabled = ensureOhMyPluginCache({
    cacheDir: warmCache,
    env: { ...env, ENABLE_OMO_CACHE_PREWARM: "false" },
  });
  assert.deepEqual(prewarmDisabled, { action: "skipped", reason: "prewarm_disabled" });

  assert.ok(DEFAULT_STATE_PATH.includes("oh-my-plugin-refresh.json"));
  fs.rmSync(dir, { recursive: true, force: true });
  console.log("plugin refresh ok");
};

run();
