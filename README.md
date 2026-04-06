# RazorGen

Razor transform builder for the Equus relocation platform.

---

## Quickstart — Docker (no Node.js needed)

**1. Create your .env**
```
cp .env.example .env
# Edit .env — add your API key, set usernames/passwords
```

**2. Build and run**
```bash
docker compose up -d
```

Open **http://localhost:43000** and sign in.

That's it. No Node.js, no npm, nothing else to install.

---

## Daily workflow

```bash
# Start
docker compose up -d

# Stop
docker compose down

# See logs
docker compose logs -f

# Rebuild after you change index.html or server.js
docker compose up -d --build
```

---

## Pulling from Docker Hub (no build needed)

Once the image is published to Docker Hub, teammates can run it
without cloning the repo at all — they just need a `.env` file.

Edit `docker-compose.yml` and change:
```yaml
image: razorgen:local
# build: .        ← comment this out
```
to:
```yaml
image: YOURDOCKERHUBUSERNAME/razorgen:latest
# build: .        ← leave commented out
```

Then:
```bash
docker compose pull
docker compose up -d
```

---

## Publishing to Docker Hub

### One-time setup

1. Create a Docker Hub account at https://hub.docker.com
2. Create a repository called `razorgen` (can be public or private)
3. Create an Access Token:
   - Docker Hub → Account Settings → Security → New Access Token
   - Name it "razorgen-ci", permissions: Read & Write
   - Copy the token — you only see it once

### Manual push (from your machine)

```bash
# Log in
docker login -u YOURDOCKERHUBUSERNAME

# Build and tag
docker build -t YOURDOCKERHUBUSERNAME/razorgen:latest .

# Push
docker push YOURDOCKERHUBUSERNAME/razorgen:latest
```

### Automatic push via GitHub Actions

Every push to `main` will automatically build and push to Docker Hub.

**Setup steps:**

1. Push this repo to GitHub

2. Add two secrets in GitHub:
   - Repo → Settings → Secrets and variables → Actions → New repository secret
   - `DOCKERHUB_USERNAME` = your Docker Hub username
   - `DOCKERHUB_TOKEN`    = the access token you created above

3. Push any change to `main` — the Actions tab will show the build running.

The workflow (`.github/workflows/docker-publish.yml`) pushes two tags:
- `latest` — always the most recent build
- `abc1234` (git SHA) — pinned version for traceability

---

## Environment variables (.env)

Copy `.env.example` to `.env` and fill in:

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your key from console.anthropic.com |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-sonnet-4-20250514` |
| `PORT` | No | Defaults to `43000` |
| `USERS` | Yes | `name:password,name2:password2` |
| `ALLOWED_IPS` | No | Comma-separated IPs, blank = allow all |

**The `.env` file is never committed to git and never baked into the Docker image.**
It is mounted into the container at runtime via `docker-compose.yml`.

---

## Updating the app

1. Edit `index.html` or `server.js`
2. Commit and push to `main`
3. GitHub Actions builds and pushes to Docker Hub automatically
4. On any machine running the app:
   ```bash
   docker compose pull
   docker compose up -d
   ```

Or if building locally:
```bash
docker compose up -d --build
```

---

## Behind a reverse proxy

Point nginx/Caddy/Traefik at port 43000.

**nginx:**
```nginx
server {
    listen 443 ssl;
    server_name razorgen.yourdomain.com;
    location / {
        proxy_pass http://localhost:43000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

**Caddy:**
```
razorgen.yourdomain.com {
    reverse_proxy localhost:43000
}
```

---

## Files

| File | Purpose |
|---|---|
| `index.html` | App UI |
| `server.js` | Node server — auth, API proxy, static files |
| `.env` | Your secrets — create from `.env.example`, never commit |
| `.env.example` | Template — safe to commit |
| `Dockerfile` | Container definition |
| `docker-compose.yml` | Easy local + production runner |
| `.github/workflows/docker-publish.yml` | Auto-publish to Docker Hub on push |
| `.gitignore` | Keeps `.env` out of git |
