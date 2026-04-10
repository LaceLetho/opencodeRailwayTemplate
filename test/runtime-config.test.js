const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  OMO_PLUGIN,
  ensurePluginEntries,
  ensureRuntimeConfigs,
} = require("../runtime-config");

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const run = () => {
  assert.deepEqual(
    ensurePluginEntries([], true),
    ["@laceletho/plugin-openclaw", OMO_PLUGIN],
  );

  assert.deepEqual(
    ensurePluginEntries(["oh-my-openagent@beta"], true),
    [OMO_PLUGIN, "@laceletho/plugin-openclaw"],
  );

  assert.deepEqual(
    ensurePluginEntries(["@laceletho/plugin-openclaw"], false),
    ["@laceletho/plugin-openclaw"],
  );

  assert.deepEqual(
    ensurePluginEntries(["oh-my-opencode@1.2.3", "@laceletho/plugin-openclaw"], true),
    [OMO_PLUGIN, "@laceletho/plugin-openclaw"],
  );

  assert.deepEqual(
    ensurePluginEntries(["oh-my-opencode@latest", "@laceletho/plugin-openclaw"], false),
    ["@laceletho/plugin-openclaw"],
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-runtime-config-"));
  const opencodeConfigPath = path.join(dir, "opencode.json");
  const omoConfigJsoncPath = path.join(dir, "oh-my-opencode.jsonc");
  const omoConfigPath = path.join(dir, "oh-my-opencode.json");
  const omoCanonicalConfigJsoncPath = path.join(dir, "oh-my-openagent.jsonc");
  const omoCanonicalConfigPath = path.join(dir, "oh-my-openagent.json");
  const omoTemplatePath = path.join(dir, "oh-my-opencode.default.json");

  writeJson(omoTemplatePath, {
    $schema: "https://example.com/schema.json",
    agents: {
      explore: { model: "kimi-for-coding/k2p5" },
      librarian: { model: "kimi-for-coding/k2p5" },
    },
  });
  writeJson(opencodeConfigPath, {
    plugins: ["old-entry"],
    plugin: ["oh-my-openagent@beta"],
  });
  writeJson(omoConfigPath, {
    agents: {
      librarian: { model: "kimi-for-coding/k2p5" },
      oracle: { model: "openai/gpt-5.4", variant: "medium" },
    },
  });
  writeJson(omoConfigJsoncPath, { stale: true });
  writeJson(omoCanonicalConfigJsoncPath, { stale: true });

  ensureRuntimeConfigs({
    opencodeConfigPath,
    omoConfigJsoncPath,
    omoConfigPath,
    omoCanonicalConfigJsoncPath,
    omoCanonicalConfigPath,
    omoTemplatePath,
    enableOhMyOpencode: true,
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(opencodeConfigPath, "utf8")), {
    plugin: [OMO_PLUGIN, "@laceletho/plugin-openclaw"],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(omoConfigPath, "utf8")), {
    $schema: "https://example.com/schema.json",
    agents: {
      explore: { model: "kimi-for-coding/k2p5" },
      librarian: { model: "kimi-for-coding/k2p5" },
    },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(omoConfigJsoncPath, "utf8")), {
    $schema: "https://example.com/schema.json",
    agents: {
      explore: { model: "kimi-for-coding/k2p5" },
      librarian: { model: "kimi-for-coding/k2p5" },
    },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(omoCanonicalConfigPath, "utf8")), {
    $schema: "https://example.com/schema.json",
    agents: {
      explore: { model: "kimi-for-coding/k2p5" },
      librarian: { model: "kimi-for-coding/k2p5" },
    },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(omoCanonicalConfigJsoncPath, "utf8")), {
    $schema: "https://example.com/schema.json",
    agents: {
      explore: { model: "kimi-for-coding/k2p5" },
      librarian: { model: "kimi-for-coding/k2p5" },
    },
  });

  writeJson(opencodeConfigPath, {
    plugin: ["oh-my-opencode@1.2.3", "@laceletho/plugin-openclaw"],
  });

  ensureRuntimeConfigs({
    opencodeConfigPath,
    omoConfigJsoncPath,
    omoConfigPath,
    omoCanonicalConfigJsoncPath,
    omoCanonicalConfigPath,
    omoTemplatePath,
    enableOhMyOpencode: false,
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(opencodeConfigPath, "utf8")), {
    plugin: ["@laceletho/plugin-openclaw"],
  });

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("runtime config ok");
};

run();
