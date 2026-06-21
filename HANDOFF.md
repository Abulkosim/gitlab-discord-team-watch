# Handoff — GitLab Team Activity Monitor

This document brings another agent fully up to speed on what the user wants, what
was discussed, what has been built, and what's left open. Read it before touching
the project in `/Users/abulkosim/gitlab-team-watch/`.

---

## 1. Who the user is & the context

- User email: `abulkosim@dionysos.uz`.
- They work on a team that uses a **self-hosted GitLab** (the connector in their
  Claude session is named `OSIRIS_Gitlab_MCP` — likely an "OSIRIS" project/org).
- **Key network constraint:** the GitLab server (and its MCP) is only reachable
  from the **office WiFi / VPN**. The user is frequently at home, where they
  **cannot connect**. Anything built must be runnable later, from the office network.
- There are sibling MCPs in their environment (Atlassian/Jira, Microsoft 365,
  a TMS API, a WMS docs server) — not used here, just context on their stack.

## 2. The conversation so far (chronological)

1. **Q: Is it possible to have an agent + cron job that prints all GitLab actions
   by everyone on the team?**
   Answer given: yes. GitLab's events API (`list_events` / `get_project_events`
   via MCP, or `/events` over REST) exposes all activity. Flagged three caveats:
   network access is the real blocker, visibility is limited to what the user's
   token can see, and aggregating teammates' activity has a privacy/surveillance
   dimension worth being transparent about.

2. **Q: Can I post things from terminal to Telegram from my account?**
   Answer given: yes. Recommended the **Telegram Bot API** (`curl` to
   `api.telegram.org/bot<TOKEN>/sendMessage`) as the safe path; noted that posting
   as their *personal* account requires MTProto/Telethon and risks ToS limits.
   This Telegram option is intended as a possible delivery channel for the GitLab
   monitor.

3. **Q: Build me an app (web / terminal / notifier) showing every action from each
   team member.**
   Clarifying questions were asked. The user chose:
   - **Form factor: Terminal TUI** (a live-refreshing terminal dashboard).
   - **Mode: Continuous watch** (polls on an interval, acts as a live notifier).

   The tool described below was then built.

## 3. Important design decision

A standalone app must **NOT** use the Claude-side GitLab MCP — that connector only
works inside Claude. The tool therefore talks to the **GitLab REST API directly**
using a personal access token, so it's a real independent app that runs from the
user's terminal anywhere GitLab is reachable. (The MCP is still fine for ad-hoc
queries *inside* Claude, just not as the app's data source.)

## 4. What was built

Project directory: `/Users/abulkosim/gitlab-team-watch/`

| File | Purpose |
|------|---------|
| `gitlab_watch.py` | The tool. Live terminal feed (uses `rich`) of every team member's GitLab activity. |
| `.env.example` | Config template — copy to `.env`. |
| `requirements.txt` | Single dependency: `rich>=13`. |
| `README.md` | User-facing setup & run instructions. |
| `HANDOFF.md` | This file. |

### How `gitlab_watch.py` works
- **Config via env vars** (loaded from a `.env` next to the script by a tiny
  built-in loader — no `python-dotenv` dependency):
  - `GITLAB_URL` (required) — base URL, e.g. `https://gitlab.company.com`
  - `GITLAB_TOKEN` (required) — personal access token, **`read_api`** scope (read-only)
  - `GITLAB_GROUP` — group id or path; watches all its members
  - `GITLAB_USERS` — comma-separated usernames (alternative/addition to group)
  - `POLL_INTERVAL` (default 30s), `EVENT_LIMIT` (default 40 rows)
  - Must set URL + TOKEN and at least one of GROUP / USERS.
- **Member resolution:** `GET /groups/:id/members/all` (paginated) and/or
  `GET /users?username=…`. De-duplicated into a member list.
- **Polling:** every `POLL_INTERVAL`s it calls `GET /users/:id/events?sort=desc`
  for each member. Chosen **per-member** rather than per-project so request count
  scales with team size, not repo count.
- **Merge/dedupe:** events combined into one newest-first feed keyed by event `id`;
  ids not seen before are marked "new" (green `●`).
- **Rendering:** `rich.Live` full-screen panel with a table — columns: new-marker,
  Who (author), Action (human description), Project (path, cached via
  `GET /projects/:id`), When (relative time). Action text is color-coded by
  `action_name` (push=cyan, opened=green, merged=magenta, comment=blue, etc.).
- **`describe(event)`** turns a raw event into readable text, with special handling
  for `push_data` (commit count/ref/title) and `target_type` (MR `!iid`, issue `#iid`).
- **Error handling:** clear messages for 401 (bad token), unreachable host
  (reminds about office network/VPN), and per-poll failures retry on the next cycle.

### Verification status
- `python3 -m py_compile gitlab_watch.py` → **passes** (Python 3.13.4 on the user's Mac).
- **NOT run against a live GitLab** — the user was at home (no network access) when
  it was built. First real run should confirm the event payload field names match
  what `describe()` expects (standard GitLab REST shape, so expected to be fine).

## 5. Assumptions to double-check
- GitLab event objects expose `id`, `action_name`, `author`, `created_at`,
  `project_id`, `target_type`, `target_title`, `target_iid`, and `push_data`.
  These are the documented REST fields, but the instance version could differ.
- The token's account can see all the relevant projects. For full team coverage,
  a maintainer/owner-level token is best. Private-project activity invisible to the
  token simply won't appear.

## 6. Open / suggested next steps (offered, user has not yet chosen)
1. **Telegram push notifications** — send new events to a Telegram bot (Bot API,
   per the earlier conversation) so the user gets pings without watching the terminal.
2. **`--once` digest mode** — print "what happened today" and exit; ideal for the
   **cron / scheduled-agent** the user originally asked about. (Claude Code's
   `/schedule` could run it, but only from somewhere with GitLab network access —
   the home/office network constraint applies to any scheduler too.)
3. **Action-type filters** — show only MRs, only pushes, etc.

## 7. How to run (for reference)
```bash
cd /Users/abulkosim/gitlab-team-watch
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # edit GITLAB_URL, GITLAB_TOKEN, GITLAB_GROUP
python gitlab_watch.py        # Ctrl-C to quit
```

## 8. Privacy reminder
The tool monitors teammates' activity. Legitimate for standup digests / release
notes, but the user should ideally be transparent with the team that it exists.
Keep this framing in any further work.
