const assert = require("assert").strict;
const fs = require("fs");
const os = require("os");
const path = require("path");

const { resolveOpencodeLaunch } = require("../launch");

const run = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-launch-"));
  const dist = path.join(dir, "packages", "opencode", "dist", "linux-x64");
  const bin = path.join(dist, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, "opencode");
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, 0o755);

  const compiled = resolveOpencodeLaunch({
    env: {
      OPENCODE_SOURCE_DIR: dir,
    },
    internalPort: "18080",
    logLevel: "INFO",
  });
  assert.equal(compiled.mode, "compiled");
  assert.equal(compiled.cmd, file);

  const missing = resolveOpencodeLaunch({
    env: {
      OPENCODE_SOURCE_DIR: "/definitely-missing",
    },
    internalPort: "18080",
    logLevel: "INFO",
  });
  assert.match(missing.error, /No compiled OpenCode launcher found/);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log("launch resolution ok");
};

run();
