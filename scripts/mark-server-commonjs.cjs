const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

const outDir = join(process.cwd(), "build", "server");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "package.json"), '{"type":"commonjs"}\n');

