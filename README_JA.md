# LLMPET / Octopus Tauri

`0.5.0-phase4` は LLMPET fork を基にした Tauri 2 / Rust 移行候補ソースです。旧 Electron / Node ランタイムはソースツリーから完全に削除され、Tauri フロントエンド、Rust コア、リソース、テスト、リリースゲートだけが残っています。

Claude Code、CodeWhale、Codex、OpenCode、Aider 向けの個別アダプター、Claude の構造化対話、並列権限カード保持、計量、送信元 PID 系統によるターミナルフォーカス、サスペンド／画面構成変更からの復旧を実装しています。

`npm ci --ignore-scripts && npm test` はオフラインのソース検証です。公開前には実生成の `Cargo.lock`、3 OS の Rust ビルド、実 CLI／GUI／性能試験、署名と公証が必要です。
