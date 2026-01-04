const bcrypt = require("bcrypt");
const { openDb } = require("./db");

function initDb() {
  const db = openDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT CHECK(role IN ('MANAGER','AGENT')) NOT NULL,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id INTEGER PRIMARY KEY,
      campaign_id TEXT UNIQUE,
      name TEXT,
      fixed_owner_user_id INTEGER NULL,
      FOREIGN KEY (fixed_owner_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY,
      created_at TEXT,
      updated_at TEXT,
      phone TEXT NOT NULL,
      phone_canonical TEXT NOT NULL UNIQUE,
      name TEXT NULL,
      channel TEXT CHECK(channel IN ('WhatsApp','Facebook/Instagram','Calls','Website form','Physical','Other')) DEFAULT 'WhatsApp',
      source TEXT NULL,
      campaign_id TEXT NULL,
      owner_user_id INTEGER NOT NULL,
      status TEXT CHECK(status IN ('New','Contacted','Qualified','Won','Lost')) DEFAULT 'New',
      lost_reason TEXT NULL CHECK(lost_reason IN ('Not interested','Price too high','Duplicate','Fake lead')),
      attempts_count INTEGER DEFAULT 0,
      first_contacted_at TEXT NULL,
      last_contact_at TEXT NULL,
      next_followup_at TEXT NULL,
      notes TEXT NULL,
      FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id),
      FOREIGN KEY (owner_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS deals (
      id INTEGER PRIMARY KEY,
      lead_id INTEGER NOT NULL,
      deal_date TEXT,
      product TEXT CHECK(product IN ('Turkey','Tunisia','Visa','Tickets','Hotels','VO','Other')) DEFAULT 'Other',
      amount_dzd INTEGER NOT NULL,
      cost_dzd INTEGER NULL,
      payment_type TEXT CHECK(payment_type IN ('Deposit+Balance','Single')) DEFAULT 'Single',
      payment_proof TEXT NULL,
      notes TEXT NULL,
      FOREIGN KEY (lead_id) REFERENCES leads(id)
    );

    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  const passwordManager = bcrypt.hashSync("manager123", 10);
  const passwordAgent = bcrypt.hashSync("agent123", 10);

  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (username, password_hash, role, active) VALUES (?, ?, ?, 1)"
  );

  insertUser.run("manager", passwordManager, "MANAGER");
  insertUser.run("agent1", passwordAgent, "AGENT");
  insertUser.run("agent2", passwordAgent, "AGENT");

  const insertCampaign = db.prepare(
    "INSERT OR IGNORE INTO campaigns (campaign_id, name, fixed_owner_user_id) VALUES (?, ?, NULL)"
  );
  insertCampaign.run("FB-ADS", "Facebook Ads");
  insertCampaign.run("WHATSAPP", "WhatsApp Outreach");

  const now = new Date().toISOString();
  const insertLead = db.prepare(`
    INSERT OR IGNORE INTO leads (
      created_at, updated_at, phone, phone_canonical, name, channel, source, campaign_id,
      owner_user_id, status, notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const agent1 = db.prepare("SELECT id FROM users WHERE username = 'agent1'").get();
  const agent2 = db.prepare("SELECT id FROM users WHERE username = 'agent2'").get();

  insertLead.run(
    now,
    now,
    "0550 12 34 56",
    "0550123456",
    "Nadia",
    "WhatsApp",
    "Summer 2026",
    "WHATSAPP",
    agent1.id,
    "New",
    "Seed lead"
  );
  insertLead.run(
    now,
    now,
    "0770-99-88-77",
    "0770998877",
    "Yacine",
    "Calls",
    "Walk-in",
    "FB-ADS",
    agent2.id,
    "Contacted",
    "Seed lead"
  );

  const lead1 = db.prepare("SELECT id FROM leads WHERE phone_canonical = '0550123456'").get();
  if (lead1) {
    db.prepare(
      "INSERT OR IGNORE INTO deals (lead_id, deal_date, product, amount_dzd, cost_dzd, payment_type, notes) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(lead1.id, now.slice(0, 10), "Turkey", 250000, 200000, "Deposit+Balance", "Seed deal");
  }

  db.close();
}

if (require.main === module) {
  initDb();
  console.log("Database initialized.");
}

module.exports = { initDb };
