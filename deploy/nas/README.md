# Deploying to the NAS from GitHub

Every push to `main` that passes CI builds an image and publishes it as
`ghcr.io/<owner>/ledgr:nas` (workflow: `.github/workflows/deploy-nas.yml`). A
Watchtower container on the NAS checks that tag every few minutes and restarts
Ledgr when it changes. GitHub never connects to the NAS.

```
push to main → CI passes → image built and pushed → Watchtower pulls it → Ledgr restarts
```

## One-time setup

### 1. Let the NAS pull the image

After the first run of **Build NAS image**, open the package on GitHub
(Profile → Packages → `ledgr` → Package settings → Change visibility) and make
it **public**. The code is already public, so the image reveals nothing new, and
the NAS then needs no registry login.

If you would rather keep it private, run `docker login ghcr.io` on the NAS with
a personal access token that has only `read:packages`.

### 2. Point Ledgr at the new image

In the NAS compose folder (`/volume1/docker/ledgr-host2`), change the `app`
service in `docker-compose.yaml`:

```yaml
  app:
    image: ghcr.io/dbullard/ledgr:nas
    pull_policy: missing        # was: never
    labels:
      - com.centurylinklabs.watchtower.enable=true
```

Everything else on the service (`network_mode: host`, volumes, environment,
healthcheck) stays as it is. Settings in `docker-compose.override.yaml` keep
applying on top.

### 3. Add Watchtower

Add this service to the same compose file (or start it on its own with
`docker compose -f deploy/nas/watchtower.compose.yaml up -d`):

```yaml
  watchtower:
    image: nickfedor/watchtower:latest
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      WATCHTOWER_LABEL_ENABLE: "true"      # only touch containers labelled above
      WATCHTOWER_POLL_INTERVAL: "300"      # seconds
      WATCHTOWER_CLEANUP: "true"           # delete the old image after updating
```

`WATCHTOWER_LABEL_ENABLE` means it only ever restarts Ledgr's `app`, never the
database or the backup job. Use the maintained `nickfedor/watchtower` fork:
the original `containrrr/watchtower` fails against current Docker versions.

Then run `docker compose -p ledgr-host2 up -d`.

## Day to day

Merge to `main`. A few minutes later (CI, build, then up to five minutes for the
next Watchtower check) the NAS is running it. Database migrations run on
container start, the same as with `deploy.sh`.

**Deploy right now:** Actions → *Build NAS image* → *Run workflow*, then on the
NAS `docker compose -p ledgr-host2 pull app && docker compose -p ledgr-host2 up -d app`
to skip the wait.

## Rolling back

Every build is also tagged `:sha-<short commit>`. To go back, set the `app`
image to an earlier one and turn Watchtower's label off so it does not move it
forward again:

```yaml
    image: ghcr.io/dbullard/ledgr:sha-abc1234
    labels:
      - com.centurylinklabs.watchtower.enable=false
```

then `docker compose -p ledgr-host2 up -d app`. Re-enable the label and switch
back to `:nas` when the fix is merged.

A migration that already ran is not undone by rolling the image back. The
nightly backup (see Settings → Data health) is the way back from a bad
migration.

## What stays manual

`deploy.sh` still works for building a one-off image from your own machine. The
environment settings in the compose and override files (`BETTER_AUTH_*`,
database credentials) live only on the NAS and are never in GitHub.
