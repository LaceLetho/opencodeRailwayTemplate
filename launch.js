const fs = require("fs");
const path = require("path");

function canExec(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveOpencodeLaunch(opts) {
  const env = opts.env || process.env;
  const args = [
    "--print-logs",
    "--log-level",
    opts.logLevel,
    "serve",
    "--port",
    opts.internalPort,
    "--hostname",
    "127.0.0.1",
  ];
  const sourceDir = env.OPENCODE_SOURCE_DIR || "/opt/opencode";
  const compiledDir = path.join(sourceDir, "packages", "opencode", "dist");
  const compiled = fs.existsSync(compiledDir)
    ? fs
        .readdirSync(compiledDir)
        .map((item) => path.join(compiledDir, item, "bin", "opencode"))
        .find(canExec)
    : undefined;
  if (compiled) {
    return {
      cmd: compiled,
      args,
      mode: "compiled",
    };
  }

  return {
    error: `No compiled OpenCode launcher found in ${compiledDir}. This image only supports running the prebuilt standalone binary.`,
  };
}

module.exports = {
  resolveOpencodeLaunch,
};
