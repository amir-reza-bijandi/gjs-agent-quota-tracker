#!/usr/bin/env -S gjs -m
// Standalone check: validates the usage clients against the live API.
//   gjs -m tools/poll.js                    (uses ~/.claude)
//   gjs -m tools/poll.js ~/.claude-work      (a second Claude Code profile)
//   gjs -m tools/poll.js --antigravity       (the Antigravity CLI's /usage)
import GLib from 'gi://GLib';
import {UsageClient, defaultConfigDir} from '../src/lib/usageClient.js';
import {AntigravityClient, findAgy} from '../src/lib/antigravityClient.js';
import {normalizeWindows, normalizeSpend, normalizeAntigravityWindows} from '../src/lib/usageModel.js';

const loop = GLib.MainLoop.new(null, false);

// GJS exposes extra script arguments as the global ARGV regardless of module
// mode. Accept an absolute path, a ~/-relative path, or a path relative to cwd.
function resolveConfigDir(arg) {
    if (!arg)
        return defaultConfigDir();
    if (arg.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), arg.slice(2)]);
    if (GLib.path_is_absolute(arg))
        return arg;
    return GLib.build_filenamev([GLib.get_current_dir(), arg]);
}

const arg = typeof ARGV !== 'undefined' ? ARGV[0] : undefined;

function printWindows(windows) {
    print('\nusage windows (normalised):');
    for (const w of windows) {
        const active = w.isActive ? '  [active]' : '';
        const sev = w.apiLevel !== 'ok' ? `  api:${w.apiLevel}` : '';
        print(`  ${w.label}: ${Math.round(w.utilization)}%  resets ${w.resetsAt ?? '(n/a)'}${sev}${active}`);
    }
}

async function runClaude() {
    const configDir = resolveConfigDir(arg);
    const client = new UsageClient({configDir});

    print('config dir:', configDir);
    print('tier (from disk):', JSON.stringify(await client.tierFromDisk()));

    const profile = await client.fetchProfile();
    print('\nprofile:');
    print('  max:', profile.account?.has_claude_max, '| pro:', profile.account?.has_claude_pro);
    print('  org type:', profile.organization?.organization_type);
    print('  rate tier:', profile.organization?.rate_limit_tier);

    const usage = await client.fetchUsage();

    // Raw top-level keys, so it is obvious which shape the API is returning.
    print('\nraw usage keys:', Object.keys(usage).join(', '));
    print(`  limits[]: ${Array.isArray(usage.limits) ? usage.limits.length : '(none)'} entr${usage.limits?.length === 1 ? 'y' : 'ies'}`);

    // Normalised windows — exactly what the extension renders.
    printWindows(normalizeWindows(usage));

    const spend = normalizeSpend(usage);
    if (spend) {
        const pct = spend.percent !== null ? ` (${spend.percent}%)` : '';
        print(`\nextra usage: ${[spend.used, spend.limit].filter(Boolean).join(' / ')}${pct}  [${spend.level}]`);
    }
}

async function runAntigravity() {
    print('agy:', findAgy() ?? '(not found)');
    const usage = await new AntigravityClient().fetchUsage();
    print('\nmodel groups:', usage.groups.map(g => g.name).join(', ') || '(none)');
    printWindows(normalizeAntigravityWindows(usage));
}

(arg === '--antigravity' ? runAntigravity() : runClaude())
    .catch(e => {
        printerr('ERROR:', e.message);
        if (e.body)
            printerr('BODY:', e.body);
        imports.system.exit(1);
    })
    .finally(() => loop.quit());

loop.run();
