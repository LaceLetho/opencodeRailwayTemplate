const fs = require("fs");
const path = require("path");

const OPENCLAW_PLUGIN = "@laceletho/plugin-openclaw";
const OMO_PLUGIN = "oh-my-opencode@latest";
const OMO_PLUGIN_NAME = "oh-my-opencode";
const OMO_LEGACY_PLUGIN_NAME = "oh-my-openagent";
const DEFAULT_OPENCODE_CONFIG_PATH = "/data/.config/opencode/opencode.json";
const DEFAULT_OMO_CONFIG_PATH = "/data/.config/opencode/oh-my-opencode.json";
const DEFAULT_OMO_TEMPLATE_PATH = path.join(__dirname, "oh-my-opencode.default.json");

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

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
        next.push(value);
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

const deepMerge = (base, override) => {
  if (!isRecord(base)) {
    return override;
  }

  if (!isRecord(override)) {
    return { ...base };
  }

  const merged = { ...base };

  for (const key of Object.keys(override)) {
    const baseValue = merged[key];
    const overrideValue = override[key];

    if (isRecord(baseValue) && isRecord(overrideValue)) {
      merged[key] = deepMerge(baseValue, overrideValue);
      continue;
    }

    merged[key] = overrideValue;
  }

  return merged;
};

const ensureRuntimeConfigs = (opts = {}) => {
  const opencodeConfigPath = opts.opencodeConfigPath || DEFAULT_OPENCODE_CONFIG_PATH;
  const omoConfigPath = opts.omoConfigPath || DEFAULT_OMO_CONFIG_PATH;
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
  const current = readJson(omoConfigPath, {});
  writeJson(omoConfigPath, deepMerge(defaults, current));
};

module.exports = {
  deepMerge,
  ensurePluginEntries,
  ensureRuntimeConfigs,
};
