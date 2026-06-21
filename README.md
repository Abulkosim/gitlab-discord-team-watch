# GitLab Team Watch

Live terminal feed of your team's GitLab activity (pushes, MRs, comments, issues),
with optional **Discord** notifications for every new event. Talks to the GitLab
REST API directly, so it runs anywhere GitLab is reachable (office WiFi / VPN).

**Node.js, zero dependencies** — needs Node 18+ (built-in `fetch`/`readline`). No `npm install`.

## Setup

```bash
cp .env.example .env      # fill in your values
node gitlab-watch.js      # run it (Ctrl-C to quit)
```

| Variable | Required | Meaning |
|----------|----------|---------|
| `GITLAB_URL`   | yes | Base URL, e.g. `https://gitlab.your-company.com` |
| `GITLAB_TOKEN` | yes | Personal access token, **`read_api`** scope (read-only) |
| `GITLAB_GROUP` | one of | Group id/path (`org/myteam`) — watches all members |
| `GITLAB_USERS` | these | Comma-separated usernames (`aziz,dilnoza`) |
| `POLL_INTERVAL` | no | Seconds between refreshes (default 30) |
| `EVENT_LIMIT` | no | Rows shown (default 40) |
| `DISCORD_WEBHOOK_URL` | no | If set, new events are pushed here |

Token: `<GITLAB_URL>/-/user_settings/personal_access_tokens` → scope `read_api`.

## Discord notifications

1. Discord → **Channel → ⚙️ Edit → Integrations → Webhooks → New Webhook → Copy URL**
   (tip: make a private server just for yourself).
2. Put it in `.env`: `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/XXXX/YYYY`
3. Run as usual — each new event posts to the channel, e.g.
   `⬆️ Aziz pushed 3 commits to main — fix auth · api · 2m ago`

The first poll is silent (loads the backlog, no startup spam); later polls batch their
new events into one message; delivery is best-effort and never blocks the feed.

Test the webhook on its own (doesn't touch GitLab):

```bash
node check-discord.js              # loop: type a message, Enter to send
node check-discord.js "hello"      # send one and exit
```

## Notes

- **Network:** must reach `GITLAB_URL` (office WiFi / VPN) — says so clearly if it can't.
- **Visibility:** you only see what your token can access; use a maintainer/owner token for full coverage.
- **Privacy:** this aggregates teammates' activity — consider being transparent that it exists.
