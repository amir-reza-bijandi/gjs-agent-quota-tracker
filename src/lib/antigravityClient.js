// Antigravity quota client: runs the Antigravity CLI's own quota command,
// `agy --output-format json -p /usage`, and hands back its structured data.
// The CLI does its own sign-in and token refresh, so the extension needs no
// credentials of its own. Like usageClient.js it is a pure GI module (no
// `resource:///org/gnome/shell` imports), so prefs and plain gjs
// (tools/poll.js) can use it too.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {UsageError, SignedOutError} from './usageClient.js';

// Give up on a run that takes longer than this. A normal one takes seconds.
const TIMEOUT_SECONDS = 60;

// The CLI writes a log file per run unless told otherwise; one per poll would
// pile up in ~/.gemini/antigravity-cli/log.
const ARGS = ['--log-file', '/dev/null', '--output-format', 'json', '-p', '/usage'];

// The agy binary: on PATH, else where its installer puts it. Null when
// Antigravity's CLI is not installed.
export function findAgy() {
    const onPath = GLib.find_program_in_path('agy');
    if (onPath)
        return onPath;
    const local = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'agy']);
    return GLib.file_test(local, GLib.FileTest.IS_EXECUTABLE) ? local : null;
}

// Runs agy with ARGS; resolves to its stdout. Cancelling `cancellable`, or
// running past TIMEOUT_SECONDS, kills the process.
function runAgy(agy, cancellable) {
    const own = new Gio.Cancellable();
    const parentId = cancellable ? cancellable.connect(() => own.cancel()) : 0;
    const timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_SECONDS, () => {
        own.cancel();
        return GLib.SOURCE_REMOVE;
    });
    const done = () => {
        GLib.source_remove(timeoutId);
        if (parentId)
            cancellable.disconnect(parentId);
    };

    return new Promise((resolve, reject) => {
        let proc;
        try {
            proc = Gio.Subprocess.new([agy, ...ARGS],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            done();
            reject(e);
            return;
        }
        proc.communicate_utf8_async(null, own, (p, res) => {
            done();
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (!p.get_successful() && !stdout?.trim()) {
                    reject(new UsageError(`agy exited with status ${p.get_exit_status()}`,
                        {body: stderr ?? ''}));
                    return;
                }
                resolve(stdout ?? '');
            } catch (e) {
                // Cancelled: make sure the CLI does not outlive the request.
                p.force_exit();
                if (!cancellable?.is_cancelled() && e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    reject(new UsageError(`agy gave no answer within ${TIMEOUT_SECONDS}s`));
                else
                    reject(e);
            }
        });
    });
}

export class AntigravityClient {
    // The /usage data: {description, groups: [{name, description, buckets:
    // [{id, name, window: '5h'|'weekly', remaining_fraction, reset_time}]}]}.
    // Rejects with a SignedOutError when agy is missing or not signed in.
    async fetchUsage(cancellable = null) {
        const agy = findAgy();
        if (!agy)
            throw new SignedOutError('Antigravity CLI (agy) not found. Install it and sign in.');
        const text = await runAgy(agy, cancellable);
        let out;
        try {
            out = JSON.parse(text);
        } catch {
            throw new UsageError('Unexpected output from agy /usage', {body: text});
        }
        const data = out?.command?.data;
        if (out?.status === 'SUCCESS' && Array.isArray(data?.groups))
            return data;
        const reason = String(out?.response ?? out?.error ?? '').trim();
        if (/not (logged|signed) in|log ?in|sign ?in/i.test(reason))
            throw new SignedOutError('Not signed in to Antigravity. Run agy and sign in.');
        throw new UsageError(reason || `agy /usage failed (${out?.status ?? 'no status'})`, {body: text});
    }
}
