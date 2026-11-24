# Battle Zone Mymensingh: Cloudflare + GitHub

The website, booking API, admin panel and database all run on Cloudflare's free plan.
GitHub holds the code. Every push to `main` deploys automatically.

## Repo layout
```
battle-zone/
  public/
    index.html      website + admin panel
    _headers        security headers
  src/
    worker.js       booking API
  schema.sql        database tables
  wrangler.jsonc    Cloudflare config
  package.json
  .gitignore
```

## One-time setup (about 15 minutes)

### 1. Put the code on GitHub
Create a new **private** repo called `battle-zone`, then upload all the files above with the same folders.

### 2. Create the database
Cloudflare dashboard → **Storage & Databases → D1 → Create database**
- Name: `battle-zone-db`
- Copy the **Database ID**. Open `wrangler.jsonc` on GitHub, replace `PASTE_YOUR_DATABASE_ID_HERE` with that ID, and commit.

### 3. Create the tables
In D1, open `battle-zone-db` → **Console**. Paste everything from `schema.sql` and run it.

### 4. Connect GitHub to Cloudflare
Dashboard → **Workers & Pages → Create → Import a repository**
- Connect your GitHub account and pick the `battle-zone` repo
- Build command: leave empty
- Deploy command: `npx wrangler deploy`
- Click Deploy

### 5. Set the admin password
Worker `battle-zone` → **Settings → Variables and Secrets → Add**
- Type: **Secret**
- Name: `ADMIN_PASSWORD`
- Value: a strong password

Then go to **Deployments** and redeploy once so the Worker picks it up.

### 6. Add your domain (optional)
If the domain's DNS is on Cloudflare: Worker → **Settings → Domains & Routes → Add → Custom domain**, for example `battlezonemymensingh.com`.
Without a domain, the site runs at `battle-zone.<your-account>.workers.dev`.

## Using it
- Website: `https://your-domain/`
- Admin panel: `https://your-domain/#admin`
- To change the admin password, use **Change password** inside the admin panel. After that, the panel password replaces the `ADMIN_PASSWORD` secret.

## Making changes
Edit files on GitHub (or push from your computer). Cloudflare redeploys within about a minute. The bookings in the database are never touched by a deploy.

## Backup
D1 → `battle-zone-db` → **Backups**, or download a CSV any time from the admin panel.

## What the server enforces
- 10:00 am to 10:00 pm, 30-minute steps, 30 min to 3 hours, next 7 days, on Dhaka time
- No double booking: every 30-minute block of a seat can only be held once, enforced by the database
- Bangladeshi mobile numbers only, at most 2 upcoming bookings per number
- At most 8 online bookings per hour from one connection
- Public visitors never see names or phone numbers
- Admin login locks for 15 minutes after 5 wrong tries, with a 12-hour secure session

## Run on your computer (optional)
```
npm install
echo ADMIN_PASSWORD=test1234 > .dev.vars
npm run db:local
npm run dev
```
Open http://localhost:8787
