# open.blog view counter (Node + MongoDB)

A small web service that records page views for an open.blog site. It stores counts per
day and page, unique visitors from a daily hash, and referring sites. It never stores
cookies, addresses, or browser strings.

## Deploy on Render

1. Create a MongoDB database (MongoDB Atlas has a free tier) and copy its connection string.
2. Push this folder to a git repository.
3. In Render, create a **Blueprint** from the repository (it reads `render.yaml`), or a
   **Web Service** with build command `npm install --omit=dev` and start command `npm start`.
4. Set the environment variables: `MONGODB_URI` (the connection string), `SITE_ORIGIN`
   (your blog's address), and `EXPORT_SECRET` (any long random string; Render can generate
   one). Keep the secret: `openblog analytics pull` needs it.
5. Note the service address, for example `https://openblog-counter.onrender.com`.

Then in your blog's `openblog.json`:

```json
"analytics": { "builtin": false, "endpoint": "https://openblog-counter.onrender.com" }
```

Rebuild and deploy the blog. To bring the counts into your dashboard and backups:

```sh
openblog analytics pull https://openblog-counter.onrender.com --secret <EXPORT_SECRET>
openblog analytics backup
```

Free Render services sleep after fifteen minutes without traffic. The blog repository gets
`.github/workflows/keep-counter-awake.yml`, which requests `/health` every 14 minutes so
the service stays up; set the repository variable `COUNTER_URL` (Settings → Secrets and
variables → Actions → Variables) to the service address, or edit the file. Without it,
the first view after a quiet spell takes a while to record, and posts show the last
baked count meanwhile. A free Render workspace allows 750 instance hours a month, which
one always-awake service uses almost entirely.

## Run locally

```sh
npm install
MONGODB_URI="mongodb://localhost:27017" EXPORT_SECRET=dev SITE_ORIGIN="http://localhost:8080" npm start
```
