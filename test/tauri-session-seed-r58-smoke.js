'use strict';

// R58-IMPL-E smoke: 冷启动会话回填（claude transcripts + codex rollouts）+
// dsh 30 分钟 mtime 预筛。结构断言 + REPLAY_QUIET 纪律断言（seed 只走
// ingest_with_ack 上板，绝不经 emit 通道发 pet:event 帧）。有 cargo 时实跑
// `cargo test --lib session_seed::`（缺失则跳过，与
// tauri-price-match-r58-smoke.js 的探测跳过模式一致）。

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const seed = read('src-tauri/src/session_seed.rs');
const lib = read('src-tauri/src/lib.rs');
const watcher = read('src-tauri/src/dsh_watch.rs');
const pkg = JSON.parse(read('package.json'));

// ── 1. 模块与公开入口存在 ──
assert(fs.existsSync(path.join(root, 'src-tauri/src/session_seed.rs')),
  'session_seed.rs must exist');
assert(seed.includes('pub fn seed_claude_sessions'),
  'session_seed.rs must expose seed_claude_sessions');
assert(seed.includes('pub fn seed_codex_sessions'),
  'session_seed.rs must expose seed_codex_sessions');

// ── 2. 上游窗口/上限/尾部探针被吸收（core.js BACKFILL_MAX_AGE_MS、
//        BACKFILL_MAX=15；codex-watch.js TAIL_PROBE_BYTES）──
assert(seed.includes('SEED_MAX_AGE_MS'), '30-minute window constant');
assert(seed.includes('SEED_MAX_SESSIONS'), 'seed cap constant');
assert(seed.includes('TAIL_PROBE_BYTES'), '128KB tail probe constant');
assert(seed.includes('collect_claude_candidates') && seed.includes('collect_codex_candidates'),
  'both provider collectors must exist');

// ── 3. REPLAY_QUIET 纪律：seed 帧只经 ingest_with_ack 上板，绝不发
//        pet:event；timestamp_ms 锚定 mtime；已存在的会话跳过（幂等）──
assert(seed.includes('runtime.ingest_with_ack(&event)'),
  'seeds must board through ingest_with_ack');
assert(!seed.includes('emit_hook_event'),
  'session_seed.rs must never route a frame through the pet event emitter (REPLAY_QUIET)');
assert(!seed.includes('app.emit'),
  'session_seed.rs must hold no direct window emit path');
assert(seed.includes('"timestamp_ms": candidate.mtime_ms'),
  'seed frames must anchor time at the transcript mtime');
assert(seed.includes('"hook_event_name": "SessionStart"'),
  'seeds are synthetic SessionStart frames');
assert(seed.includes('"seed": true'), 'seed frames must be marked');
assert(seed.includes('session_exists(runtime, &candidate.session_id)'),
  'sessions already on the board must be skipped (idempotent)');
assert(!seed.includes('transcript_path'),
  'seed frames must not replay metering through the transcript scanner');

// ── 4. lib.rs 接线：setup 在 dsh watcher 附近起后台线程跑 seed，写 "seed"
//        日志并推一帧合并 stats（上板可见），不阻塞 setup ──
assert(lib.includes('mod session_seed;'), 'lib.rs must declare the module');
assert(lib.includes('session_seed::seed_claude_sessions'),
  'setup must call the claude seed');
assert(lib.includes('session_seed::seed_codex_sessions'),
  'setup must call the codex seed');
assert.match(lib, /std::thread::spawn\(move \|\| \{[\s\S]*?session_seed::seed_claude_sessions/,
  'seeding must run on a background thread, not block setup');
assert(lib.includes('http_server::emit_stats(&seed_app, &seed_runtime)'),
  'seeding must refresh the board with one coalesced stats snapshot');
assert.match(lib, /write_log\(\s*"seed"/,
  'seed counts must be logged under the "seed" tag');

// ── 5. dsh 30 分钟 mtime 预筛（对齐上游 dsh-watch.js:880）──
assert(watcher.includes('DSH_SEED_MAX_AGE_MS'),
  'dsh watcher must define the cold-discovery mtime window');
assert.match(watcher, /now_ms\.saturating_sub\(mtime_ms\) > DSH_SEED_MAX_AGE_MS/,
  'new trackers must skip directories older than the window');
// R58-1d 的 dsh model 传递不得被本轮回退：
assert(watcher.includes('tracker.model = model.to_string();'),
  'R58-1d dsh model stamping must not regress');
assert(watcher.includes('"model": tracker.model.clone()'),
  'R58-1d dsh turn/end model field must stay attached');

// ── 6. 行为测试在模块内（窗口/子代理过滤/上限/上板+幂等）──
assert(seed.includes('seeds_fill_the_board_and_are_idempotent'),
  'glue test (board + idempotency) must exist');
assert(seed.includes('claude_candidates_respect_window_and_skip_sidechain_files'),
  'claude window/sidechain test must exist');
assert(seed.includes('claude_candidates_cap_at_fifteen'),
  'claude cap test must exist');
assert(seed.includes('codex_candidates_read_meta_and_filter_guardians'),
  'codex meta/guardian test must exist');
assert(seed.includes('codex_candidates_cap_at_fifteen'),
  'codex cap test must exist');

// ── 7. 注册进 npm test（字母序：r45 之后、single-instance 之前）──
assert(pkg.scripts.test.includes('node test/tauri-session-seed-r58-smoke.js'),
  'package.json test chain must run the seed smoke');

// ── 8. cargo 实跑（可跳过）──
const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
if (probe.status === 0) {
  const run = spawnSync('cargo', ['test', '--lib', 'session_seed::'], {
    cwd: path.join(root, 'src-tauri'),
    encoding: 'utf8',
    timeout: 600000,
  });
  if (run.status !== 0 && /pkg-config|gtk/i.test(String(run.stderr))) {
    console.log('skip: cargo test needs GTK dev libs; structural checks passed');
  } else {
    assert.strictEqual(run.status, 0, `cargo test --lib session_seed:: failed\n${run.stderr}`);
  }
} else {
  console.log('skip: cargo unavailable; structural checks passed');
}

console.log('tauri-session-seed-r58-smoke: OK');
