const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function findBundledNode() {
  if (process.platform !== "win32") return null;
  const toolsDir = path.join(__dirname, ".tools");
  if (!fs.existsSync(toolsDir)) return null;
  const entries = fs.readdirSync(toolsDir, { withFileTypes: true });
  const nodeDir = entries
    .filter((e) => e.isDirectory() && e.name.startsWith("node-v20") && e.name.endsWith("-win-x64"))
    .map((e) => path.join(toolsDir, e.name))
    .sort()
    .reverse()[0];
  if (!nodeDir) return null;
  const nodeExe = path.join(nodeDir, "node.exe");
  return fs.existsSync(nodeExe) ? nodeExe : null;
}

const nodePath = findBundledNode() || process.execPath;
const child = spawn(nodePath, [path.join(__dirname, "server.js")], {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code) => process.exit(code || 0));
