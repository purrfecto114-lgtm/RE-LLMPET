# RE-LLMPET / Octopus — Tauri 2 デスクトップペット

`0.5.5` は、現在の公式 LLMPET upstream と以前の 5-provider fork を照合した Tauri 2 / Rust 移行候補です。実行経路には Tauri フロントエンド、Rust コア、リソース、テスト、リリースゲートだけが含まれ、Electron main/preload/Node ランタイムは含まれません。

Claude Code、CodeWhale、Codex、OpenCode、Aider の個別アダプター、Claude の構造化対話、並列権限カード、計量、送信元 PID に基づくターミナルフォーカス、サスペンド／画面構成変更からの復旧を実装しています。デスクトップペットと詳細パネルの主要 UI は簡体字中国語・英語・日本語を切り替えられます。透明領域のクリック透過はネイティブのカーソル判定で復帰し、短いクリックとドラッグを区別します。ポップアップの論理サイズは DPI 変換され、ペット下端中央を固定します。Windows では allowlist 済み Agent を Windows Terminal に直接渡し、`wt.exe` が起動できない場合だけ `cmd.exe /D /K` にフォールバックします。公式 upstream の GIF/音声 2 組はバイト単位で保持し、現在は皮膚位置に追従する明示的なローカル側面プレビューとして統合しています。provider/session の所有権を Rust 側で保証できるまで、完全な Prompt 送信は意図的に保留しています。

起動対象は固定 allowlist、`pet` と `panel` は別々の Tauri capability、CSP は制限付き、ローカル HTTP は loopback のみです。Windows の置換処理にはバックアップと失敗時ロールバックを追加しました。

オフライン検証:

```bash
npm ci --ignore-scripts
npm test
npm run gate:assets
npm run gate:memes
npm run gate:source
```

`src-tauri/Cargo.lock` はコミット済みです。公開前には 3 OS の Rust/Tauri ビルド、実 provider CLI、実 GUI／性能試験、署名・公証、第三者メディア権利の確認が必要です。

詳細は [`docs/FOLLOWUP_DRAG_TERMINAL_UI_2026-07-28.md`](docs/FOLLOWUP_DRAG_TERMINAL_UI_2026-07-28.md)、[`docs/UPSTREAM_RECONCILIATION_2026-07-28.md`](docs/UPSTREAM_RECONCILIATION_2026-07-28.md)、[`docs/MIGRATION_STATUS.md`](docs/MIGRATION_STATUS.md) を参照してください。
