# LiveWalk Project Workflow

## Repository map and ticket assignment

- Use this map as the sole ticket-assignment source; do not guess repository names:
  - `a-mostaani/livewalk-traveler` is the Traveler Android/Expo app.
  - `a-mostaani/livewalk-guide` is the Guide Android/Expo app.
  - `a-mostaani/livewalk-marketplace-api` is the shared backend/API deployed as `rendezvous-livewalk-api`.
- Treat remote repositories as the source of truth.

## Ticket execution

- Before starting, inspect ticket sections: Section A is human-only, Section B is agent-executable, and Section C is build-gated.
- For a human-only Section A blocker, including dashboard token creation, account or organization access, or an unavailable ticket-system entry, report it immediately and move to the next unblocked ticket. Do not wait or retry silently.
- Complete and report one ticket at a time before moving to the next.
- Follow the authoritative Section B order: B1 API hardening `LW-25`, `LW-26`, `LW-27`, `LW-29`; then Phase 0 foundation debt, Phase 1 backend/model correctness, Phase 2 media unlock, and Phase 3 monetize/scale. Work ticket-by-ticket and do not skip ahead unless explicitly reprioritized.
- `LW-15b` APK UI verification is parked behind builder ticket `#275` and must not block Section B work.
- Commit each meaningful LiveWalk step as it is completed and keep advancing sequentially until capacity is reached. Resume from the next unfinished ticket after reset or a forced pause.

## Git and scratch workflow

- Never commit directly to `main`.
- At the start of every coding turn, clone or pull the latest `peter-dev` into scratch, merge `main` into `peter-dev` before editing, and recreate regenerable dependencies there. Assume scratch is wiped between turns.
- If merging `main` creates a conflict that is not confidently resolvable, especially a schema or generated-file conflict, stop and ask rather than guessing.
- Commit meaningful changes early with a greppable ticket/action message, for example `LW-15b: restore traveler deps`. For operational project-rule changes use `LW-OPS: <action>`.
- Push `peter-dev` before reporting completion. If no source changed, explicitly report that no commit was needed.
- Keep `node_modules/`, `.expo/`, `build/`, `.venv/`, `dist/`, and all other regenerable dependency, build, and temporary trees out of the persistent workspace. Record the reason for any persistent exception for a large downloaded SDK component.

## Secrets and completion bar

- Never expose credential or token values in status updates, commit messages, or WhatsApp reports; use secret or environment-variable names only. Keep credentials in gitignored `.env` files or secure storage, and verify `.env` is gitignored and unstaged before every commit.
- A ticket is complete only after typecheck (`tsc --noEmit` or equivalent), relevant tests, a real route or flow exercise for user-flow changes, and a successful push to `peter-dev`.
- For Android/EAS compatibility issues, prefer `app.config.js` over `app.config.ts` when the known eas-cli/config-loader issue recurs.

## Progress reporting

- During active LiveWalk engineering, report progress every two hours until the work is paused or complete.
- Scheduled updates must reflect actual remote/GitHub state and use exactly: `Ticket ID | status (done/blocked/in-progress) | blocker (or none) | repo + branch + commit reference`.
- Do not call work done until it is pushed to `peter-dev`.

## Verified release promotion

- Development edits happen only on `peter-dev`. The sole exception is a verified release promotion: merge `peter-dev` cleanly into `main` and push `main` for production deployment or Android packaging; never edit `main` directly.
