# リポジトリガイドライン

## プロジェクト構成とモジュール配置

### クライアント（`src/`）

`src/` には React 19 + Vite のクライアントコードを配置しています。

- `src/main.tsx`、`src/App.tsx`: アプリケーションの起動処理
- `src/api/`: Worker API の呼び出し（`client.ts`: リクエストとレスポンスの検証、`hooks.ts`: SWR によるプリロードとキャッシュ、React フック）
- `src/pages/`: ページレベルコンポーネント
- `src/features/`: 機能ごとの UI（`player/`: 再生画面と再生状態の表示文言、`obs-settings/`: OBS 配信設定）
- `src/components/`: 機能に依存しない小さな UI 部品
- `src/player/`: React に依存しない WHEP 再生処理
  - `controller.ts`: 再接続とリカバリーを含む再生全体の制御
  - `session.ts`: 1 回分の PeerConnection のセッション管理
  - `signaling.ts`: Worker の `/play` との POST・PATCH・DELETE と応答の解析
  - `stall-monitor.ts`: `bytesReceived` による再生停止の判定
  - `reconnect-policy.ts`: 再接続の時間と、失敗の分類
  - `playback-state.ts`: 画面に渡す再生状態の型
  - `turn-credentials.ts`: TURN 認証情報の取得

### Worker（`worker/`）

`worker/` には Cloudflare Worker を配置しています。

- `worker/main.ts`: Worker のエントリーポイント。Hono アプリ、`LiveState` Durable Object クラス、および `LiveState` から呼び出される `LiveEffects` エントリーポイントを再エクスポートするだけの薄いモジュールです。ここに実装ロジックを書かないでください。
- `worker/app.ts`: 各ルートのマウントと、未処理エラーの応答だけを行う構成層
- `worker/routes/`: パスごとのルート（`auth.ts`、`api.ts`、`ingest.ts`、`play.ts`）。リクエストの検証と、`worker/live/` の結果から HTTP 応答への変換だけを行います。`create-app.ts` はサブアプリの生成、`sdp.ts` は SDP 本文の読み取りです。
- `worker/middleware/`: Hono ミドルウェア（`app-jwt.ts`: 視聴者の JWT Cookie 認証、`hashed-bearer-auth.ts`: OBS の Bearer トークン認証）
- `worker/live/`: 配信のライフサイクルで Worker が行う処理。HTTP に依存せず、判別共用体の結果を返します。
  - `worker/live/ingest.ts`、`worker/live/playback.ts`: インジェストと再生の開始・終了
  - `worker/live/session.ts`: 配信行が保持するインジェストセッションの生死の判定と、`DELETE` なしで失われたセッションの扱い
  - `worker/live/notifications.ts`: 開始通知の送信と削除
  - `worker/live/tracks.ts`: SFU のトラックを `waitUntil` 内で閉じる処理
  - `worker/live/effects.ts`: Durable Object からの依頼で Worker が実行する処理（`LiveEffects`）
  - `worker/live/types.ts`: Worker と `LiveState` の間で受け渡す型
- `worker/state/`: `LiveState` Durable Object（`live-state.ts`: トランザクション、再接続猶予アラーム、開始通知の削除の引き渡し）と、そのストレージ用 SQL（`database.ts`）
- `worker/clients/`: 外部 API（Realtime SFU、TURN、Discord OAuth、Discord Webhook）のクライアント。配信のライフサイクルを知らず、API が必要とする値だけを受け取ります。
- `worker/lib/`: ログ出力やトークン処理などのユーティリティ
- `worker/testing/`: Worker テストの共有ヘルパー（Worker のビルドには含めません）

### 層の依存方向

`.oxlintrc.json` の `no-restricted-imports` で次の依存方向を強制しています（テストファイルは対象外）。

- `worker/state/` は `worker/live/types.ts` を除く `worker/live/`、`worker/clients/`、`worker/routes/`、`worker/middleware/`、Hono に依存しない
- `worker/clients/` は `worker/live/`、`worker/state/`、`worker/routes/`、`worker/middleware/`、Hono に依存しない
- `worker/live/` は `worker/routes/`、`worker/middleware/`、Hono に依存しない
- `worker/lib/` と `shared/` は他の層に依存しない
- `src/player/` は React、SWR、`src/api/`、`src/components/`、`src/features/`、`src/pages/` に依存しない

### Worker とクライアントの取り決め（`shared/`）

- `shared/protocol.ts`: Worker とクライアントの両方が従う API 応答の型、ヘッダー名、時間の値。両方のビルドに含まれるため、型と定数だけを置いてください。

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
