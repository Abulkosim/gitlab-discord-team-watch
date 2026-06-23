# Deploying / running on login

To run the watcher automatically on login (no terminal, starts itself, restarts
if it dies) see the full macOS `launchd` guide:

**→ [`deploy/README.md`](deploy/README.md)**

In short: fill in `.env`, copy `deploy/com.USER.gitlab-team-watch.plist` into
`~/Library/LaunchAgents/` (rename `USER` to your username), replace the four
`/REPLACE/WITH/...` paths, then load it with `launchctl bootstrap`. After that
it's automatic — log in and it's already polling GitLab and posting to Discord.
