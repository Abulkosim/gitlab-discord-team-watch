# GitLab Team Watch

A live terminal feed of **every action by every member of your team** on GitLab —
pushes, commits, merge requests, comments, issues, and more. Refreshes
continuously so it acts as a lightweight notification/monitoring system.

It talks to the **GitLab REST API directly** (not Claude's MCP), so it runs
anywhere your GitLab server is reachable — i.e. on office WiFi or VPN.

```
┌ GitLab Team Activity ──────────────────────────────────┐
│ Updated 10:42:01 · 2 new since last poll · next in 30s  │
│                                                         │
│ ● Aziz      pushed 3 commits to main — fix auth   api   2m │
│ ● Dilnoza   opened MR !42: add export endpoint    web   8m │
│   Sardor    merged MR !39                         web  15m │
│   Aziz      commented on issue #12                api  20m │
└──────────────────── 5 members · https://gitlab… ───────┘
```

## Setup (one time)

```bash
cd gitlab-team-watch
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # then edit .env with your values
```

### What goes in `.env`

| Variable        | Required | Meaning                                                        |
|-----------------|----------|----------------------------------------------------------------|
| `GITLAB_URL`    | yes      | Base URL, e.g. `https://gitlab.your-company.com`               |
| `GITLAB_TOKEN`  | yes      | Personal access token with **`read_api`** scope                |
| `GITLAB_GROUP`  | one of   | Group id or path (e.g. `org/myteam`) — watches all its members |
| `GITLAB_USERS`  | these    | Comma-separated usernames, e.g. `aziz,dilnoza,sardor`          |
| `POLL_INTERVAL` | no       | Seconds between refreshes (default 30)                         |
| `EVENT_LIMIT`   | no       | Rows shown in the feed (default 40)                            |
| `DISCORD_WEBHOOK_URL` | no | If set, every new event is also pushed to this Discord channel |

Create the token at: `<GITLAB_URL>/-/user_settings/personal_access_tokens`
→ scope **`read_api`**. (Read-only — it can't change anything.)

## Run

```bash
source .venv/bin/activate
python gitlab_watch.py
```

Press **Ctrl-C** to quit. A green `●` marks events that are new since the last poll.

## How it works

- Resolves the people to watch from `GITLAB_GROUP` (all members) and/or `GITLAB_USERS`.
- Every `POLL_INTERVAL` seconds it calls `GET /users/:id/events` for each member,
  merges and de-duplicates the results, and renders the newest activity.
- Polling per-member (rather than per-project) keeps the request count bounded by
  team size, not by how many repos you have.

## Notes & limits

- **Network:** must be able to reach `GITLAB_URL` (office WiFi / VPN). It will say
  so clearly if it can't connect.
- **Visibility:** you only see activity in projects your token can access. For full
  team coverage, use a token from an account with broad access (e.g. maintainer/owner).
- **Privacy:** this aggregates teammates' activity. If it's for a standup digest or
  release notes that's fine — but consider being transparent with the team that it exists.

## Discord notifications

Get pinged in Discord whenever a new event happens — no bot, just a webhook.

1. **Make a place to be notified.** Easiest is a private server only you're in
   (Discord → `+` → *Create My Own*). Pick or create a channel.
2. **Create the webhook.** Channel → ⚙️ *Edit Channel* → *Integrations* →
   *Webhooks* → *New Webhook* → *Copy Webhook URL*.
3. **Wire it up.** Put the URL in your `.env`:
   ```
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/XXXX/YYYY
   ```
4. **Run as usual** (`python gitlab_watch.py`). The terminal feed works exactly as
   before; on top of it, each new event is posted to the channel, e.g.:
   ```
   ⬆️ Aziz pushed 3 commits to main — fix auth · api · 2m ago
   ✨ Dilnoza opened MR: add export endpoint · web · 8m ago
   ```

Notes:
- The **first poll is silent** — it loads the existing backlog, so you only get
  pinged for activity that happens *after* you start the tool (no startup spam).
- Events from one poll are **batched into a single message** (split only if over
  Discord's 2000-char limit), so an active team won't rate-limit the webhook.
- Notification delivery is **best-effort**: if Discord is unreachable, the live
  terminal feed keeps running uninterrupted.
- Leave `DISCORD_WEBHOOK_URL` blank/unset to disable Discord entirely.

## Possible extensions

- A `--once` mode that prints a daily digest (good for cron).
- Filter by action type (only MRs, only pushes, etc.).
- Telegram push notifications (same idea as Discord, via the Bot API).

Ask and I'll add any of these.
