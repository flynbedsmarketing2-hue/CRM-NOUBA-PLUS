const path = require("path");
const fs = require("fs");
const os = require("os");
const Database = require("better-sqlite3");

const isVercel = !!process.env.VERCEL;
const DATA_DIR =
  process.env.DATA_DIR ||
  (isVercel
    ? path.join(os.tmpdir(), "crm-data")
    : fs.existsSync(path.resolve("/data"))
      ? path.resolve("/data")
      : path.join(__dirname, "data"));
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "crm.sqlite");

function openDb() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  return db;
}

module.exports = { openDb, DB_PATH, DATA_DIR };
