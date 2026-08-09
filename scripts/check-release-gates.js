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
 check(/components:[^\n]*clippy/.test(text),`${wf} installs the clippy component`);
 check(/cargo clippy[^\n]*--all-targets[^\n]*--locked[^\n]*-- -[DA] warnings/.test(text),`${wf} treats Rust and Clippy warnings as errors`);
 check(/cargo fmt[^\n]*--check/.test(text)||/cargo fmt[^\n]*--all/.test(text),`${wf} verifies Rust formatting`);
}
const releaseWorkflow=fs.readFileSync(path.join(ROOT,'.github/workflows/release.yml'),'utf8');
check(releaseWorkflow.includes('name: Validate release source'),'.github/workflows/release.yml separates source validation');
check(/validate:[\s\S]*?permissions:\s*\n\s*contents: read/.test(releaseWorkflow),'.github/workflows/release.yml keeps validation read-only');
check(/prepare:[\s\S]*?needs: validate/.test(releaseWorkflow),'.github/workflows/release.yml creates drafts only after validation');
check(releaseWorkflow.includes('name: Prepare private release draft'),'.github/workflows/release.yml has a single draft owner');
check((releaseWorkflow.match(/npm test/g)||[]).length===1,'.github/workflows/release.yml runs source regression once');
check(releaseWorkflow.indexOf('npm test')<releaseWorkflow.indexOf('prepare:'),'.github/workflows/release.yml validates source before the write-enabled draft job');
check(releaseWorkflow.includes('releaseId: ${{ needs.prepare.outputs.release_id }}'),'.github/workflows/release.yml matrix uploads to the prepared release');
check(releaseWorkflow.includes('releaseDraft: true'),'.github/workflows/release.yml keeps matrix output private');
check(releaseWorkflow.includes('needs: [prepare, build]'),'.github/workflows/release.yml publishes only after every matrix build succeeds');
check(/gh release edit[^\n]*--draft=false[^\n]*--prerelease/.test(releaseWorkflow),'.github/workflows/release.yml has one post-build publication step');
check(releaseWorkflow.includes('permissions: {}'),'.github/workflows/release.yml has no workflow-wide write token');
check(/prepare:[\s\S]*?permissions:\s*\n\s*contents: write/.test(releaseWorkflow),'.github/workflows/release.yml scopes draft creation permission');
check(/build:[\s\S]*?permissions:[\s\S]*?id-token: write[\s\S]*?attestations: write/.test(releaseWorkflow),'.github/workflows/release.yml scopes build attestation permission');
check(/publish:[\s\S]*?permissions:\s*\n\s*contents: write/.test(releaseWorkflow),'.github/workflows/release.yml scopes publication permission');
check(releaseWorkflow.includes('GH_REPO: ${{ github.repository }}'),'.github/workflows/release.yml gives gh an explicit repository outside checkout');
check(releaseWorkflow.includes('name: Verify draft asset closure'),'.github/workflows/release.yml verifies release assets before publication');
check(releaseWorkflow.includes('node scripts/verify-release-assets.js release-audit/release.json release-audit 4'),'.github/workflows/release.yml reconciles four platform manifests');
check(releaseWorkflow.indexOf('Verify draft asset closure')<releaseWorkflow.indexOf('Make the fully assembled tag release visible'),'.github/workflows/release.yml reconciles assets before publishing');
check(fs.existsSync(path.join(ROOT,'scripts/verify-release-assets.js')),'release asset verifier is committed');
check(tauri.bundle?.createUpdaterArtifacts===false,'Tauri updater artifacts remain disabled');
check(!cargo.includes('tauri-plugin-updater'),'Tauri updater plugin remains absent');
if(mode==='release'){
 const platform=process.platform;
 const requirePlatform=String(process.env.REQUIRE_PLATFORM_SIGNING||'').toLowerCase()==='true';
 const platformCerts = {
   darwin: ['APPLE_CERTIFICATE','APPLE_CERTIFICATE_PASSWORD','APPLE_SIGNING_IDENTITY','APPLE_ID','APPLE_PASSWORD','APPLE_TEAM_ID'],
   win32: ['WINDOWS_CERTIFICATE','WINDOWS_CERTIFICATE_PASSWORD'],
 };
 const platformCertList = platformCerts[platform] || [];
 for(const name of platformCertList){
   const present=Boolean(process.env[name]);
   if(present) ok.push(`platform cert present: ${name}`);
   else if(requirePlatform) failures.push(`required platform cert missing: ${name}`);
   else console.error(`WARN     platform cert missing: ${name} (artifact will not carry the native OS publisher signature)`);
 }
}
// 'release-draft' mode is an isolated inspection build. 'release' enforces
// native platform publisher signing only when REQUIRE_PLATFORM_SIGNING=true.
// Tauri updater signing stays out of scope while updater artifacts are disabled.
for(const item of ok) console.log(`OK      ${item}`);
for(const item of blocked) console.log(`BLOCKED ${item}`);
for(const item of failures) console.error(`FAIL    ${item}`);
console.log(`release-gates: mode=${mode} ok=${ok.length} blocked=${blocked.length} failed=${failures.length}`);
process.exit(failures.length?1:0);
