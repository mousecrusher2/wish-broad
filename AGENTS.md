# リポジトリガイドライン

## プロジェクト構成とモジュール配置

### クライアント（`src/`）

`src/` には React 19 + Vite のクライアントコードを配置しています。

- `src/main.tsx`、`src/App.tsx`: アプリケーションの起動処理
- `src/api.ts`: API 関連
- `src/` 直下のページレベルコンポーネント
- `src/components/`: 小さな UI 部品
- `src/player/`: WHEP 再生、再接続処理、TURN 認証情報の取得、PeerConnection のセッション管理

### Worker（`worker/`）

`worker/` には Cloudflare Worker を配置しています。

- `worker/main.ts`: Worker のエントリーポイント。Hono アプリ、`LiveState` Durable Object クラス、および `LiveState` から呼び出される `LiveEffects` エントリーポイントを再エクスポートするだけの薄いモジュールです。ここに実装ロジックを書かないでください。
- `worker/index.ts`: ルート構成層
- `worker/live-state.ts`: Durable Object の挙動（`LiveState`: トランザクション、再接続猶予アラーム、通知削除アウトボックス）
- `worker/live-end.ts`: Durable Object からの依頼で Worker が実行する処理

## ビルド・テスト・開発コマンド

`.cmd` や `.ps1` のシムを含め、`node_modules/` 配下の実行ファイルを直接呼び出さないでください。package.json のスクリプトには常に `pnpm run <script>`、パッケージのバイナリには `pnpm exec <binary>` を使用してください。この環境ではサンドボックス制限により `pnpm exec ...` が失敗する場合がありますが、`node_modules/` 直下の実行ファイルへフォールバックせず、昇格権限（サンドボックス外）で再実行してください。

## コーディングスタイルと命名規則

### コメントと `docs/architecture.md` の書き分け

理由は 1 か所にだけ書き、コードとドキュメントで重複させないでください。

- `docs/architecture.md`: 複数のモジュールにまたがる設計判断、ライフサイクルと状態遷移、トレードオフを記載します。
- コードコメント: その箇所だけで完結する制約・不変条件・外部 API の仕様や癖など、知らないと誤って「直して」しまいそうな点を 1〜3 行で書きます。
- 宣言と行コメントの使い分け: 宣言（関数・クラス・メソッド・型とそのフィールド・定数）の説明には `/** */` の JSDoc を使い、関数本体の中の注記や複数の宣言にまたがる注記には `//` を使います。JSDoc には「何をするか」「`null` や `false` など特別な戻り値の意味」「`@throws`」だけを書き、名前や型から明らかな宣言には付けないでください。

### バリデーション・エラー処理・責務分離

- 名前付きの `Error` サブクラスは、主に呼び出し元がその失敗から回復する場合や、実行時にその種別で分岐する場合に作成します。ただし、回復も分岐もしないというだけでむやみに `Error` にまとめないでください。
- 関数が意図的にスローするエラーは JSDoc の `@throws` に明記してください。

### `LiveState` Durable Object の制約

- `LiveState` Durable Object は外部応答の待機時間に対しても課金されるため、Realtime SFU や Discord その他の外部 API を呼び出してはならず、自身のストレージおよびアラーム呼び出し以外の非同期処理を呼び出してはなりません。`await` せずに呼び出す場合も同様です。
- `LiveState` 自身が外部処理を開始する必要がある場合は `LiveEffects` へ引き渡してください。`LiveEffects` のメソッドは即座に制御を返し、実際の処理を `waitUntil` 内で実行します。

## テストガイドライン

### Worker テストの書き方と注意点

- `worker/` のテストは `cloudflare:workers` の `env` を通じて、SQLite ストレージとアラームを備えた実際の `LiveState` と `LiveEffects` を使用します。
- Durable Object スタブの RPC 呼び出しが返す Promise は関数としても呼び出せるため、`expect(...).rejects` に渡す前に通常の `Promise` で包んでください。

## セキュリティと設定のヒント

- シークレットは `.dev.vars`（`.gitignore` 対象）に保持し、`wrangler.jsonc` と `.dev.vars` のバインディング名を一致させてください。
- Worker のバインディングや環境変数の型を変更した後は、`pnpm cf-typegen` を実行して自動生成される Cloudflare 型を更新してください。
