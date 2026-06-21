#!/usr/bin/env python3
"""
gitlab_watch.py — live terminal feed of every team member's GitLab activity.

Talks to the GitLab REST API directly (no Claude MCP needed), so it runs
anywhere the GitLab server is reachable (office WiFi / VPN).

Config comes from environment variables (or a .env file next to this script):

  GITLAB_URL       Base URL of your GitLab, e.g. https://gitlab.example.com   (required)
  GITLAB_TOKEN     Personal access token with `read_api` scope                (required)
  GITLAB_GROUP     Group id or full path (e.g. "myteam" or "org/myteam").
                   The tool watches every member of this group.
  GITLAB_USERS     Comma-separated usernames to watch instead of / in addition
                   to the group (e.g. "aziz,dilnoza,sardor").
  POLL_INTERVAL    Seconds between refreshes (default 30).
  EVENT_LIMIT      Max rows shown in the feed (default 40).
  DISCORD_WEBHOOK_URL  Optional. If set, every NEW event (after the first poll)
                   is also pushed to this Discord channel webhook.

You must set GITLAB_URL + GITLAB_TOKEN, and at least one of GITLAB_GROUP / GITLAB_USERS.
"""

import os
import sys
import json
import time
from datetime import datetime, timezone
from urllib.parse import urlencode, quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

try:
    from rich.console import Console, Group
    from rich.live import Live
    from rich.table import Table
    from rich.panel import Panel
    from rich.text import Text
except ImportError:
    sys.exit("Missing dependency 'rich'. Install with:  pip install rich")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_dotenv():
    """Minimal .env loader (KEY=VALUE per line) — no external dependency."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(path):
        return
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            os.environ.setdefault(key, val)


load_dotenv()

BASE = os.environ.get("GITLAB_URL", "").rstrip("/")
TOKEN = os.environ.get("GITLAB_TOKEN", "")
GROUP = os.environ.get("GITLAB_GROUP", "").strip()
USERS = [u.strip() for u in os.environ.get("GITLAB_USERS", "").split(",") if u.strip()]
POLL_INTERVAL = int(os.environ.get("POLL_INTERVAL", "30"))
EVENT_LIMIT = int(os.environ.get("EVENT_LIMIT", "40"))
DISCORD_WEBHOOK_URL = os.environ.get("DISCORD_WEBHOOK_URL", "").strip()

console = Console()


def fail(msg):
    console.print(f"[bold red]Error:[/] {msg}")
    sys.exit(1)


if not BASE:
    fail("GITLAB_URL is not set. See the README / .env.example.")
if not TOKEN:
    fail("GITLAB_TOKEN is not set. Create a personal access token with `read_api` scope.")
if not GROUP and not USERS:
    fail("Set GITLAB_GROUP and/or GITLAB_USERS so the tool knows whom to watch.")


# ---------------------------------------------------------------------------
# GitLab API
# ---------------------------------------------------------------------------

def api_get(path, params=None):
    url = f"{BASE}/api/v4{path}"
    if params:
        url += "?" + urlencode(params)
    req = Request(url, headers={"PRIVATE-TOKEN": TOKEN, "User-Agent": "gitlab-team-watch"})
    try:
        with urlopen(req, timeout=25) as resp:
            return json.load(resp)
    except HTTPError as e:
        if e.code == 401:
            fail("401 Unauthorized — check GITLAB_TOKEN (needs `read_api` scope).")
        if e.code == 404:
            raise  # let caller decide
        raise RuntimeError(f"HTTP {e.code} on {path}: {e.read().decode(errors='replace')[:200]}")
    except URLError as e:
        raise RuntimeError(f"Cannot reach {BASE} — are you on the office network/VPN? ({e.reason})")


def resolve_members():
    """Return list of {id, name, username} for everyone we should watch."""
    members = {}

    if GROUP:
        gid = quote(GROUP, safe="") if not GROUP.isdigit() else GROUP
        page = 1
        while True:
            try:
                batch = api_get(f"/groups/{gid}/members/all",
                                {"per_page": 100, "page": page})
            except HTTPError:
                fail(f"Group '{GROUP}' not found or not accessible with this token.")
            if not batch:
                break
            for m in batch:
                members[m["id"]] = {"id": m["id"], "name": m["name"],
                                    "username": m["username"]}
            if len(batch) < 100:
                break
            page += 1

    for username in USERS:
        found = api_get("/users", {"username": username})
        if found:
            u = found[0]
            members[u["id"]] = {"id": u["id"], "name": u["name"],
                                "username": u["username"]}
        else:
            console.print(f"[yellow]Warning:[/] user '{username}' not found, skipping.")

    if not members:
        fail("No members resolved. Check GITLAB_GROUP / GITLAB_USERS.")
    return list(members.values())


def fetch_user_events(user, per_page=30):
    """Recent events for a single user, newest first."""
    try:
        events = api_get(f"/users/{user['id']}/events",
                         {"per_page": per_page, "sort": "desc"})
    except HTTPError:
        return []
    for e in events:
        e["_user"] = user  # remember whom we polled (author field is also present)
    return events


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

ACTION_STYLE = {
    "pushed to": "cyan",
    "pushed new": "cyan",
    "deleted": "red",
    "opened": "green",
    "closed": "yellow",
    "merged": "magenta",
    "accepted": "magenta",
    "commented on": "blue",
    "joined": "dim",
    "left": "dim",
    "created": "green",
}


def rel_time(iso):
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return "?"
    delta = datetime.now(timezone.utc) - dt
    s = int(delta.total_seconds())
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


def describe(event):
    """Human-readable description of what happened."""
    action = event.get("action_name", "did")
    target_type = event.get("target_type") or ""
    title = event.get("target_title") or ""
    iid = event.get("target_iid")

    push = event.get("push_data")
    if push:
        count = push.get("commit_count", 0)
        ref = push.get("ref", "")
        verb = "pushed"
        plural = "commit" if count == 1 else "commits"
        ct = push.get("commit_title") or ""
        base = f"{verb} {count} {plural} to {ref}"
        return f"{base} — {ct}" if ct else base

    label = {"MergeRequest": "MR", "Issue": "issue", "Note": "comment",
             "DiffNote": "comment", "Milestone": "milestone",
             "WikiPage::Meta": "wiki"}.get(target_type, target_type.lower())

    ref = f" !{iid}" if target_type == "MergeRequest" and iid else (
          f" #{iid}" if target_type == "Issue" and iid else "")

    parts = [action]
    if label:
        parts.append(label + ref)
    desc = " ".join(parts).strip()
    if title and label not in ("comment",):
        desc += f": {title}"
    return desc


def project_name(event, project_cache):
    pid = event.get("project_id")
    if pid is None:
        return ""
    if pid not in project_cache:
        try:
            proj = api_get(f"/projects/{pid}")
            project_cache[pid] = proj.get("path_with_namespace", str(pid))
        except Exception:
            project_cache[pid] = str(pid)
    return project_cache[pid]


def build_table(events, new_ids, project_cache):
    table = Table(expand=True, show_edge=False, pad_edge=False, box=None)
    table.add_column("", width=2, no_wrap=True)          # new marker
    table.add_column("Who", style="bold", width=16, no_wrap=True)
    table.add_column("Action", ratio=3)
    table.add_column("Project", style="dim", ratio=1, no_wrap=True)
    table.add_column("When", justify="right", width=6, style="dim", no_wrap=True)

    for e in events[:EVENT_LIMIT]:
        author = (e.get("author") or {}).get("name") or e["_user"]["name"]
        action = e.get("action_name", "")
        style = ACTION_STYLE.get(action, "white")
        is_new = e.get("id") in new_ids
        marker = Text("●", style="bold green") if is_new else Text(" ")
        who = Text(author, style="bold white" if is_new else "bold")
        table.add_row(
            marker,
            who,
            Text(describe(e), style=style),
            project_name(e, project_cache),
            rel_time(e.get("created_at", "")),
        )
    return table


# ---------------------------------------------------------------------------
# Discord push notifications (optional)
# ---------------------------------------------------------------------------

EMOJI = {
    "pushed to": "⬆️", "pushed new": "🌱", "deleted": "🗑️",
    "opened": "✨", "closed": "🚪", "merged": "🟣", "accepted": "🟣",
    "commented on": "💬", "joined": "👋", "left": "👋", "created": "✨",
}


def discord_line(event, project_cache):
    """One-line plain-text summary of an event for Discord."""
    author = (event.get("author") or {}).get("name") or event["_user"]["name"]
    action = event.get("action_name", "")
    icon = EMOJI.get(action, "•")
    proj = project_name(event, project_cache)
    when = rel_time(event.get("created_at", ""))
    proj_part = f" · `{proj}`" if proj else ""
    # describe() can repeat the action verb; that's fine and reads naturally.
    return f"{icon} **{author}** {describe(event)}{proj_part} · _{when} ago_"


def post_to_discord(content):
    """POST a message to the Discord channel webhook. Best-effort; never raises."""
    if not DISCORD_WEBHOOK_URL:
        return
    data = json.dumps({"content": content[:1990],
                       "allowed_mentions": {"parse": []}}).encode()
    req = Request(DISCORD_WEBHOOK_URL, data=data,
                  headers={"Content-Type": "application/json",
                           "User-Agent": "gitlab-team-watch"},
                  method="POST")
    try:
        with urlopen(req, timeout=15):
            pass
    except (HTTPError, URLError):
        # Don't let a notification failure kill the live feed.
        pass


def notify_discord(new_events, project_cache):
    """Push new events to Discord, batched to respect the 2000-char message cap."""
    if not DISCORD_WEBHOOK_URL or not new_events:
        return
    # Oldest first so the channel reads chronologically.
    lines = [discord_line(e, project_cache) for e in reversed(new_events)]
    chunk, size = [], 0
    for line in lines:
        if size + len(line) + 1 > 1900 and chunk:
            post_to_discord("\n".join(chunk))
            chunk, size = [], 0
        chunk.append(line)
        size += len(line) + 1
    if chunk:
        post_to_discord("\n".join(chunk))


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def main():
    console.print(f"[dim]Resolving team members from "
                  f"{'group ' + GROUP if GROUP else ''}"
                  f"{' + ' if GROUP and USERS else ''}"
                  f"{('users ' + ','.join(USERS)) if USERS else ''} …[/]")
    members = resolve_members()
    console.print(f"[green]Watching {len(members)} member(s).[/] "
                  f"Polling every {POLL_INTERVAL}s. Ctrl-C to quit.")
    if DISCORD_WEBHOOK_URL:
        console.print("[cyan]Discord notifications enabled[/] "
                      "(first poll primes the feed; pings start with the next new event).")
    console.print()

    seen = set()            # all event ids we've ever shown
    project_cache = {}      # project_id -> path
    feed = []               # combined event list, newest first

    def poll():
        nonlocal feed
        collected = []
        for m in members:
            collected.extend(fetch_user_events(m))
        # de-dupe by id, keep newest
        by_id = {}
        for e in collected + feed:
            eid = e.get("id")
            if eid is not None:
                by_id[eid] = e
        merged = sorted(by_id.values(),
                        key=lambda e: e.get("created_at", ""), reverse=True)
        new_ids = {e["id"] for e in merged if e["id"] not in seen}
        seen.update(new_ids)
        feed = merged[:max(EVENT_LIMIT * 3, 120)]
        return new_ids

    def render(new_ids, status):
        header = Text(status, style="dim")
        table = build_table(feed, new_ids, project_cache)
        return Panel(Group(header, Text(""), table),
                     title="[bold]GitLab Team Activity[/]",
                     subtitle=f"[dim]{len(members)} members · {BASE}[/]",
                     border_style="cyan")

    first_poll = True
    try:
        with Live(console=console, screen=True, refresh_per_second=4) as live:
            while True:
                stamp = datetime.now().strftime("%H:%M:%S")
                live.update(render(set(), f"Refreshing… (last attempt {stamp})"))
                try:
                    new_ids = poll()
                    # Skip the first poll's "new" set — it's the whole backlog, not
                    # genuinely new activity — so we don't spam Discord at startup.
                    if not first_poll:
                        notify_discord([e for e in feed if e["id"] in new_ids],
                                       project_cache)
                    first_poll = False
                    status = (f"Updated {datetime.now().strftime('%H:%M:%S')} · "
                              f"{len(new_ids)} new since last poll · "
                              f"next in {POLL_INTERVAL}s")
                except RuntimeError as err:
                    new_ids = set()
                    status = f"[red]{err}[/] · retrying in {POLL_INTERVAL}s"
                live.update(render(new_ids, status))
                time.sleep(POLL_INTERVAL)
    except KeyboardInterrupt:
        console.print("\n[dim]Stopped.[/]")


if __name__ == "__main__":
    main()
