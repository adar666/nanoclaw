/**
 * On-demand audio-file transcription module.
 *
 * Registers `transcribe_audio` as an unguarded delivery action — it only
 * ever reads a file the agent's own session already received (already
 * inside the container's own sandbox) and runs a local subprocess
 * (ffmpeg/whisper-cli); there is no privileged host mutation to hold for
 * admin approval, unlike self-mod's install_packages/add_mcp_server.
 *
 * Without this module: the MCP tool in the container still writes the
 * outbound system message, but delivery logs "Unknown system action" and
 * drops it — same failure mode as any other unregistered action.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleTranscribeAudio } from './apply.js';

registerDeliveryAction(
  'transcribe_audio',
  handleTranscribeAudio,
  unguarded(
    "reads an already-received attachment inside the caller's own session sandbox and runs a local " +
      'subprocess (ffmpeg/whisper-cli) — no privileged host mutation, nothing to hold for approval',
  ),
);
