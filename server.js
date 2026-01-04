const path = require("path");
const fs = require("fs");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcrypt");
const multer = require("multer");
const { openDb, DB_PATH, DATA_DIR } = require("./db");
const { normalizePhone } = require("./utils/phone");
const { parseCsv } = require("./utils/csv");

if (!fs.existsSync(DB_PATH)) {
  require("./init_db").initDb();
}

const db = openDb();
const app = express();

const upload = multer({ storage: multer.memoryStorage() });
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const proofStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    const name = `proof-${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`;
    cb(null, name);
  }
});
const uploadProof = multer({ storage: proofStorage });

const CHANNELS = ["WhatsApp", "Facebook/Instagram", "Calls", "Website form", "Physical", "Other"];
const STATUSES = ["New", "Contacted", "Qualified", "Won", "Lost"];
const LOST_REASONS = ["Not interested", "Price too high", "Duplicate", "Fake lead"];
const PRODUCTS = ["Turkey", "Tunisia", "Visa", "Tickets", "Hotels", "VO", "Other"];
const PAYMENT_TYPES = ["Deposit+Balance", "Single"];

const dealColumns = db.prepare("PRAGMA table_info(deals)").all();
const hasPaymentProof = dealColumns.some((col) => col.name === "payment_proof");
if (!hasPaymentProof) {
  db.exec("ALTER TABLE deals ADD COLUMN payment_proof TEXT NULL");
}

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(UPLOAD_DIR));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "dev-secret",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true }
  })
);

app.use((req, res, next) => {
  if (req.session.userId) {
    const user = db
      .prepare("SELECT id, username, role, active FROM users WHERE id = ?")
      .get(req.session.userId);
    if (!user || !user.active) {
      req.session.destroy(() => {});
    } else {
      req.user = user;
      res.locals.user = user;
    }
  }
  if (!res.locals.user) {
    res.locals.user = null;
  }
  res.locals.msg = req.query.msg || "";
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect("/login");
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).send("Forbidden");
    }
    next();
  };
}

function nowIso() {
  return new Date().toISOString();
}

function getCampaigns() {
  return db
    .prepare(
      "SELECT c.id, c.campaign_id, c.name, c.fixed_owner_user_id, u.username AS fixed_owner_username FROM campaigns c LEFT JOIN users u ON c.fixed_owner_user_id = u.id ORDER BY c.campaign_id"
    )
    .all();
}

function getAgents() {
  return db
    .prepare("SELECT id, username FROM users WHERE role = 'AGENT' AND active = 1 ORDER BY id")
    .all();
}

function autoAssignOwner(campaignId) {
  if (campaignId) {
    const campaign = db
      .prepare("SELECT fixed_owner_user_id FROM campaigns WHERE campaign_id = ?")
      .get(campaignId);
    if (campaign && campaign.fixed_owner_user_id) {
      return campaign.fixed_owner_user_id;
    }
  }

  const agents = getAgents();
  if (!agents.length) return null;

  const row = db.prepare("SELECT value FROM app_state WHERE key = 'rr_agent_index'").get();
  const idx = row ? parseInt(row.value, 10) : 0;
  const pick = agents[idx % agents.length];
  const nextIdx = (idx + 1) % agents.length;

  db.prepare(
    "INSERT INTO app_state (key, value) VALUES ('rr_agent_index', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(nextIdx));

  return pick.id;
}

function clampEnum(value, list, fallback) {
  if (!value) return fallback;
  return list.includes(value) ? value : fallback;
}

function leadScopeWhere(user) {
  if (user.role === "MANAGER") {
    return { where: "1=1", params: [] };
  }
  return { where: "l.owner_user_id = ?", params: [user.id] };
}

function dealScopeWhere(user) {
  if (user.role === "MANAGER") {
    return { where: "1=1", params: [] };
  }
  return { where: "l.owner_user_id = ?", params: [user.id] };
}

app.get("/login", (req, res) => {
  res.render("login");
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !user.active) {
    return res.redirect("/login?msg=Invalid%20credentials");
  }
  const ok = bcrypt.compareSync(password, user.password_hash);
  if (!ok) {
    return res.redirect("/login?msg=Invalid%20credentials");
  }
  req.session.userId = user.id;
  res.redirect("/");
});

app.post("/logout", requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/", requireAuth, (req, res) => {
  const scope = leadScopeWhere(req.user);

  const leadsByChannel = db
    .prepare(
      `SELECT l.channel, COUNT(*) AS count FROM leads l WHERE ${scope.where} GROUP BY l.channel ORDER BY count DESC`
    )
    .all(...scope.params);

  const leadsByCampaign = db
    .prepare(
      `SELECT l.campaign_id, COUNT(*) AS count FROM leads l WHERE ${scope.where} GROUP BY l.campaign_id ORDER BY count DESC`
    )
    .all(...scope.params);

  const conversionByAgent = db
    .prepare(
      req.user.role === "MANAGER"
        ? "SELECT u.username, SUM(CASE WHEN l.status = 'Won' THEN 1 ELSE 0 END) AS won, COUNT(*) AS total FROM leads l JOIN users u ON l.owner_user_id = u.id GROUP BY u.username ORDER BY u.username"
        : "SELECT u.username, SUM(CASE WHEN l.status = 'Won' THEN 1 ELSE 0 END) AS won, COUNT(*) AS total FROM leads l JOIN users u ON l.owner_user_id = u.id WHERE l.owner_user_id = ? GROUP BY u.username ORDER BY u.username"
    )
    .all(...(req.user.role === "MANAGER" ? [] : [req.user.id]));

  const revenueRows = db
    .prepare(
      `SELECT SUM(d.amount_dzd) AS total_amount, SUM(d.cost_dzd) AS total_cost FROM deals d JOIN leads l ON d.lead_id = l.id WHERE ${scope.where}`
    )
    .get(...scope.params);

  const responseRow = db
    .prepare(
      `SELECT AVG((julianday(l.first_contacted_at) - julianday(l.created_at)) * 24.0) AS avg_hours FROM leads l WHERE l.first_contacted_at IS NOT NULL AND ${scope.where}`
    )
    .get(...scope.params);

  res.render("dashboard", {
    leadsByChannel,
    leadsByCampaign,
    conversionByAgent,
    revenue: {
      amount: revenueRows.total_amount || 0,
      cost: revenueRows.total_cost || 0,
      margin: (revenueRows.total_amount || 0) - (revenueRows.total_cost || 0)
    },
    avgResponseHours: responseRow.avg_hours || 0
  });
});

app.get("/leads", requireAuth, (req, res) => {
  const { status, owner, channel, campaign, q } = req.query;
  const filters = [];
  const params = [];

  if (req.user.role !== "MANAGER") {
    filters.push("l.owner_user_id = ?");
    params.push(req.user.id);
  } else if (owner) {
    filters.push("l.owner_user_id = ?");
    params.push(owner);
  }
  if (status) {
    filters.push("l.status = ?");
    params.push(status);
  }
  if (channel) {
    filters.push("l.channel = ?");
    params.push(channel);
  }
  if (campaign) {
    filters.push("l.campaign_id = ?");
    params.push(campaign);
  }
  if (q) {
    filters.push("(l.phone LIKE ? OR l.name LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }

  const where = filters.length ? filters.join(" AND ") : "1=1";

  const leads = db
    .prepare(
      `SELECT l.*, u.username AS owner_username FROM leads l JOIN users u ON l.owner_user_id = u.id WHERE ${where} ORDER BY l.created_at DESC`
    )
    .all(...params);

  res.render("leads", {
    leads,
    campaigns: getCampaigns(),
    agents: req.user.role === "MANAGER" ? getAgents() : [],
    filters: { status, owner, channel, campaign, q },
    lists: { CHANNELS, STATUSES }
  });
});

app.get("/leads/new", requireAuth, (req, res) => {
  res.render("leads_new", {
    campaigns: getCampaigns(),
    lists: { CHANNELS }
  });
});

app.post("/leads", requireAuth, (req, res) => {
  const { phone, channel, campaign_id, name } = req.body;
  const { original, canonical } = normalizePhone(phone);
  if (!canonical) {
    return res.redirect("/leads/new?msg=Phone%20required");
  }
  const existing = db.prepare("SELECT id FROM leads WHERE phone_canonical = ?").get(canonical);
  if (existing) {
    return res.redirect("/leads?msg=Duplicate%20phone%20lead");
  }

  const ownerId = autoAssignOwner(campaign_id || null);
  if (!ownerId) {
    return res.redirect("/leads/new?msg=No%20active%20agent%20available");
  }

  const now = nowIso();
  db.prepare(
    `INSERT INTO leads (created_at, updated_at, phone, phone_canonical, name, channel, campaign_id, owner_user_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'New')`
  ).run(
    now,
    now,
    original,
    canonical,
    name || null,
    clampEnum(channel, CHANNELS, "WhatsApp"),
    campaign_id || null,
    ownerId
  );

  res.redirect("/leads?msg=Lead%20created");
});

app.get("/leads/:id", requireAuth, (req, res) => {
  const leadId = req.params.id;
  const scope = leadScopeWhere(req.user);

  const lead = db
    .prepare(
      `SELECT l.*, u.username AS owner_username FROM leads l JOIN users u ON l.owner_user_id = u.id WHERE l.id = ? AND ${scope.where}`
    )
    .get(leadId, ...scope.params);

  if (!lead) return res.status(404).send("Not found");

  res.render("lead_detail", {
    lead,
    campaigns: getCampaigns(),
    agents: req.user.role === "MANAGER" ? getAgents() : [],
    lists: { CHANNELS, STATUSES, LOST_REASONS }
  });
});

app.post("/leads/:id", requireAuth, (req, res) => {
  const leadId = req.params.id;
  const scope = leadScopeWhere(req.user);

  const existing = db
    .prepare(`SELECT * FROM leads l WHERE l.id = ? AND ${scope.where}`)
    .get(leadId, ...scope.params);

  if (!existing) return res.status(404).send("Not found");

  const { status, lost_reason, next_followup_at, notes, name, channel, campaign_id, owner_user_id } = req.body;

  const newStatus = clampEnum(status, STATUSES, existing.status);
  const newLost = newStatus === "Lost" ? clampEnum(lost_reason, LOST_REASONS, null) : null;
  const newOwner = req.user.role === "MANAGER" && owner_user_id ? owner_user_id : existing.owner_user_id;

  db.prepare(
    `UPDATE leads SET
      updated_at = ?,
      name = ?,
      channel = ?,
      campaign_id = ?,
      owner_user_id = ?,
      status = ?,
      lost_reason = ?,
      next_followup_at = ?,
      notes = ?
     WHERE id = ?`
  ).run(
    nowIso(),
    name || null,
    clampEnum(channel, CHANNELS, existing.channel),
    campaign_id || null,
    newOwner,
    newStatus,
    newLost,
    next_followup_at || null,
    notes || null,
    leadId
  );

  res.redirect(`/leads/${leadId}?msg=Saved`);
});

app.post("/leads/:id/attempt", requireAuth, (req, res) => {
  const leadId = req.params.id;
  const scope = leadScopeWhere(req.user);

  const lead = db
    .prepare(`SELECT * FROM leads l WHERE l.id = ? AND ${scope.where}`)
    .get(leadId, ...scope.params);
  if (!lead) return res.status(404).send("Not found");

  db.prepare(
    "UPDATE leads SET attempts_count = attempts_count + 1, last_contact_at = ?, updated_at = ? WHERE id = ?"
  ).run(nowIso(), nowIso(), leadId);

  res.redirect(`/leads/${leadId}?msg=Attempt%20recorded`);
});

app.post("/leads/:id/delete", requireAuth, requireRole("MANAGER"), (req, res) => {
  const leadId = req.params.id;
  const lead = db.prepare("SELECT id FROM leads WHERE id = ?").get(leadId);
  if (!lead) return res.status(404).send("Not found");

  const tx = db.transaction(() => {
    db.prepare("DELETE FROM deals WHERE lead_id = ?").run(leadId);
    db.prepare("DELETE FROM leads WHERE id = ?").run(leadId);
  });
  tx();

  res.redirect("/leads?msg=Lead%20deleted");
});

app.get("/deals", requireAuth, (req, res) => {
  const { owner, campaign } = req.query;
  const filters = [];
  const params = [];

  if (req.user.role !== "MANAGER") {
    filters.push("l.owner_user_id = ?");
    params.push(req.user.id);
  } else if (owner) {
    filters.push("l.owner_user_id = ?");
    params.push(owner);
  }

  if (campaign) {
    filters.push("l.campaign_id = ?");
    params.push(campaign);
  }

  const where = filters.length ? filters.join(" AND ") : "1=1";

  const deals = db
    .prepare(
      `SELECT d.*, l.phone, l.name, l.campaign_id, u.username AS owner_username FROM deals d JOIN leads l ON d.lead_id = l.id JOIN users u ON l.owner_user_id = u.id WHERE ${where} ORDER BY d.deal_date DESC, d.id DESC`
    )
    .all(...params);

  res.render("deals", {
    deals,
    campaigns: getCampaigns(),
    agents: req.user.role === "MANAGER" ? getAgents() : [],
    filters: { owner, campaign },
    lists: { PRODUCTS, PAYMENT_TYPES }
  });
});

app.get("/deals/new", requireAuth, (req, res) => {
  const leadId = req.query.lead_id;
  let lead = null;
  if (leadId) {
    const scope = leadScopeWhere(req.user);
    lead = db
      .prepare(`SELECT l.* FROM leads l WHERE l.id = ? AND ${scope.where}`)
      .get(leadId, ...scope.params);
  }

  const scope = leadScopeWhere(req.user);
  const leads = db
    .prepare(
      `SELECT l.id, l.phone, l.name FROM leads l WHERE ${scope.where} ORDER BY l.created_at DESC`
    )
    .all(...scope.params);

  res.render("deals_new", {
    lead,
    leads,
    lists: { PRODUCTS, PAYMENT_TYPES }
  });
});

app.post("/deals", requireAuth, uploadProof.single("payment_proof_file"), (req, res) => {
  const { lead_id, deal_date, product, amount_dzd, cost_dzd, payment_type, notes, set_won } = req.body;
  const scope = leadScopeWhere(req.user);

  const lead = db
    .prepare(`SELECT l.* FROM leads l WHERE l.id = ? AND ${scope.where}`)
    .get(lead_id, ...scope.params);
  if (!lead) return res.status(404).send("Not found");

  const amount = parseInt(amount_dzd, 10);
  if (Number.isNaN(amount)) {
    return res.redirect(`/deals/new?lead_id=${lead_id}&msg=Amount%20required`);
  }

  const cost = req.user.role === "MANAGER" && cost_dzd ? parseInt(cost_dzd, 10) : null;

  const paymentProof = req.file ? req.file.filename : null;
  const leadIsWon = lead.status === "Won" || !!set_won;
  if (leadIsWon && !paymentProof) {
    return res.redirect(`/deals/new?lead_id=${lead_id}&msg=Payment%20proof%20required`);
  }
  db.prepare(
    `INSERT INTO deals (lead_id, deal_date, product, amount_dzd, cost_dzd, payment_type, payment_proof, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lead_id,
    deal_date || null,
    clampEnum(product, PRODUCTS, "Other"),
    amount,
    Number.isNaN(cost) ? null : cost,
    clampEnum(payment_type, PAYMENT_TYPES, "Single"),
    paymentProof,
    notes || null
  );

  if (set_won) {
    db.prepare("UPDATE leads SET status = 'Won', updated_at = ? WHERE id = ?").run(nowIso(), lead_id);
  }

  res.redirect("/deals?msg=Deal%20created");
});

app.get("/deals/:id", requireAuth, (req, res) => {
  const dealId = req.params.id;
  const scope = dealScopeWhere(req.user);
  const deal = db
    .prepare(
      `SELECT d.*, l.phone, l.name, l.campaign_id, l.owner_user_id, l.status AS lead_status, u.username AS owner_username
       FROM deals d JOIN leads l ON d.lead_id = l.id JOIN users u ON l.owner_user_id = u.id
       WHERE d.id = ? AND ${scope.where}`
    )
    .get(dealId, ...scope.params);
  if (!deal) return res.status(404).send("Not found");

  res.render("deal_detail", {
    deal,
    lists: { PRODUCTS, PAYMENT_TYPES }
  });
});

app.post("/deals/:id", requireAuth, uploadProof.single("payment_proof_file"), (req, res) => {
  const dealId = req.params.id;
  const scope = dealScopeWhere(req.user);
  const deal = db
    .prepare(
      `SELECT d.*, l.owner_user_id, l.status AS lead_status FROM deals d JOIN leads l ON d.lead_id = l.id WHERE d.id = ? AND ${scope.where}`
    )
    .get(dealId, ...scope.params);
  if (!deal) return res.status(404).send("Not found");

  const { deal_date, product, amount_dzd, cost_dzd, payment_type, notes } = req.body;
  const amount = parseInt(amount_dzd, 10);
  if (Number.isNaN(amount)) {
    return res.redirect(`/deals/${dealId}?msg=Amount%20required`);
  }
  const cost = req.user.role === "MANAGER" && cost_dzd ? parseInt(cost_dzd, 10) : null;
  const paymentProof = req.file ? req.file.filename : deal.payment_proof;
  if (deal.lead_status === "Won" && !paymentProof) {
    return res.redirect(`/deals/${dealId}?msg=Payment%20proof%20required`);
  }

  db.prepare(
    `UPDATE deals SET deal_date = ?, product = ?, amount_dzd = ?, cost_dzd = ?, payment_type = ?, payment_proof = ?, notes = ? WHERE id = ?`
  ).run(
    deal_date || null,
    clampEnum(product, PRODUCTS, "Other"),
    amount,
    Number.isNaN(cost) ? null : cost,
    clampEnum(payment_type, PAYMENT_TYPES, "Single"),
    paymentProof || null,
    notes || null,
    dealId
  );

  res.redirect(`/deals/${dealId}?msg=Saved`);
});

app.post("/deals/:id/delete", requireAuth, (req, res) => {
  const dealId = req.params.id;
  const scope = dealScopeWhere(req.user);
  const deal = db
    .prepare(
      `SELECT d.id FROM deals d JOIN leads l ON d.lead_id = l.id WHERE d.id = ? AND ${scope.where}`
    )
    .get(dealId, ...scope.params);
  if (!deal) return res.status(404).send("Not found");

  db.prepare("DELETE FROM deals WHERE id = ?").run(dealId);
  res.redirect("/deals?msg=Deal%20deleted");
});

app.get("/campaigns", requireAuth, requireRole("MANAGER"), (req, res) => {
  res.render("campaigns", {
    campaigns: getCampaigns(),
    agents: getAgents()
  });
});

app.post("/campaigns", requireAuth, requireRole("MANAGER"), (req, res) => {
  const { campaign_id, name, fixed_owner_user_id } = req.body;
  if (!campaign_id) return res.redirect("/campaigns?msg=Campaign%20ID%20required");
  db.prepare(
    "INSERT OR IGNORE INTO campaigns (campaign_id, name, fixed_owner_user_id) VALUES (?, ?, ?)"
  ).run(campaign_id, name || null, fixed_owner_user_id || null);

  res.redirect("/campaigns?msg=Saved");
});

app.post("/campaigns/:id", requireAuth, requireRole("MANAGER"), (req, res) => {
  const { name, fixed_owner_user_id } = req.body;
  db.prepare("UPDATE campaigns SET name = ?, fixed_owner_user_id = ? WHERE id = ?").run(
    name || null,
    fixed_owner_user_id || null,
    req.params.id
  );
  res.redirect("/campaigns?msg=Updated");
});

app.get("/import", requireAuth, requireRole("MANAGER"), (req, res) => {
  res.render("import", { summary: null });
});

function ensureCampaign(campaignId) {
  if (!campaignId) return null;
  const existing = db.prepare("SELECT campaign_id FROM campaigns WHERE campaign_id = ?").get(campaignId);
  if (!existing) {
    db.prepare("INSERT INTO campaigns (campaign_id, name) VALUES (?, ?)").run(campaignId, campaignId);
  }
  return campaignId;
}

function updateLeadFromImport(existing, data) {
  const updates = {
    name: existing.name || data.name || null,
    channel: existing.channel || data.channel || "WhatsApp",
    campaign_id: existing.campaign_id || data.campaign_id || null,
    status: existing.status || data.status || "New",
    lost_reason: existing.lost_reason || data.lost_reason || null,
    first_contacted_at: existing.first_contacted_at || data.first_contacted_at || null,
    last_contact_at: existing.last_contact_at || data.last_contact_at || null,
    next_followup_at: existing.next_followup_at || data.next_followup_at || null
  };

  const notes = existing.notes ? `${existing.notes}\nImported ${data.imported_at}` : `Imported ${data.imported_at}`;

  db.prepare(
    `UPDATE leads SET
      updated_at = ?,
      name = ?,
      channel = ?,
      campaign_id = ?,
      status = ?,
      lost_reason = ?,
      first_contacted_at = ?,
      last_contact_at = ?,
      next_followup_at = ?,
      notes = ?
     WHERE id = ?`
  ).run(
    nowIso(),
    updates.name,
    clampEnum(updates.channel, CHANNELS, "Other"),
    updates.campaign_id,
    clampEnum(updates.status, STATUSES, "New"),
    updates.status === "Lost" ? clampEnum(updates.lost_reason, LOST_REASONS, null) : null,
    updates.first_contacted_at,
    updates.last_contact_at,
    updates.next_followup_at,
    notes,
    existing.id
  );
}

function createLeadFromImport(data) {
  const ownerId = autoAssignOwner(data.campaign_id || null);
  if (!ownerId) {
    throw new Error("No active agent available");
  }

  db.prepare(
    `INSERT INTO leads (created_at, updated_at, phone, phone_canonical, name, channel, campaign_id, owner_user_id, status, lost_reason, attempts_count, first_contacted_at, last_contact_at, next_followup_at, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    nowIso(),
    nowIso(),
    data.phone,
    data.phone_canonical,
    data.name || null,
    clampEnum(data.channel, CHANNELS, "Other"),
    data.campaign_id || null,
    ownerId,
    clampEnum(data.status, STATUSES, "New"),
    data.status === "Lost" ? clampEnum(data.lost_reason, LOST_REASONS, null) : null,
    data.attempts_count || 0,
    data.first_contacted_at || null,
    data.last_contact_at || null,
    data.next_followup_at || null,
    data.notes || null
  );
}

app.post(
  "/import",
  requireAuth,
  requireRole("MANAGER"),
  upload.fields([
    { name: "leads_csv", maxCount: 1 },
    { name: "deals_csv", maxCount: 1 }
  ]),
  (req, res) => {
    const summary = {
      leads: { inserted: 0, updated: 0, skipped: 0, errors: [] },
      deals: { inserted: 0, skipped: 0, errors: [] }
    };

    const today = new Date().toISOString().slice(0, 10);

    if (req.files.leads_csv && req.files.leads_csv[0]) {
      const rows = parseCsv(req.files.leads_csv[0].buffer);
      rows.forEach((row, idx) => {
        try {
          const { original, canonical } = normalizePhone(row.phone);
          if (!canonical) {
            summary.leads.errors.push(`Row ${idx + 2}: missing phone`);
            return;
          }
          const campaignId = ensureCampaign(row.campaign_id || null);
          const existing = db
            .prepare("SELECT * FROM leads WHERE phone_canonical = ?")
            .get(canonical);

          const data = {
            phone: original,
            phone_canonical: canonical,
            name: row.name || null,
            channel: clampEnum(row.channel, CHANNELS, "Other"),
            campaign_id: campaignId,
            status: clampEnum(row.status, STATUSES, "New"),
            lost_reason: row.lost_reason || null,
            attempts_count: row.attempts_count ? parseInt(row.attempts_count, 10) : 0,
            first_contacted_at: row.first_contacted_at || null,
            last_contact_at: row.last_contact_at || null,
            next_followup_at: row.next_followup_at || null,
            notes: row.notes || null,
            imported_at: today
          };

          if (existing) {
            updateLeadFromImport(existing, data);
            summary.leads.updated += 1;
          } else {
            createLeadFromImport(data);
            summary.leads.inserted += 1;
          }
        } catch (err) {
          summary.leads.errors.push(`Row ${idx + 2}: ${err.message}`);
        }
      });
    }

    if (req.files.deals_csv && req.files.deals_csv[0]) {
      const rows = parseCsv(req.files.deals_csv[0].buffer);
      rows.forEach((row, idx) => {
        try {
          const { original, canonical } = normalizePhone(row.phone);
          if (!canonical) {
            summary.deals.errors.push(`Row ${idx + 2}: missing phone`);
            return;
          }

          let lead = db.prepare("SELECT * FROM leads WHERE phone_canonical = ?").get(canonical);
          if (!lead) {
            const data = {
              phone: original,
              phone_canonical: canonical,
              name: null,
              channel: "Other",
            campaign_id: ensureCampaign(row.campaign_id || null),
            status: "New",
              lost_reason: null,
              attempts_count: 0,
              notes: `Imported ${today}`
            };
            createLeadFromImport(data);
            lead = db.prepare("SELECT * FROM leads WHERE phone_canonical = ?").get(canonical);
          }

          const amount = parseInt(row.amount_dzd, 10);
          if (Number.isNaN(amount)) {
            summary.deals.errors.push(`Row ${idx + 2}: invalid amount`);
            return;
          }

          const cost = row.cost_dzd ? parseInt(row.cost_dzd, 10) : null;

          db.prepare(
            `INSERT INTO deals (lead_id, deal_date, product, amount_dzd, cost_dzd, payment_type, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(
            lead.id,
            row.deal_date || null,
            clampEnum(row.product, PRODUCTS, "Other"),
            amount,
            Number.isNaN(cost) ? null : cost,
            clampEnum(row.payment_type, PAYMENT_TYPES, "Single"),
            row.notes || null
          );

          summary.deals.inserted += 1;
        } catch (err) {
          summary.deals.errors.push(`Row ${idx + 2}: ${err.message}`);
        }
      });
    }

    res.render("import", { summary });
  }
);

app.get("/templates/leads.csv", requireAuth, requireRole("MANAGER"), (req, res) => {
  res.sendFile(path.join(__dirname, "templates", "leads.csv"));
});

app.get("/templates/deals.csv", requireAuth, requireRole("MANAGER"), (req, res) => {
  res.sendFile(path.join(__dirname, "templates", "deals.csv"));
});

app.get("/settings", requireAuth, (req, res) => {
  res.render("settings");
});

app.post("/settings", requireAuth, (req, res) => {
  const { current_password, new_password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.redirect("/settings?msg=Current%20password%20invalid");
  }
  const hash = bcrypt.hashSync(new_password, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hash, user.id);
  res.redirect("/settings?msg=Password%20updated");
});

app.use((req, res) => {
  res.status(404).send("Not found");
});

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`CRM app running on http://localhost:${port}`);
  });
}

module.exports = app;
