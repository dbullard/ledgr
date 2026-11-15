# Install this fork of Ledgr

This is a fork of [Ledgr](https://github.com/KenTaniguchi-R/ledgr) with extra
features (receipt import, hidden accounts, reconnecting banks, the Apple apps).
Everything runs on your own machine or NAS, and your data stays there.

## 1. Run the server

You need Docker with Compose on the NAS or computer that will host it.

```bash
curl -fsSL https://raw.githubusercontent.com/dbullard/ledgr/main/scripts/install.sh | sh
```

That creates a `ledgr/` folder with a `docker-compose.yml` and a `.env`,
generates a database password, works out the machine's LAN address, and starts
the containers. Then open the address it prints (also in `.env` as
`BETTER_AUTH_URL`, usually `http://<nas-ip>:4200`) and create your account.

**If the NAS has no shell access or `curl`** (Synology Container Manager, QNAP
Container Station, Unraid, Portainer): create a new project/stack, paste in
[`docker-compose.yml`](docker-compose.yml), and add these environment values:

| Variable | Value |
| --- | --- |
| `POSTGRES_PASSWORD` | any long random string (set once, never change) |
| `PORT` | `4200` |
| `TZ` | your timezone, e.g. `America/Chicago` |
| `BETTER_AUTH_URL` | `http://<nas-ip>:4200` |
| `NEXT_PUBLIC_APP_URL` | same as `BETTER_AUTH_URL` |
| `BETTER_AUTH_TRUSTED_ORIGINS` | any other addresses you use, comma separated |

The image is `ghcr.io/dbullard/ledgr:latest` (amd64 and arm64).

### Connecting banks

Optional. Without it you can import CSV/OFX/QFX files. For automatic sync use
[SimpleFIN](https://www.simplefin.org) (simplest) or your own Plaid developer
keys; see the "Plaid" and "SimpleFIN" sections of [`.env.example`](.env.example).
Your keys are yours. Nothing is shared with the person who sent you this.

### Updating

```bash
cd ledgr
docker compose pull && docker compose up -d
```

### Backups

Your data lives in two Docker volumes: `pgdata` (the database) and `appdata`
(encryption key and session secret). Losing `appdata` makes stored bank tokens
unreadable, so back up both.

## 2. Install the apps (TestFlight)

1. Install **TestFlight** from the App Store on your iPhone and Mac.
2. Open the invite you were sent and accept it. Install **Ledgr**.
3. Open the app, go to Settings, and enter your server address, for example
   `http://192.168.1.50:4200`. If you reach the server from outside your home
   (Tailscale or a VPN), enter that address as the away address.
4. Sign in with the account you created in step 1.

Push notifications are sent by the server, which needs Apple push credentials
tied to the app's developer account, so they will not work on a self-hosted
server unless you add your own (see [`docs/push-notifications.md`](docs/push-notifications.md)).
Everything else works without them.

---

## For the maintainer

### Publishing a new server image

The image is built by `.github/workflows/docker-publish.yml` on GitHub's own
runners when you push a version tag (or run the workflow by hand from the
Actions tab).

```bash
git tag v0.4.0 && git push origin v0.4.0
```

It publishes `ghcr.io/dbullard/ledgr:latest` plus the version tag. The first
time only, make the package public so others can pull it without logging in:
GitHub → your profile → Packages → `ledgr` → Package settings → Change
visibility → Public.

### Shipping the apps through TestFlight

One-time setup (needs the paid Apple Developer Program membership):

1. In [App Store Connect](https://appstoreconnect.apple.com) → Apps → **+** →
   New App. Create one record for `com.dbullard.ledgr` covering iOS and macOS.
   The share extension (`com.dbullard.ledgr.share`) ships inside it and needs
   no record of its own, but its App ID and the `group.com.dbullard.ledgr`
   App Group must exist in the developer portal (Xcode creates them for you).
2. Users and Access → add your brother (his Apple ID) as a user. Internal
   testers must be team users, but they get builds immediately with no Apple
   review. External testers (anyone with just an email or a public link) need a
   one-time Beta App Review per build.

For each build:

1. Bump `CURRENT_PROJECT_VERSION` (and `MARKETING_VERSION` when it's a new
   release) in `apps/apple/Ledgr.xcodeproj`. Every upload needs a new build
   number.
2. Open `apps/apple/Ledgr.xcodeproj`. Choose **Any iOS Device (arm64)** →
   Product → Archive → Distribute App → **TestFlight & App Store** → Upload.
3. Repeat with **My Mac** as the destination for the macOS build.
4. In App Store Connect → TestFlight, wait for processing, then add the build to
   your internal testing group.

Distribution signing switches the push entitlement from `development` to
`production` automatically.
