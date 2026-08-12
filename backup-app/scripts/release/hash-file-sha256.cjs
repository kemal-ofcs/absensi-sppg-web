const fs = require("node:fs");
const crypto = require("node:crypto");

const targetPath = process.argv[2];

if (!targetPath) {
  console.error("Usage: node scripts/hash-file-sha256.cjs <path>");
  process.exit(1);
}

const hash = crypto.createHash("sha256");
const stream = fs.createReadStream(targetPath);

stream.on("data", (chunk) => hash.update(chunk));
stream.on("end", () => {
  process.stdout.write(`${hash.digest("hex")}\n`);
});
stream.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
