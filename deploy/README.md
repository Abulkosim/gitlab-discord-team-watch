# Running on login (macOS `launchd`)

This makes the watcher start automatically every time you log in to your office
Mac, so you never have to run anything by hand. It runs in the background (no
window), logs to a file, and restarts itself if it dies. While you're off the
VPN it just keeps retrying — no crash, no spam.

> **Note:** the Mac only polls while it's **on and awake**. Asleep = no polling;
> it resumes when the Mac wakes. That's fine for office hours.

## One-time setup on the office machine

**1. Get your real values.** Run these on the office Mac and note the output:

```bash
command -v node     # -> path to node, e.g. /Users/you/.nvm/versions/node/vXX/bin/node
echo $HOME          # -> /Users/you
pwd                 # run inside the project folder -> its full path
```

**2. Make sure `.env` is filled in and works.** Before automating, confirm a
plain run actually connects and watches your team (Ctrl-C to stop):

```bash
node gitlab-watch.js
```

You should see `Watching N member(s)…` then `Primed feed with … events`. If you
get "Group not found" or a 401, fix `.env` first — the service can't fix config.

**3. Create the LaunchAgent.** Copy the template into place, renaming `USER` to
your short username:

```bash
cp deploy/com.USER.gitlab-team-watch.plist \
   ~/Library/LaunchAgents/com.$(whoami).gitlab-team-watch.plist
```

**4. Edit the four `/REPLACE/WITH/...` placeholders** in that new file
(`~/Library/LaunchAgents/com.<you>.gitlab-team-watch.plist`) using the values
from step 1. Use **absolute paths** — `~` does not expand inside a plist.

**5. Load and start it:**

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.$(whoami).gitlab-team-watch.plist
```

It's now running and will start on every login. Check it:

```bash
launchctl print gui/$(id -u)/com.$(whoami).gitlab-team-watch | grep -E 'state|pid|last exit'
tail -f ~/Library/Logs/gitlab-team-watch.log
```

## Everyday use

Nothing. Log in → it's already running and posting to Discord.

## Managing it

```bash
# Stop + unload (won't restart until you load it again or next login):
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.$(whoami).gitlab-team-watch.plist

# Start it again:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.$(whoami).gitlab-team-watch.plist

# Restart after editing the .env or the plist (bootout then bootstrap):
launchctl kickstart -k gui/$(id -u)/com.$(whoami).gitlab-team-watch

# Watch the log live:
tail -f ~/Library/Logs/gitlab-team-watch.log
```

## If you upgrade Node (nvm)

nvm puts each Node version in its own folder, so the path in `ProgramArguments`
will break. Re-run `command -v node`, update that first `<string>` in the plist,
then `launchctl kickstart -k …` to restart.

## To stop it starting on login permanently

`bootout` it (above) and delete `~/Library/LaunchAgents/com.<you>.gitlab-team-watch.plist`.
