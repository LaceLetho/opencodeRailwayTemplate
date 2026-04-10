const fs = require("fs");
const path = require("path");

const OPENCLAW_PLUGIN = "@laceletho/plugin-openclaw";
const OMO_PLUGIN = "oh-my-openagent@latest";
const OMO_PLUGIN_NAME = "oh-my-openagent";
const OMO_LEGACY_PLUGIN_NAME = "oh-my-opencode";
const DEFAULT_OPENCODE_CONFIG_PATH = "/data/.config/opencode/opencode.json";
const DEFAULT_OMO_CANONICAL_CONFIG_JSONC_PATH = "/data/.config/opencode/oh-my-openagent.jsonc";
const DEFAULT_OMO_CANONICAL_CONFIG_PATH = "/data/.config/opencode/oh-my-openagent.json";
const DEFAULT_OMO_CONFIG_JSONC_PATH = "/data/.config/opencode/oh-my-opencode.jsonc";
const DEFAULT_OMO_CONFIG_PATH = "/data/.config/opencode/oh-my-opencode.json";
const DEFAULT_OMO_TEMPLATE_PATH = path.join(__dirname, "oh-my-opencode.default.json");

const readJson = (filePath, fallback) => {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }

  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content);
};

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const isOhMyOpencodePlugin = (value) =>
  typeof value === "string" &&
  (
    value === OMO_PLUGIN_NAME ||
    value.startsWith(`${OMO_PLUGIN_NAME}@`) ||
    value === OMO_LEGACY_PLUGIN_NAME ||
    value.startsWith(`${OMO_LEGACY_PLUGIN_NAME}@`)
  );

const ensurePluginEntries = (plugins, enableOhMyOpencode) => {
  const current = Array.isArray(plugins)
    ? plugins.filter((value) => typeof value === "string" && value.trim())
    : [];

  let hasOpenclaw = false;
  let hasOhMyOpencode = false;
  const next = [];

  for (const value of current) {
    if (value === OPENCLAW_PLUGIN) {
      if (!hasOpenclaw) {
        next.push(value);
        hasOpenclaw = true;
      }
      continue;
    }

    if (isOhMyOpencodePlugin(value)) {
      if (enableOhMyOpencode && !hasOhMyOpencode) {
        next.push(OMO_PLUGIN);
        hasOhMyOpencode = true;
      }
      continue;
    }

    next.push(value);
  }

  if (!hasOpenclaw) {
    next.push(OPENCLAW_PLUGIN);
  }

  if (!enableOhMyOpencode) {
    return next;
  }

  if (!hasOhMyOpencode) {
    next.push(OMO_PLUGIN);
  }

  return next;
};

const ensureRuntimeConfigs = (opts = {}) => {
  const opencodeConfigPath = opts.opencodeConfigPath || DEFAULT_OPENCODE_CONFIG_PATH;
  const omoConfigJsoncPath = opts.omoConfigJsoncPath || DEFAULT_OMO_CONFIG_JSONC_PATH;
  const omoConfigPath = opts.omoConfigPath || DEFAULT_OMO_CONFIG_PATH;
  const omoCanonicalConfigJsoncPath = opts.omoCanonicalConfigJsoncPath || DEFAULT_OMO_CANONICAL_CONFIG_JSONC_PATH;
  const omoCanonicalConfigPath = opts.omoCanonicalConfigPath || DEFAULT_OMO_CANONICAL_CONFIG_PATH;
  const omoTemplatePath = opts.omoTemplatePath || DEFAULT_OMO_TEMPLATE_PATH;
  const enableOhMyOpencode = opts.enableOhMyOpencode !== false;

  const opencodeConfig = readJson(opencodeConfigPath, {});
  if (opencodeConfig.plugins !== undefined) {
    delete opencodeConfig.plugins;
  }
  opencodeConfig.plugin = ensurePluginEntries(opencodeConfig.plugin, enableOhMyOpencode);
  writeJson(opencodeConfigPath, opencodeConfig);

  if (!enableOhMyOpencode) {
    return;
  }

  const defaults = readJson(omoTemplatePath, {});
  for (const filePath of [
    omoConfigJsoncPath,
    omoConfigPath,
    omoCanonicalConfigJsoncPath,
    omoCanonicalConfigPath,
  ]) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  }
  writeJson(omoConfigJsoncPath, defaults);
  writeJson(omoConfigPath, defaults);
  writeJson(omoCanonicalConfigJsoncPath, defaults);
  writeJson(omoCanonicalConfigPath, defaults);
};

module.exports = {
  OMO_LEGACY_PLUGIN_NAME,
  OMO_PLUGIN,
  OMO_PLUGIN_NAME,
  ensurePluginEntries,
  ensureRuntimeConfigs,
};
