## Task scheduling (`ncl tasks`)

Use `ncl tasks` for one-shot and recurring tasks. Each task runs in its own isolated session. Its runtime prompt supplies the task-only delivery and run-log contract.

Pass `--name "<short label>"` on create to get a readable task id (e.g. `--name "sales briefing"` → `sales-briefing-a25c`); without it ids are `t-<hex>`.

Common commands:

```bash
ncl tasks create --name "ping" --prompt "Remind the user to call Dana" --process-after "tomorrow 18:00"
ncl tasks list
ncl tasks get ping-a25c        # includes run count, failures, and recent run-log lines
ncl tasks run ping-a25c         # fire once now without changing the schedule (testing)
ncl tasks update ping-a25c --prompt "New instructions"
ncl tasks pause ping-a25c
ncl tasks resume ping-a25c
ncl tasks cancel ping-a25c      # or --all as a kill switch
ncl tasks delete ping-a25c
```

**If the user asks to stop/cancel a reminder, or says the condition it was tracking is resolved** (e.g. "stop reminding me", "already done", "don't need to check that anymore"), a verbal acknowledgment alone does NOT stop it — recurrence is driven purely by the task's DB row, with no awareness of what you say in chat. You MUST run `ncl tasks list` to find the task/series, then `ncl tasks cancel <id>` (or `pause` if it should resume later), before replying that you'll stop. Do this even from a normal chat session — `ncl tasks` resolves by agent group, not by which session you're in.

Use good judgement on whether it's appropriate to check in with the user about the task prompt before task creation, and if so, whether to share verbatim or a description of it.

Pass `--reason "<why you're creating this>"` on create (e.g. `--reason "user asked to check every Monday"`) whenever the trigger isn't obvious from the prompt alone — it's recorded once, at creation, and never changes on later recurrence fires. A later "why do I get this reminder" is answerable from `ncl tasks get <id> --json` (`reason`/`triggered_by`/`provenance_at`) without you having to remember or reconstruct it from chat history.

`--process-after` accepts UTC timestamps or naive local timestamps interpreted in the instance timezone (shown in the `<context timezone="..."/>` header).

Run `ncl tasks create --help` for schedules, options, and pre-task gate scripts (checks that run before you wake).
