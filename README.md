# Serenity

A focus timer and task manager that helps you work in structured sessions, stay accountable, and build better habits. Built with Node.js, Express, MongoDB, and EJS.

---

## What is Serenity?

Serenity is a personal productivity app. You create work sessions with a list of tasks, a work timer, and a break timer; and then you sit down and focus. The app tracks what you finish, plays music while you work, and keeps a history of everything you've done.

Serenity is part of a productivity suite alongside **Homepage** (the personal homepage and central authentication and billing hub) and **Toolshed** (a file-conversion tool). Homepage provides cross-app login. Catalogue is in development and is not required to use Serenity.

---

## Features

- **Focus sessions**: set a work duration and break duration, add tasks, and start. The timer counts down, plays music, and auto-transitions to break.
- **Strict mode**: when enabled, you can't skip to break or stop the session until every task is checked off.
- **Priority tags**: prefix a session name with `[HIGH]` or `[LOW]` to surface it visually.
- **Session templates**: save a session name + task list as a reusable template for quick setup.
- **Groups**: color-coded categories to organize sessions (school, work, personal, etc.).
- **Calendar**: month, week, and day views. Shows upcoming and delayed sessions at a glance.
- **History & stats**: full log of completed sessions; home screen shows sessions done this week, total sessions, total tasks, and current streak.
- **Music**: use Spotify playlists through the Spotify app or web player without connecting a Spotify account, or connect Spotify, Apple Music, or Deezer for supported in-app playback. Spotify in-browser playback requires Spotify Premium and approved API access.
- **App rules**: whitelist sites as quick-access links during sessions; blacklist sites to show a warning when clicked.
- **Account settings**: change your name, email, or password. Delete your account permanently.
- **Cross-app login (SSO)**: Homepage issues short-lived signed login tokens that Serenity verifies against the shared user database.
- **Color themes**: 17 built-in themes synced across all apps via a cookie.
- **Responsive**: works on desktop, tablet, and mobile.
- **Desktop app**: can be packaged as a native Windows/macOS/Linux app via Electron.

---

## Plans

| Feature | Free | Pro | Studio |
|---|---|---|---|
| Active sessions | 15 | 100 | Unlimited |
| Groups | 5 | 20 | Unlimited |
| Session templates | 5 | 30 | Unlimited |
| Music, app rules, calendar views | ✓ | ✓ | ✓ |

Billing is managed centrally at the home page. Serenity reads `user.plan` from the shared cluster and links to the billing page, and it does not run Stripe directly.

---

## Quick Start

1. Make sure Node.js (v18+) is installed.
2. Clone the repo and install dependencies:
   ```
   git clone https://github.com/26SathvikV/Serenity
   cd serenity
   npm install
   ```
3. Create a `.env` file in the project root (see Environment Variables below).
4. Start the server:
   ```
   npm start
   ```
5. Open `http://localhost:3000` in your browser.

In development (no `AUTH_HOST` set), local username/password auth is used. In production, login and signup redirect to the central auth host.

---

## Environment Variables

Create a file named `.env` in the project root. This file is never committed to git.

```
# Required
MONGODB_URI=mongodb+srv://username:password@cluster.mongodb.net/test
SESSION_SECRET=replace-with-a-long-random-string

# Server port (default: 3000)
PORT=3000

# Production SSO: set when deploying; omit in local dev
AUTH_HOST=https://your-home-app.com
SERENITY_URL=https://your-serenity-app.com
SSO_SECRET=replace-with-a-long-random-string

# Optional: Spotify (developer.spotify.com → Dashboard → Create App)
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
SPOTIFY_REDIRECT_URI=http://localhost:3000/auth/spotify/callback

# Optional: Apple Music (developer.apple.com → Certificates → Keys → MusicKit)
APPLE_MUSIC_KEY_ID=
APPLE_MUSIC_TEAM_ID=
APPLE_MUSIC_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nXXXX\n-----END PRIVATE KEY-----

# Optional: Deezer (developers.deezer.com → My Apps)
DEEZER_APP_ID=
```

**Generate secure secrets** (run once per secret, paste the output):
```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Music Setup

| Service | What you need | Notes |
|---|---|---|
| Spotify | Client ID + Secret from developer.spotify.com for account connection | External playlist launching works without API access; in-browser playback requires Premium and approved API access |
| Apple Music | .p8 key from developer.apple.com ($99/yr program) | Requires active Apple Music subscription |
| Deezer | App ID from developers.deezer.com | Free accounts get 30-second previews |
| Qobuz | Apply at qobuz.com/us-en/editorial/api | Not yet implemented |

---

## Cross-App Login (SSO)

In production, `/login` and `/signup` redirect to Homepage at `AUTH_HOST/login?redirect=SERENITY_URL/auth/sso&app=serenity`. After authentication, Homepage redirects back with a short-lived `token` query parameter.

The token is `base64url(JSON payload) + '.' + base64url(HMAC-SHA256(payload, SSO_SECRET))`. Its payload contains `{ userId, name, exp }`, with `exp` as a Unix timestamp in milliseconds. `GET /auth/sso` verifies the signature and expiry, loads the existing user from the shared MongoDB `users` collection, and establishes a local session. Homepage and Serenity must use the same `SSO_SECRET`; production sessions also require a strong `SESSION_SECRET`.

In development (no `AUTH_HOST` set), local bcrypt auth is used, so no SSO setup needed.

`/logout` redirects to `AUTH_HOST/logout` when `AUTH_HOST` is set, signing the user out through Homepage.

For Railway, set `NODE_ENV=production`, `MONGODB_URI`, `SESSION_SECRET`, `AUTH_HOST`, `SERENITY_URL`, and `SSO_SECRET` in the service variables. The service uses Railway's proxy configuration for secure session cookies and refuses to start when required production secrets are missing.

---

## App Switcher & Websites Collection

The hamburger menu (☰) pulls from a MongoDB `websites` collection in the same database:

```
{ site_name: String, link: String, icon: String, color: String }
```

- `icon`: an [Ionicons](https://ionic.io/ionicons) icon name (e.g. `"timer-outline"`)
- `color`: hex color for the icon (e.g. `"#FF80CC"`)
- `link`: the full URL to the app

Add Serenity's own entry (run in MongoDB shell or Compass):
```js
db.websites.insertOne({
    site_name: "Serenity",
    link: "http://localhost:3000",
    icon: "timer-outline",
    color: "#FF80CC"
})
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js + Express |
| Templates | EJS (server-rendered) |
| Database | MongoDB Atlas + Mongoose |
| Sessions | express-session + connect-mongo |
| Auth | bcrypt (dev) / HMAC-SHA256 SSO (production) |
| Music tokens | JWT (Apple Music developer token) |
| Desktop wrapper | Electron (optional) |

---

## Project Structure

```
serenity/
├── index.js              # Express server, with all routes and models
├── electron.js           # Electron main process (desktop app)
├── public/
│   └── style.css         # All styles + 17 color theme variables
├── views/
│   ├── standard/
│   │   └── page.ejs      # Shared layout (header, nav, theme switcher, app switcher)
│   ├── signup/
│   │   ├── login.ejs
│   │   └── signup.ejs
│   └── pages/
│       ├── home.ejs       # Dashboard: next session, upcoming, stats, streak
│       ├── add.ejs        # Create sessions and groups
│       ├── work.ejs       # Focus session UI + music players
│       ├── history.ejs    # Completed session log
│       ├── calendar.ejs   # Month / week / day calendar views
│       └── settings.ejs   # Account, subscription, session defaults, calendar, app rules, music
├── .env                  # Secrets, should never be committed
├── .gitignore
├── package.json
└── .github/
    └── workflows/
        └── release.yml   # CI/CD, builds desktop app for all platforms
```

---

## Database Collections

All collections live on the shared Atlas cluster:

| Collection | Purpose |
|---|---|
| `users` | Shared with Catalogue and Toolshed, same accounts across all apps. Schema includes `name`, `email`, `password`, `plan` ('free'/'pro'/'studio'), `stripeCustomerId`, `stripeSubscriptionId`. |
| `sessions` | Shared session store |
| `worksessions` | Focus session records |
| `groups` | Color-coded session categories |
| `userpreferences` | Per-user settings (music service, strict mode, timezone, app rules, etc.) |
| `websites` | App switcher entries (icon, color, link) |

---

## Building the Desktop App

The desktop app wraps the Express server in an Electron window. A `.env` file must sit next to the installed executable.

**Run in Electron locally:**
```
npm run electron
```

**Build an installer:**
```
npm run build:win    # Windows NSIS installer (.exe)
npm run build:mac    # macOS disk image (.dmg)
npm run build:linux  # Linux AppImage
npm run build:all    # All three platforms
```

**Automated releases via GitHub Actions:**
```
git tag v2.0.1
git push --tags
```
GitHub Actions builds all three platform artifacts and attaches them to the release automatically.

---

## Security Notes

Before deploying to a public server:

1. **Change `SESSION_SECRET` and `SSO_SECRET`**: generate real ones by putting the following into the terminal:
   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
2. **Enable HTTPS**: add `secure: true` to the session cookie config. If behind a reverse proxy (nginx, Caddy), also add `app.set('trust proxy', 1)`.
3. **Never commit `.env`**: it's already in `.gitignore`. Credentials live only there.
4. **Rate-limit auth endpoints**: add `express-rate-limit` to `/login` and `/signup` to prevent brute-force.
5. **MongoDB network access**: in Atlas, restrict the IP allowlist to your server's IP instead of `0.0.0.0/0`.

---

## Scripts

| Command | Description |
|---|---|
| `npm start` | Run Express server |
| `npm run dev` | Run with nodemon (auto-restart) |
| `npm run electron` | Launch Electron desktop app |
| `npm run build:win` | Build Windows installer |
| `npm run build:mac` | Build macOS DMG |
| `npm run build:linux` | Build Linux AppImage |
| `npm run build:all` | Build all three platforms |
