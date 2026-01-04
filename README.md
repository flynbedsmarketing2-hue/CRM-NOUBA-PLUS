# CRM Nouba Plus

Small, fast CRM for a travel sales team. Server-rendered EJS, SQLite (better-sqlite3), and minimal dependencies.

## Stack
- Node.js LTS + Express
- EJS server-side templates
- SQLite local file (`data/crm.sqlite`)
- Auth: `express-session` + `bcrypt`
- CSV import with `csv-parse` + `multer`

## Setup
```bash
npm install
npm start
```

App runs on `http://localhost:3000`.

### Environment
- `SESSION_SECRET` (recommended in production)
- `PORT` (optional)

### Node Version
Use Node 20.x or 22.x. `better-sqlite3` does not ship prebuilt binaries for Node 24 yet.

## Default Users
Change these immediately in **Settings**:
- Manager: `manager` / `manager123`
- Agent: `agent1` / `agent123`
- Agent: `agent2` / `agent123`

## Data Model
See `init_db.js` for schema. Phone numbers are normalized and stored in `phone_canonical` (unique).

## CSV Import
Visit `/import` (manager only).

Templates:
- `/templates/leads.csv`
- `/templates/deals.csv`

### Leads CSV columns
`phone,name,channel,campaign_id,status,lost_reason,attempts_count,first_contacted_at,last_contact_at,next_followup_at,notes`

Rules:
- Existing phone: update only empty fields, append `Imported YYYY-MM-DD` to notes
- Unknown channel -> `Other`
- Campaign auto-created if missing

### Deals CSV columns
`phone,deal_date,product,amount_dzd,cost_dzd,payment_type,notes,campaign_id`

Rules:
- If lead not found, a phone-only lead is created
- Unknown product -> `Other`
- Invalid amount rows are skipped with an error

## Role Rules
- AGENT: sees only their own leads/deals
- MANAGER: sees all + cost/margin fields

## Replit (GitHub) Hosting
1. Push this repo to GitHub.
2. Create a new Replit from GitHub.
3. Set `SESSION_SECRET` in Replit Secrets.
4. Run `npm install`, then `npm start`.

## Vercel Deployment (Demo Only)
Vercel runs serverless functions with ephemeral storage. SQLite data and uploaded files will not persist reliably.

1. Push this repo to GitHub and import it into Vercel.
2. Set `SESSION_SECRET` in Vercel Environment Variables.
3. Deploy.

Notes:
- The database is stored under `/tmp` on Vercel and can be wiped at any time.
- File uploads also go to `/tmp/uploads` and are not durable.

## Notes
- Currency is DZD only.
- Lead quick add is optimized for phone-only entry.
- Database is initialized on first start (see `init_db.js`).
