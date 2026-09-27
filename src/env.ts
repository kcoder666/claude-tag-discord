import fs from "node:fs";

// Load .env before anything reads process.env. Imported first by the entry points.
if (fs.existsSync(".env")) process.loadEnvFile(".env");
