# Project Context — NanoClaw

Standing context for every BMad run on this repo (spec, architecture, epics, build, retrospective) — loaded automatically as a persistent fact by every BMad skill's `customize.toml`.

## What this project actually is

NanoClaw is Uriel's real, live household assistant (see `README.md`/`CLAUDE.md` for the technical architecture) — but that's not the only thing it's for. It's also meant to serve as a genuine, end-to-end example of what a strong, capable agent can build and operate: a working demonstration project, not just a household utility.

**This changes how scope and investment decisions should be made.** The instinct "this is a single-household project, low volume, low stakes — don't over-engineer it" is the wrong lens by default. The right lens: **what would a well-run engineering team building this as a real product actually do?** Apply industry-standard practices — proper eval infrastructure, real test coverage, defense-in-depth, documented architecture decisions — even where a narrowly-scoped household tool wouldn't strictly need them, because the point is to demonstrate the capability, not just to solve the immediate problem cheaply.

This is a general standing instruction for the whole project, not scoped to any one feature or epic. When a scope/investment question comes up (build vs. defer, quick script vs. real infrastructure, skip vs. do it properly), default toward the industry-standard answer and say so explicitly — don't silently downgrade to "good enough for one household" without surfacing that as the choice being made.

**Concrete example that prompted writing this down (2026-08-19):** an "eval harness for guest-resolution behavior" finding (`_bmad-output/implementation-artifacts/deferred-work.md`) was initially scoped down to "not proportionate for a single-household system" — the user corrected this: the project's own goal (showcase-quality, industry-standard, not just household-sized) means this kind of investment should be evaluated against what real production agent systems do, not against what a household chatbot minimally needs.

## Also relevant

- The user wants capabilities that generalize across channels (WhatsApp, etc.) and integrations (API-based tools, Snagit-style screenshot/capture tooling) where it makes sense — not narrowly built for Telegram-only or for this one household's exact current needs. When designing a new capability, consider whether it should be channel-agnostic / reusable rather than hardcoded to the current integration surface.
