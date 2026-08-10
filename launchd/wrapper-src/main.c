/*
 * NanoClawBridge — minimal supervisor wrapper so nanoclaw-v2's launchd job
 * runs under a stable, codesigned .app identity instead of bare
 * /usr/local/bin/node.
 *
 * WHY THIS HAS TO BE A COMPILED BINARY, NOT A SHELL SCRIPT:
 * codesign signs the actual Mach-O image the kernel loads for this PID. A
 * shebang script (#!/bin/bash ...) never becomes its own Mach-O image — the
 * kernel loads /bin/bash (Apple's own system binary, already signed by
 * Apple) to interpret it, so the RUNNING PROCESS's code identity is bash's,
 * not this bundle's, no matter what codesign is run against the script
 * file. TCC would key any grant to /bin/bash — not what we want, and Apple
 * TCC treats bare /bin/bash/sh as unable to hold Camera/Microphone grants
 * at all in current macOS specifically because of this loophole.
 *
 * WHY THIS SPAWNS NODE AS A CHILD INSTEAD OF exec()-ing IT:
 * exec() replaces the CURRENT process image — the same PID would become
 * node, and node's own (unsigned, generic) code identity is what the
 * kernel/TCC would see from then on, losing this bundle's identity
 * entirely. posix_spawn() instead forks a genuine CHILD process running
 * node, with this wrapper remaining alive as its parent — the same
 * relationship Terminal.app has to the shells/tools it launches, which is
 * exactly the "responsible process" mechanism this whole wrapper exists to
 * put nanoclaw-v2 (and everything IT spawns, several hops down to
 * negotiator's ffmpeg/avfoundation call) underneath.
 *
 * 2026-08-09 bug: the first build inherited its CALLER's cwd/env/fds
 * instead of setting its own — fine under launchd (whose plist WAS setting
 * WorkingDirectory/EnvironmentVariables/StandardOut/ErrPath for us before
 * exec), but NOT fine for the one-time interactive launch (Finder/`open`/
 * Terminal) needed to trigger the Microphone TCC prompt in the first
 * place, which sets none of that — nanoclaw-v2 died on startup (ENOENT
 * opening package.json) before it ever touched the mic, so no TCC request
 * ever happened and there was nothing to grant. Fixed by replicating the
 * plist's WorkingDirectory/EnvironmentVariables/Standard{Out,Error}Path
 * explicitly here, so correctness doesn't depend on how this binary is
 * launched. Ad-hoc signing means every rebuild costs any grant that
 * already exists (no Team ID to anchor to instead) — this must be the last
 * rebuild before that grant is actually obtained.
 *
 * Forwards SIGTERM/SIGINT to the child so launchd's normal stop still
 * reaches nanoclaw-v2 for a clean shutdown, and relays its exit status back
 * to launchd (matters for KeepAlive's restart/backoff decisions).
 */
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

static pid_t child_pid = -1;

static void forward_signal(int sig) {
    if (child_pid > 0) kill(child_pid, sig);
}

// Redirects fd onto path (append, create if missing) — mirrors the
// LaunchAgent plist's StandardOutPath/StandardErrorPath. Replicated here
// (not left to the launcher) so nanoclaw-v2's own log output lands in the
// same place regardless of whether this runs under launchd or was launched
// manually for the one-time TCC grant — the exact log the previous crash
// silently never reached.
static void redirect_to_log(int fd, const char *path) {
    int logfd = open(path, O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (logfd < 0) {
        // Nowhere useful to log this failure yet — leave fd as whatever it
        // already was (inherited from the launcher) rather than going dark.
        fprintf(stderr, "NanoClawBridge: failed to open log %s: %s\n", path, strerror(errno));
        return;
    }
    dup2(logfd, fd);
    close(logfd);
}

int main(void) {
    signal(SIGTERM, forward_signal);
    signal(SIGINT, forward_signal);

    // Replicates the LaunchAgent plist's WorkingDirectory — see the
    // 2026-08-09 note above for why this must not depend on the launcher.
    const char *work_dir = "/Users/uriel/Projects/nanoclaw-v2";
    if (chdir(work_dir) != 0) {
        fprintf(stderr, "NanoClawBridge: chdir(%s) failed: %s\n", work_dir, strerror(errno));
        return 1;
    }

    // Replicates the plist's EnvironmentVariables verbatim — including the
    // deliberate OMISSION of /opt/homebrew/bin (see nanoclaw-v2's
    // apply.js: negotiator's own execFileAsync calls widen PATH downstream
    // instead; duplicating that widening here would be a silent behavior
    // change, not just a port of the plist).
    setenv("PATH", "/usr/local/bin:/usr/bin:/bin:/Users/uriel/.local/bin", 1);
    setenv("HOME", "/Users/uriel", 1);

    // Replicates StandardOutPath/StandardErrorPath — same absolute paths
    // the plist already used, so existing log-checking habits don't change.
    redirect_to_log(STDOUT_FILENO, "/Users/uriel/Projects/nanoclaw-v2/logs/nanoclaw.log");
    redirect_to_log(STDERR_FILENO, "/Users/uriel/Projects/nanoclaw-v2/logs/nanoclaw.error.log");

    char *node_argv[] = {
        "/usr/local/bin/node",
        "--env-file=/Users/uriel/Projects/nanoclaw-v2/.env",
        "/Users/uriel/Projects/nanoclaw-v2/dist/index.js",
        NULL,
    };

    int rc = posix_spawn(&child_pid, "/usr/local/bin/node", NULL, NULL, node_argv, environ);
    if (rc != 0) {
        fprintf(stderr, "NanoClawBridge: posix_spawn failed (errno %d)\n", rc);
        return 1;
    }

    int wstatus = 0;
    waitpid(child_pid, &wstatus, 0);
    if (WIFEXITED(wstatus)) return WEXITSTATUS(wstatus);
    if (WIFSIGNALED(wstatus)) return 128 + WTERMSIG(wstatus);
    return 1;
}
