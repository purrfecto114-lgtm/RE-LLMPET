#!/usr/bin/env node
'use strict';
const fs=require('fs'), path=require('path');
const ROOT=path.resolve(__dirname,'..'); const mode=process.argv.includes('--release')?'release':process.argv.includes('--release-draft')?'release-draft':process.argv.includes('--ci')?'ci':'source';
const failures=[], blocked=[], ok=[];
const readJson=p=>JSON.parse(fs.readFileSync(path.join(ROOT,p),'utf8'));
const pkg=readJson('package.json'), npmLock=readJson('package-lock.json'), tauri=readJson('src-tauri/tauri.conf.json');
const cargo=fs.readFileSync(path.join(ROOT,'src-tauri/Cargo.toml'),'utf8');
const cargoVersion=(cargo.match(/^version = "([^"]+)"/m)||[])[1];
function check(cond,label,kind='fail'){(cond?ok:(kind==='block'?blocked:failures)).push(label);}
check(pkg.version===tauri.version&&pkg.version===cargoVersion,`version parity package=${pkg.version}, tauri=${tauri.version}, cargo=${cargoVersion}`);
check(npmLock.version===pkg.version&&npmLock.packages?.['']?.version===pkg.version,`npm lock parity package=${pkg.version}, lock=${npmLock.version}, root=${npmLock.packages?.['']?.version}`);
for(const old of ['main.js','preload.js','backend','providers','renderer','hook','shared']) check(!fs.existsSync(path.join(ROOT,old)),`retired runtime path removed: ${old}`);
const activeRoots=['src-tauri','frontend','scripts','test'];
function walk(d){if(!fs.existsSync(d))return[];return fs.readdirSync(d,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(d,e.name)):[path.join(d,e.name)]);}
const retiredRefs=activeRoots.flatMap(r=>walk(path.join(ROOT,r))).filter(f=>/\.(rs|js|html|json|toml|yml|yaml)$/.test(f)).filter(f=>path.basename(f)!=='check-release-gates.js').filter(f=>fs.readFileSync(f,'utf8').includes(['legacy', 'reference'].join('-') + '/'));
check(retiredRefs.length===0,`active source contains no archived-runtime imports (${retiredRefs.map(f=>path.relative(ROOT,f)).join(', ')||'none'})`);
check(!fs.existsSync(path.join(ROOT,['legacy', 'reference'].join('-'))),'archived runtime tree is absent');
check(fs.existsSync(path.join(ROOT,'test/reference-contract-smoke.js')),'data-only reference contract fixtures retained');
check(fs.existsSync(path.join(ROOT,'resources/model-catalog.bundled.json')),'active bundled model catalog is under resources/');
const lock=fs.existsSync(path.join(ROOT,'src-tauri/Cargo.lock'));
check(lock,'resolved src-tauri/Cargo.lock committed',mode==='source'?'block':'fail');
for(const wf of ['.github/workflows/ci.yml','.github/workflows/release.yml']){
 const text=fs.readFileSync(path.join(ROOT,wf),'utf8');
 check(/cargo (check|test|build)[^\n]*--locked|--locked[^\n]*cargo/.test(text)||text.includes('cargo tauri build --locked'),`${wf} enforces --locked`);
}
if(mode==='release'){
 const platform=process.platform;
 // R34 (2026-07-31): TAURI_SIGNING_PRIVATE_KEY is the HARD requirement
 // for `--release` mode — it signs the Tauri updater artifact so auto-
 // updates can be verified. Without it, tag pushes fail-closed (see
 // .github/workflows/release.yml).
 //
 // Platform code-signing certs (Windows code-signing cert, Apple Developer
 // ID + notarization) are a SEPARATE concern from Tauri updater signing.
 // They suppress "unknown publisher" warnings and unlock OS-gated features
 // (SmartScreen reputation, Gatekeeper notarization), but their absence
 // does NOT make the build unverifiable — the Tauri signature still
 // proves the binary came from us.
 //
 // The 0.5.7 audit (§P0-4) called out Tauri-signing-key-missing as a
 // blocker because v0.5.7 published TRULY UNSIGNED binaries. With the
 // Tauri key now configured, missing platform certs become a soft warn
 // (production hardening, not a security hole). When platform certs are
 // available, set them as GitHub secrets to silence the warning.
 const required=['TAURI_SIGNING_PRIVATE_KEY'];
 for(const name of required) check(Boolean(process.env[name]),`release secret present: ${name}`);
 const platformCerts = {
   darwin: ['APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_SIGNING_IDENTITY','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID'],
   win32: ['WINDOWS_CERTIFICATE','WINDOWS_CERTIFICATE_PASSWORD'],
 };
 const platformCertList = platformCerts[platform] || [];
 for(const name of platformCertList){
   const present = Boolean(process.env[name]);
   if(present){
     ok.push(`platform cert present: ${name}`);
   } else {
     // Soft warn — does not fail the build. Tauri updater signing is
     // sufficient for the binary to be cryptographically attributable;
     // platform certs only affect OS-level UX (SmartScreen/Gatekeeper).
     console.error(`WARN     platform cert missing: ${name} (OS 'unknown publisher' warning will show; not a security blocker)`);
   }
 }
}
// 'release-draft' mode: build unsigned draft artifacts (no signing secrets).
// Used for pre-release/testing builds. production signed releases use --release.
for(const item of ok) console.log(`OK      ${item}`);
for(const item of blocked) console.log(`BLOCKED ${item}`);
for(const item of failures) console.error(`FAIL    ${item}`);
console.log(`release-gates: mode=${mode} ok=${ok.length} blocked=${blocked.length} failed=${failures.length}`);
process.exit(failures.length?1:0);
