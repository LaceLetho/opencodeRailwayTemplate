const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  deepMerge,
  ensurePluginEntries,
  ensureRuntimeConfigs,
} = require("../runtime-config");

const writeJson = (filePath, value) => {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const run = () => {
  assert.deepEqual(
    ensurePluginEntries([], true),
    ["@laceletho/plugin-openclaw", "oh-my-opencode@latest"],
  );

  assert.deepEqual(
    ensurePluginEntries(["oh-my-openagent@beta"], true),
    ["oh-my-openagent@beta", "@laceletho/plugin-openclaw"],
  );

  assert.deepEqual(
    ensurePluginEntries(["@laceletho/plugin-openclaw"], false),
    ["@laceletho/plugin-openclaw"],
  );

  assert.deepEqual(
    ensurePluginEntries(["oh-my-opencode@1.2.3", "@laceletho/plugin-openclaw"], true),
    ["oh-my-opencode@1.2.3", "@laceletho/plugin-openclaw"],
  );

  assert.deepEqual(
    ensurePluginEntries(["oh-my-opencode@latest", "@laceletho/plugin-openclaw"], false),
    ["@laceletho/plugin-openclaw"],
  );

  assert.deepEqual(
    deepMerge(
      {
        agents: {
          oracle: { model: "openai/gpt-5.4", variant: "high" },
          explore: { model: "opencode/gpt-5-nano" },
        },
      },
      {
        agents: {
          oracle: { variant: "medium" },
        },
      },
    ),
    {
      agents: {
        oracle: { model: "openai/gpt-5.4", variant: "medium" },
        explore: { model: "opencode/gpt-5-nano" },
      },
    },
  );

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-runtime-config-"));
  const opencodeConfigPath = path.join(dir, "opencode.json");
  const omoConfigPath = path.join(dir, "oh-my-opencode.json");
  const omoTemplatePath = path.join(dir, "oh-my-opencode.default.json");

  writeJson(omoTemplatePath, {
    agents: {
      sisyphus: { model: "kimi-for-coding/k2p5" },
      oracle: { model: "openai/gpt-5.4", variant: "high" },
    },
  });
  writeJson(opencodeConfigPath, {
    plugins: ["old-entry"],
    plugin: ["oh-my-openagent@beta"],
  });
  writeJson(omoConfigPath, {
    agents: {
      oracle: { variant: "medium" },
    },
  });

  ensureRuntimeConfigs({
    opencodeConfigPath,
    omoConfigPath,
    omoTemplatePath,
    enableOhMyOpencode: true,
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(opencodeConfigPath, "utf8")), {
    plugin: ["oh-my-openagent@beta", "@laceletho/plugin-openclaw"],
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(omoConfigPath, "utf8")), {
    agents: {
      sisyphus: { model: "kimi-for-coding/k2p5" },
      oracle: { model: "openai/gpt-5.4", variant: "medium" },
    },
  });

  writeJson(opencodeConfigPath, {
    plugin: ["oh-my-opencode@1.2.3", "@laceletho/plugin-openclaw"],
  });

  ensureRuntimeConfigs({
    opencodeConfigPath,
    omoConfigPath,
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
