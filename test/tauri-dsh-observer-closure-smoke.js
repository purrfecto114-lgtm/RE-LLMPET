'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const zstd = read('src-tauri/src/dsh_zstd.rs');
const watcher = read('src-tauri/src/dsh_watch.rs');
const lib = read('src-tauri/src/lib.rs');

assert.match(zstd, /Decoder::with_buffer\(&mut cursor\)\?\.single_frame\(\)/,
  'zstd decoder must stop at one frame without BufReader read-ahead');
assert.match(zstd, /pub fn decode_complete_frames/,
  'zstd incremental decoder must expose complete-frame consumption');
assert.doesNotMatch(zstd, /fn read_zstd_frame_size/,
  'Frame Content Size must not be used as compressed frame length');
assert.match(watcher, /file\.seek\(SeekFrom::Start\(tracker\.file_offset\)\)/,
  'plain and zstd readers must start at the committed offset');
assert.match(watcher, /decode_complete_frames\(&new_data\)\?/,
  'compressed bytes must be decoded before JSONL parsing');
assert.match(watcher, /tracker\.file_offset \+= committed as u64/,
  'offset must advance only by complete frame bytes');
assert.match(watcher, /format!\("dsh:\{\}", header\.id\)/,
  'dsh sessions need a provider-scoped internal key');
assert.match(watcher, /"seq": seq/,
  'dsh event sequence must reach Runtime ordering');
assert.match(watcher, /if !tracker\.accepts_events \{\s*return Ok\(\(\)\);\s*\}/,
  'unsupported and subagent headers must fail closed for the whole file');
assert.match(watcher, /\.as_millis\(\) as u64/,
  'idle cleanup must compare milliseconds with dsh event timestamps');
assert.match(lib, /dsh_watch::start_dsh_watcher\(runtime\.clone\(\)\)/,
  'Tauri setup must start the native dsh watcher');

console.log('tauri-dsh-observer-closure-smoke: ok');
