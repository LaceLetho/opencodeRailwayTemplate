const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveOpencodeLaunch } = require("../launch");

const run = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-launch-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "opencode");
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);

  const viaBin = resolveOpencodeLaunch({
    env: {
      BUN_INSTALL: dir,
      PATH: "",
    },
    internalPort: "18080",
    logLevel: "INFO",
  });
  assert.equal(viaBin.mode, "opencode");
  assert.equal(viaBin.cmd, file);

  const missing = resolveOpencodeLaunch({
    env: {
      BUN_INSTALL: "/definitely-missing",
      PATH: "",
    },
    internalPort: "18080",
    logLevel: "INFO",
  });
  assert.match(missing.error, /No OpenCode launcher found/);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("launch resolution ok");
};

run();
