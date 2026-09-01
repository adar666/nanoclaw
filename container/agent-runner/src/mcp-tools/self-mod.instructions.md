## Installing packages & tools

To install packages that persist, use the self-modification tools:

**`install_packages`** — request system (apt) or global npm packages. Requires admin approval.

Example flow:
```
install_packages({ apt: ["ffmpeg"], npm: ["@xenova/transformers"], reason: "Audio transcription" })
# → Admin gets an approval card → approves
```

**When to use this vs workspace `pnpm install`:**
- `pnpm install` if you only need it temporarily to do one task. Will not be available in subsequent truns.
- `install_packages` persists for all future turns. Use especially if the user specifically asks you to add a capability

### MCP servers (`add_mcp_server`)

Use **`add_mcp_server`** to add an MCP server to your configuration. Browse available servers at https://mcp.so — it's a curated directory of high-quality MCP servers. Most Node.js servers run via `pnpm dlx`, e.g.:

```
add_mcp_server({ name: "memory", command: "pnpm", args: ["dlx", "@modelcontextprotocol/server-memory"] })
```

Do not ask the user to give you credentials or tell them how to create credentials (OAuth, API keys, etc.) — NEVER fabricate credential setup instructions. Credentials are handled by the OneCLI gateway. Use `"onecli-managed"` as the placeholder value for any credential env vars or config fields. After the MCP server is installed and the container restarts, load `/onecli-gateway` for the full credential-handling flow (connect URLs, stubs, error recovery).

### Calendar registry (`add_calendar`, if the `calendar` skill is mounted)

Use **`add_calendar`** to add or override a calendar name in your calendar registry — never `ncl groups config add-calendar` for this. Both exist, but only `add_calendar` auto-restarts your container and notifies you once approved; the `ncl` route leaves the change pending until someone remembers to run `ncl groups restart` manually.

```
add_calendar({ name: "family", calendarId: "family-cal@group.calendar.google.com", reason: "..." })
# → Admin gets an approval card → approves → container restarts itself, you get an on-wake note
```

**This is the general rule for every `ncl groups config add-X`/`remove-X` verb, not just this one**: `install_packages`, `add_mcp_server`, and `add_calendar` each have a matching `ncl` CLI verb that does the same underlying thing, but only the tool call gives you the auto-restart+notify flow. Check whether a self-mod tool exists for what you're trying to do before reaching for `ncl config add-X`/`remove-X` — `ncl` is for everything that doesn't have one (and for reads).

### Your own self-mod history (`/workspace/agent/self-mod-log.md`)

Every approved change above (once applied) appends one line to `self-mod-log.md` in your own workspace — read it directly if the user asks what you've changed about yourself recently, or why a given package/MCP server/calendar is configured the way it is. It's read-only from your side (mounted that way on purpose) — you can read it, but you can't edit or clear it.
