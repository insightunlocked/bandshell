# Putting Bandshell on the web

The build is already portable — it works at a root domain (`bandshell.netlify.app`)
or in a subfolder (`you.github.io/bandshell/`), because asset paths are relative.

**It must be served over HTTPS.** Not a preference: browsers block both the
microphone and the offline service worker on plain `http://` (localhost is the
one exception). Every option below is HTTPS by default.

---

## Option A — Netlify Drop (fastest, ~1 minute)

Good for getting a link into a friend's hands today.

1. Run `npm run build` (creates `dist/`, or use the ready-made `bandshell-dist.zip`).
2. Go to <https://app.netlify.com/drop>.
3. Drag the **`dist` folder** (or the zip) onto the page.
4. You get a live HTTPS URL immediately.

Notes:

- No account needed to try it. Sites dropped anonymously expire — make a free
  account to keep it and rename it to something like `bandshell.netlify.app`.
- To update it later, build again and drag the new `dist` on top.

## Option B — GitHub Pages (best for keeping it updated, free forever)

Every time you push, it rebuilds and redeploys itself. `.github/workflows/deploy.yml`
is already written and committed.

1. Make a GitHub account if you don't have one, then create an **empty public repo**
   named `bandshell` (no README — this folder already has the files).
2. In this folder:

   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/bandshell.git
   git branch -M main
   git push -u origin main
   ```

3. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
4. Wait for the green check in the **Actions** tab.

Your URL: `https://YOUR-USERNAME.github.io/bandshell/`

After that, `git push` is the whole deploy process.

## Option C — Cloudflare Pages / Vercel

Same idea as B: connect the GitHub repo, set **build command** `npm run build`
and **output directory** `dist`. Both are free for this and give instant HTTPS.

---

## Using your own domain

All three support custom domains free (you still buy the domain, ~$10–15/yr).
Add the domain in the host's dashboard and follow its DNS instructions — HTTPS
certificates are issued automatically.

## Things worth knowing once it's public

- **Songs are per-visitor and per-browser.** Bandshell saves to the visitor's own
  browser storage, so nobody sees anybody else's work and there's no server or
  database to run. People should use **Save** to keep a song as a file.
- **First visit needs a network; after that it works offline** — the service
  worker caches the whole app, and it can be installed from the browser's
  Install / Add to Home Screen option.
- **The microphone prompt** appears the first time someone records on an Audio
  track. That's the browser asking, and it only works because the site is HTTPS.
- **Cost:** all of the above are free at this scale. It's a static site — no
  server, no per-user cost.
- **Updating:** Option A = drag a new build; Options B/C = `git push`.
