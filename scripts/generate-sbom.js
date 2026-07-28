#!/usr/bin/env node
'use strict';
const fs=require('fs'), path=require('path'), crypto=require('crypto');
const root=path.resolve(__dirname,'..'); const out=path.resolve(process.argv[2]||'reports/octopus.spdx.json');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
const packages=[{SPDXID:'SPDXRef-Package-Octopus',name:pkg.name,versionInfo:pkg.version,downloadLocation:'NOASSERTION',filesAnalyzed:false,licenseConcluded:pkg.license||'NOASSERTION',licenseDeclared:pkg.license||'NOASSERTION',copyrightText:'NOASSERTION'}];
const lockPath=path.join(root,'src-tauri','Cargo.lock');
if(fs.existsSync(lockPath)){
 const text=fs.readFileSync(lockPath,'utf8').replace(/\r\n/g,'\n'); let i=0;
 for(const block of text.split(/\n\[\[package\]\]\n/).slice(1)){
  const n=(block.match(/^name = "([^"]+)"/m)||[])[1], v=(block.match(/^version = "([^"]+)"/m)||[])[1]; if(!n||!v) continue;
  packages.push({SPDXID:`SPDXRef-Cargo-${++i}`,name:n,versionInfo:v,downloadLocation:'NOASSERTION',filesAnalyzed:false,licenseConcluded:'NOASSERTION',licenseDeclared:'NOASSERTION',copyrightText:'NOASSERTION'});
 }
}
const repositoryUrl=typeof pkg.repository==='string'?pkg.repository:(pkg.repository&&pkg.repository.url)||'';
const repositorySlug=process.env.GITHUB_REPOSITORY
 || (repositoryUrl.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/i)||[])[1]
 || 'purrfecto114-lgtm/RE-LLMPET';
const ns=`https://github.com/${repositorySlug}/spdx/${pkg.version}/${crypto.randomUUID()}`;
const relationships=[{spdxElementId:'SPDXRef-DOCUMENT',relationshipType:'DESCRIBES',relatedSpdxElement:'SPDXRef-Package-Octopus'},...packages.slice(1).map(p=>({spdxElementId:'SPDXRef-Package-Octopus',relationshipType:'DEPENDS_ON',relatedSpdxElement:p.SPDXID}))];
const doc={spdxVersion:'SPDX-2.3',dataLicense:'CC0-1.0',SPDXID:'SPDXRef-DOCUMENT',name:`Octopus-${pkg.version}`,documentNamespace:ns,creationInfo:{created:new Date().toISOString(),creators:['Tool: scripts/generate-sbom.js']},packages,relationships};
fs.mkdirSync(path.dirname(out),{recursive:true}); fs.writeFileSync(out,JSON.stringify(doc,null,2)+'\n'); console.log(`generate-sbom: ${packages.length} packages -> ${out}${fs.existsSync(lockPath)?'':' (Cargo.lock absent: Rust dependency list incomplete)'}`);
