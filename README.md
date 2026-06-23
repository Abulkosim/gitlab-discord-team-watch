# GitLab Team Watch

A headless daemon that watches your team's GitLab activity (pushes, MRs, comments,
issues) and posts every new event to **Discord**. Talks to the GitLab REST API
directly, so it runs anywhere GitLab is reachable (office WiFi / VPN). No UI — it
just logs what it does and pushes notifications, so it's happy running in the
background or as a service.

**Node.js, zero dependencies** — needs Node 18+ (built-in `fetch`/`readline`). No `npm install`.

## Setup

```bash
cp .env.example .env      # fill in your values
node gitlab-watch.js      # run it (Ctrl-C to quit)
```

| Variable              | Required | Meaning                                                  |
| --------------------- | -------- | -------------------------------------------------------- |
| `GITLAB_URL`          | yes      | Base URL, e.g. `https://gitlab.your-company.com`         |
| `GITLAB_TOKEN`        | yes      | Personal access token, `**read_api**` scope (read-only)  |
| `GITLAB_GROUP`        | one of   | Group id/path (`org/myteam`) — watches all members       |
| `GITLAB_USERS`        | these    | Comma-separated usernames (`aziz,dilnoza`)               |
| `DISCORD_WEBHOOK_URL` | yes      | Discord channel webhook — new events are posted here     |
| `POLL_INTERVAL`       | no       | Seconds between polls (default 30)                       |
| `FETCH_CONCURRENCY`   | no       | Member fetches run in parallel per poll (default 8)      |

Token: `<GITLAB_URL>/-/user_settings/personal_access_tokens` → scope `read_api`.

## How it runs

On start it resolves the members to watch, then polls every `POLL_INTERVAL`
seconds. The **first poll is silent** — it loads the existing backlog so you
don't get spammed on startup. After that, each poll posts only genuinely new
events to Discord and logs a one-line summary:

```
[09:00:00] Watching 12 member(s) on https://gitlab.your-company.com. Polling every 30s, posting to Discord.
[09:00:01] Primed feed with 47 recent event(s) — no notifications sent.
[09:00:31] 2 new event(s) posted to Discord.
[09:01:01] No new events.
```

## Discord notifications

1. Discord → **Channel → Edit → Integrations → Webhooks → New Webhook → Copy URL**
  (tip: make a private server just for yourself).
2. Put it in `.env`: `DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/XXXX/YYYY`
3. Run as usual — each new event posts to the channel, e.g.
  `` `09:00:30`  **Aziz**  pushed 3 commits to main — fix auth · `org/api` ``

Polls batch their new events into one message (split across messages if long);
delivery is best-effort and never blocks polling.

Test the webhook on its own (doesn't touch GitLab):

```bash
node check-discord.js              # loop: type a message, Enter to send
node check-discord.js "hello"      # send one and exit
```

## Running unattended

Because it's headless, you can keep it running without a terminal open — just
remember **something has to stay awake to poll**: your Mac (via `launchd`, awake
only while the Mac is on) or an always-on box (cheap VM, Raspberry Pi, home
server) for true 24/7. Either way, point it at `.env` and let it loop.

## Notes

- **Network:** must reach `GITLAB_URL` (office WiFi / VPN) — says so clearly if it can't, and keeps retrying.
- **Visibility:** you only see what your token can access; use a maintainer/owner token for full coverage.
- **Privacy:** this aggregates teammates' activity — consider being transparent that it exists.
