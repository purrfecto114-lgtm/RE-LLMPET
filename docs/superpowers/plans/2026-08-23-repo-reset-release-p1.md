# LLMPET v0.6.0 仓库重置 + Release 流水线 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 历史重开为 v0.6.0 单提交主线，清空旧 tag/release，落地双平台自适应签名的 Release 流水线并发出首个 Release。

**架构：** 本地构造 orphan 单提交 → GitHub REST API 切换默认分支并清理旧史 → 重写 `.github/workflows/{release,ci}.yml` → 打 tag 触发首发。
**技术栈：** git、GitHub REST API（curl + PAT）、GitHub Actions、electron-builder。

**执行纪律（用户指令）：** 遇矛盾/不符项目 → 暂停编辑 → 联网核实矫正计划 → 再继续，循环至结束。所有远端不可逆操作前必须本地已有完整存档分支。

---

### 任务 1：版本号 + orphan 单提交

**文件：** 修改 `package.json:3`；创建新历史。

- [ ] `package.json` `"version": "1.1.1"` → `"version": "0.6.0"`
- [ ] `git checkout --orphan reset/v06 && git add -A && git commit -m "LLMPET v0.6.0 — post-surgery rebuild"`
- [ ] 校验：`git log --oneline` 仅 1 条且无父级；`git rev-list --count HEAD` = 1
- [ ] 门禁：`node scripts/verify-surgery.js` exit 0（工作树内容与手术结果一致）

### 任务 2：远端探测（secrets 清单 + 权限）

- [ ] 写 `scripts/tmp/api-probe.sh`（curl + PAT 环境变量 GH_PAT，输出脱敏）：
```bash
API=https://api.github.com/repos/purrfecto114-lgtm/RE-LLMPET
auth="Authorization: Bearer $GH_PAT"
curl -sS -H "$auth" "$API" | grep -E '"(admin|push)"' # 权限自检
curl -sS -H "$auth" "$API/actions/secrets?per_page=100" | grep '"name"'
```
- [ ] 记录：是否含 APPLE_DEVELOPER_ID_P12_BASE64 等 5 项；PAT admin=true/false
- [ ] 结论写回本文件此行下：SIGNING_MODE=`full|adhoc`、CAN_UNPROTECT=`yes|no`

### 任务 3：切默认分支 + 删旧分支

- [ ] `git push origin reset/v06`
- [ ] `DELETE $API/branches/main/protection`（403/404 都视为"需手动"，记录）
- [ ] `PATCH $API` body `{"default_branch":"reset/v06"}`
- [ ] `DELETE` 远端 refs/heads/main、refs/heads/surgery/phase0（git push origin --delete）
- [ ] `POST $API/branches/reset%2Fv06/rename` body `{"new_name":"main"}`
- [ ] 本地：`git branch -m reset/v06 main && git fetch && git branch --set-upstream-to=origin/main`
- 回退：任何一步失败 → 保留双分支现状，输出手动清单

### 任务 4：清空旧 releases 与 51 tags

- [ ] github-script 或 curl 循环：`GET $API/releases?per_page=100` 分页 → 逐个 `DELETE /releases/{id}`
- [ ] `git ls-remote --tags origin | awk '{print $2}' | grep -v '\^{}'` → 批量 `git push origin --delete refs/tags/<t>`（分批 ≤30/次）
- [ ] 校验：ls-remote heads/tags 输出仅剩空（tag 由任务 6 重建）

### 任务 5：release.yml v2 全文替换

**文件：** 整体重写 `.github/workflows/release.yml`

```yaml
name: Release
on:
  push:
    tags: ["v*"]
permissions:
  contents: write
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm test
      - name: Tag/package version guard
        run: node -e "const v=require('./package.json').version;if('v'+v!==process.env.GITHUB_REF_NAME)throw new Error('mismatch')"
  build-windows:
    needs: test
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - uses: actions/cache@v4
        with:
          path: ~\AppData\Local\electron\Cache
          key: electron-win-${{ hashFiles('package-lock.json') }}
      - run: npx electron-builder --win --publish never
      - uses: actions/upload-artifact@v4
        with: { name: win-x64, path: "dist/*.exe\ndist/*.zip", if-no-files-found: error }
  build-macos:
    needs: test
    runs-on: macos-14
    outputs: { mode: ${{ steps.sig.outputs.mode }} }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - id: sig
        env: { P12: "${{ secrets.APPLE_DEVELOPER_ID_P12_BASE64 }}" }
        run: |
          if [ -n "$P12" ]; then echo mode=full >>"$GITHUB_OUTPUT"; else echo mode=adhoc >>"$GITHUB_OUTPUT"; fi
      - run: npm ci
      - if: steps.sig.outputs.mode == 'full'
        env:
          APPLE_DEVELOPER_ID_P12_BASE64: ${{ secrets.APPLE_DEVELOPER_ID_P12_BASE64 }}
          APPLE_DEVELOPER_ID_P12_PASSWORD: ${{ secrets.APPLE_DEVELOPER_ID_P12_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_APP_SPECIFIC_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
        run: |
          test -n "$APPLE_DEVELOPER_ID_P12_BASE64"
          node scripts/sign-notarize-mac.js --check-env
          npm run package:mac
          npm run verify:mac
      - if: steps.sig.outputs.mode == 'adhoc'
        run: LLMPET_MAC_SIGN_MODE=adhoc bash scripts/package-mac.sh
      - uses: actions/upload-artifact@v4
        with:
          name: mac-arm64-${{ steps.sig.outputs.mode }}
          path: "dist/*.zip"
          if-no-files-found: error
  publish:
    needs: [build-windows, build-macos]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/download-artifact@v4
        with: { path: release, merge-multiple: true }
      - run: cd release && sha256sum * > SHA256SUMS.txt
      - env: { GH_TOKEN: "${{ github.token }}" }
        run: gh release create "$GITHUB_REF_NAME" release/* --repo "$GITHUB_REPOSITORY" --title "LLMPET ${GITHUB_REF_NAME#v}" --generate-notes
      - uses: actions/github-script@v7
        with:
          script: |
            const keep = 3;
            const rels = await github.paginate(github.rest.repos.listReleases,
              { owner: context.repo.owner, repo: context.repo.repo, per_page: 100 });
            for (const r of rels.sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(keep)) {
              await github.rest.repos.deleteRelease({ owner: context.repo.owner, repo: context.repo.repo, release_id: r.id });
              if (r.tag_name !== context.ref.replace('refs/tags/',''))
                await github.rest.git.deleteRef({ owner: context.repo.owner, repo: context.repo.repo, ref: 'tags/'+r.tag_name }).catch(()=>{});
            }
```

- [ ] 写入并 `actionlint`（无则 `node -e` YAML 解析兜底）校验语法
- [ ] Commit `feat(release): adaptive-signing dual-platform pipeline w/ auto retention`

### 任务 6：ci.yml 加 workflow_dispatch + README 未签名声明

- [ ] ci.yml `on:` 增加 `workflow_dispatch:`
- [ ] README.md「下载」节追加：
  > macOS 包在仓库未配置 Apple 签名时为 adhoc 未签名版（文件名带 `-unsigned`）：首次打开需右键→打开，或 `xattr -cr /Applications/LLMPET.app`。
- [ ] Commit `docs+ci`

### 任务 7：打 tag v0.6.0 触发首发并盯护

- [ ] `git tag -a v0.6.0 -m "LLMPET v0.6.0 post-surgery" && git push origin v0.6.0`
- [ ] API 轮询 Actions run 直至 completion（≤20 分钟）
- [ ] 失败处置矩阵：mac adhoc 路径报错→查 package-mac.sh 对 adhoc 的实际支持并修；win 缓存路径错→改用 `%LOCALAPPDATA%\electron-builder\Cache` 双路径
- [ ] 验证 Release 页含：win exe/zip + mac zip(-unsigned?) + SHA256SUMS

### 任务 8：收尾

- [ ] 删除 scripts/tmp/api-probe.sh
- [ ] 本地 gc + 推送规格/计划文档所在 main
- [ ] 输出最终报告（前后对比：分支/tag/release 数量）
