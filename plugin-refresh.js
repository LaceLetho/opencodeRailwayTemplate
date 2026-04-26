const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const {
  OMO_LEGACY_PLUGIN_NAME,
  OMO_PLUGIN,
  OMO_PLUGIN_NAME,
} = require("./runtime-config");

const DEFAULT_CACHE_DIR = "/data/.cache/opencode";
const DEFAULT_STATE_PATH = "/data/.local/state/opencode/oh-my-plugin-refresh.json";
const DEPLOYMENT_KEYS = ["RAILWAY_DEPLOYMENT_ID", "RAILWAY_SNAPSHOT_ID"];
const NPM_INSTALL_ARGS = [
  "install",
  "--save-prod",
  "--save-prefix=",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
];

const readJson = (filePath, fallback) => {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
};

const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const getDeploymentState = (env) => {
  const state = {};
  for (const key of DEPLOYMENT_KEYS) {
    if (env[key]) state[key] = env[key];
  }
  return state;
};

const getDeploymentId = (env) => {
  const state = getDeploymentState(env);
  if (state.RAILWAY_DEPLOYMENT_ID && state.RAILWAY_SNAPSHOT_ID) {
    return `${state.RAILWAY_DEPLOYMENT_ID}:${state.RAILWAY_SNAPSHOT_ID}`;
  }
  return state.RAILWAY_DEPLOYMENT_ID || state.RAILWAY_SNAPSHOT_ID || "";
};

const removePath = (filePath, removed) => {
  if (!fs.existsSync(filePath)) return;
  fs.rmSync(filePath, { recursive: true, force: true });
  removed.push(filePath);
};

const removePackages = (dir, names, removed) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir)) {
    if (!names.some((name) => entry === name || entry.startsWith(`${name}-`))) continue;
    removePath(path.join(dir, entry), removed);
  }
};

const removeBins = (dir, removed) => {
  if (!fs.existsSync(dir)) return;
  for (const name of [OMO_PLUGIN_NAME, OMO_LEGACY_PLUGIN_NAME, "oh-my-opencode"]) {
    removePath(path.join(dir, name), removed);
  }
};

const refreshPluginCache = (opts = {}) => {
  const env = opts.env || process.env;
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const statePath = opts.statePath || DEFAULT_STATE_PATH;

  if (env.ENABLE_OH_MY_OPENCODE === "false") {
    return { action: "skipped", reason: "plugin_disabled" };
  }

  if (env.ENABLE_OMO_REDEPLOY_REFRESH === "false") {
    return { action: "skipped", reason: "refresh_disabled" };
  }

  const deployment = getDeploymentId(env);
  const deploymentState = getDeploymentState(env);
  if (!deployment) {
    return { action: "skipped", reason: "missing_deployment_id" };
  }

  const prev = readJson(statePath, {});
  if (prev.deployment === deployment) {
    return { action: "noop", deployment };
  }

  const removed = [];
  for (const spec of [OMO_PLUGIN, `${OMO_LEGACY_PLUGIN_NAME}@latest`]) {
    removePath(path.join(cacheDir, "packages", spec), removed);
  }
  for (const dir of [
    path.join(cacheDir, "packages", "node_modules"),
    path.join(cacheDir, "node_modules"),
  ]) {
    removePackages(dir, [OMO_PLUGIN_NAME, OMO_LEGACY_PLUGIN_NAME], removed);
    removeBins(path.join(dir, ".bin"), removed);
  }

  writeJson(statePath, { deployment, ...deploymentState });
  return { action: "refreshed", deployment, removed };
};

const ensureOhMyPluginCache = (opts = {}) => {
  const env = opts.env || process.env;
  const cacheDir = opts.cacheDir || DEFAULT_CACHE_DIR;
  const spec = opts.spec || OMO_PLUGIN;
  const name = opts.name || OMO_PLUGIN_NAME;

  if (env.ENABLE_OH_MY_OPENCODE === "false") {
    return { action: "skipped", reason: "plugin_disabled" };
  }

  if (env.ENABLE_OMO_CACHE_PREWARM === "false") {
    return { action: "skipped", reason: "prewarm_disabled" };
  }

  const dir = path.join(cacheDir, "packages", spec);
  const pkg = path.join(dir, "node_modules", name, "package.json");
  if (fs.existsSync(pkg)) {
    return { action: "noop", dir };
  }

  fs.mkdirSync(dir, { recursive: true });
  const result = spawnSync("npm", [...NPM_INSTALL_ARGS, "--prefix", dir, spec], {
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    const msg = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(msg || `npm install ${spec} failed with status ${result.status}`);
  }
  if (!fs.existsSync(pkg)) {
    throw new Error(`npm install ${spec} completed but ${pkg} is missing`);
  }

  return { action: "installed", dir };
};

module.exports = {
  DEFAULT_STATE_PATH,
  ensureOhMyPluginCache,
  getDeploymentState,
  getDeploymentId,
  refreshPluginCache,
};
