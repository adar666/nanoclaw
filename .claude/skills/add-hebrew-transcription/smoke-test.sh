#!/bin/bash
# Real-audio smoke test for /add-hebrew-transcription. A model that loads
# and returns empty passes a trivial smoke test and fails in production —
# this project already hit exactly that failure shape once with Ollama
# returning valid-JSON-but-empty summaries. This asserts non-empty AND
# Hebrew-matching output against a real Hebrew audio fixture, not silence
# or a tone.
set -euo pipefail

FIXTURE="$(dirname "$0")/fixtures/hebrew-sample.ogg"

RESULT=$(cd "$(git rev-parse --show-toplevel)" && pnpm exec tsx -e "
import { transcribeVoiceNote } from './src/voice-transcription.ts';
transcribeVoiceNote('$FIXTURE').then((r) => {
  if (!r.ok) { console.error('SMOKE TEST FAILED:', JSON.stringify(r)); process.exit(1); }
  if (!r.text.trim()) { console.error('SMOKE TEST FAILED: empty transcript'); process.exit(1); }
  if (!/[֐-׿]/.test(r.text)) { console.error('SMOKE TEST FAILED: no Hebrew characters in output:', r.text); process.exit(1); }
  console.log('SMOKE TEST PASSED:', r.text);
});
")

echo "$RESULT"
