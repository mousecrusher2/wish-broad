# リポジトリガイドライン

## プロジェクト構成とモジュール配置

`src/` には React 19 + Vite のクライアントコードがあります。アプリの起動処理は `src/main.tsx` と `src/App.tsx` に配置されています。API フェッチ、SWR フック（`useBootstrapAuthState`、`useCurrentUser`、`useLiveStreams`、`useLiveToken`）、認証ブートストラップ状態は `src/api.ts` にあります。ページレベルのコンポーネント（`WHEPPlayerPage.tsx`、`WHEPPlayer.tsx`、`LoginPrompt.tsx`、`OBSStreamingInfo.tsx`）は `src/` 直下に、小さな UI 部品は `src/components/` に配置されています。WHEP 再生、再接続挙動、TURN 認証情報の取得、PeerConnection セッションロジックは `src/player/` にあります。

`worker/` には Cloudflare Worker と Hono のルートがあります。`worker/main.ts` は Worker のエントリーポイントで、Hono アプリ、`LiveState` Durable Object クラス、そして同オブジェクトが呼び出す `LiveEffects` エントリーポイントをエクスポートします。`cloudflare:workers` をインポートする唯一のモジュールであるため薄く保ってください。`worker/index.ts` はルート構成層です。ストレージスキーマと SQL は `worker/database.ts`、Durable Object の挙動（`LiveStateCore`: トランザクション、再接続猶予アラーム、通知削除アウトボックス）は `worker/live-state.ts`、Cloudflare Realtime SFU 連携は `worker/sfu.ts`、Discord OAuth ヘルパーは `worker/discord.ts` と `worker/discord-login.ts`、配信通知は `worker/notifications.ts`、Durable Object のために Worker が実行する再接続猶予期間と通知削除は `worker/live-end.ts`、TURN 認証情報の生成は `worker/turn.ts`、トークンハッシュ化・認証ヘルパーは既存の該当モジュールにそれぞれ保ってください。

静的アセットは `public/` に配置されています。Durable Object の SQLite スキーマは `worker/database.ts` の `SCHEMA_MIGRATIONS` です。オブジェクトは起動時にまだ適用していないエントリを順次適用するため、テーブル構造を変更する場合はデプロイ済みエントリを編集するのではなく、必ず末尾に新しいエントリを追加してください。`wrangler.jsonc` は Worker のバインディング、Durable Object クラスのマイグレーション、シークレット、アセット、オブザーバビリティ、デプロイ設定を定義します。自動生成された Cloudflare バインディング型は `worker-configuration.d.ts` にあり、アプリ向けの型エイリアスは `worker/types.ts` に置きます。

コードだけでは自明でないアーキテクチャやライフサイクルの設計判断は `docs/architecture.md` にまとめられています。インジェストや再生のライフサイクル、SFU との状態整合、通知、WHEP ネゴシエーションの挙動を変更した際は同ドキュメントも更新してください。

## ビルド・テスト・開発コマンド

クローン後に `pnpm install` を実行します。ローカル開発には `pnpm dev` を使用してください（Cloudflare Vite プラグインがクライアントと並行して `workerd` 上で Worker を起動します）。本番バンドルをローカルでビルドして確認するには `pnpm preview` を使用します。クライアントと Worker の型チェックおよびバンドルには `pnpm build`、Vitest スイートの実行には `pnpm test`、開発中の継続テストには `pnpm test:watch` を実行してください。

PR を開く前に必ず `pnpm check` を実行してください。これは TypeScript、oxlint、および Knip による `pnpm check:unused-exports` を実行します。`src/` 向けの JS プラグインとして oxlint が `eslint-plugin-better-tailwindcss` を読み込んでおり、このリポジトリでは ESLint 自体は実行しません。リポジトリ全体のフォーマット適用には `pnpm format`、フォーマット検証には `pnpm format:check` を使用します。`pnpm deploy` は Worker と静的アセットをビルドして Cloudflare へ公開します。

`.cmd` や `.ps1` シムを含め、`node_modules/` 配下の実行ファイルを直接呼び出さないでください。パッケージスクリプトには常に `pnpm run <script>`、パッケージバイナリには `pnpm exec <binary>` を使用してください。この環境では `pnpm exec ...` がサンドボックス下で失敗する場合がありますが、直接 `node_modules` の実行ファイルへフォールバックせず昇格権限で再実行してください。

## コーディングスタイルと命名規則

このリポジトリでは strict なコンパイラ設定の TypeScript ES モジュールと、`prettier-plugin-tailwindcss` を有効にした Prettier（それ以外はデフォルト設定: インデント幅 2、セミコロンあり、ダブルクォート）を使用しています。既存の命名規則に従ってください: React コンポーネントは PascalCase（`WHEPPlayer.tsx`）、ユーティリティは camelCase、フックは `useX`（`src/api.ts` の `useLiveStreams` など）。保護されたフロントエンドリクエストはオリジン相対にしてください（例: `fetch("/api/me", { credentials: "include" })`）。

信頼できない JSON 境界のバリデーションには Valibot を使用してください。失敗は例外をスローして報告します。各外部 API ラッパーは `kind` を持つ独自の `Error` サブクラス（`SfuApiError`、`DiscordApiError`、`TurnApiError`、`DiscordWebhookError`、クライアント側では `WHEPSessionError`）をスローし、呼び出し元が分岐処理するその他の失敗にも名前付きサブクラス（`LiveNotFoundError`、`UnauthorizedError`）を用意します。関数が意図的にスローするエラーは JSDoc の `@throws` に明記してください。失敗に応じて分岐する呼び出し元は、その特定の呼び出しだけを `try`/`catch` で囲み、`instanceof` でエラーを確認し、自身が処理しないものは再スローしてください。ベストエフォート処理（通知、トラックのクリーンアップ、トークン失効、`waitUntil` や `finally` 内の処理など）は、呼び出し箇所でキャッチしてログ出力し、失敗によってメインレスポンスが置き換わらないようにしてください。`src/api.ts` の SWR レイヤーは例外であり、新しいリクエストやローカルの `mutate` で置き換えられた後でも SWR が reject されたリクエストを反映してしまうのを防ぐため、フェッチャーはすべての失敗をキャッチして `{ status: "error" }` データとしてキャッシュします。新しい SQL アクセスはルートハンドラに散在させず `worker/database.ts` にまとめ、ルートからは `getLiveState(env)` の RPC メソッド経由で参照してください。SFU、Discord、TURN、通知、トークン認証の関心事は既存の Worker モジュールごとに分離したまま保ってください。

`LiveState` Durable Object は待機中の時間に対しても課金されるため、Realtime SFU や Discord その他の外部 API を呼び出してはならず、自身のストレージおよびアラーム呼び出し以外のものを await してはなりません。各メソッドは SQL とアラーム呼び出しを含む 1 回の `ctx.storage.transaction()` に収め、失敗時は `rollback()` でロールバックしてください。`transactionSync()` は同期操作しかカバーしないため、その中で行ったアラーム呼び出しはトランザクションに含まれません。外部呼び出しは Worker 側で、オブジェクトの 2 つの呼び出しの間に行ってください。オブジェクト自身が外部処理を開始する必要がある場合は `LiveEffects` に引き渡してください。`LiveEffects` のメソッドは即座に返却し、実際の処理を `waitUntil` 内で実行します。

## テストガイドライン

ほとんどの Worker モジュール（ルート、Durable Object の SQL と挙動、SFU、Discord OAuth、通知、Durable Object のために実行される通知削除、TURN 認証情報、ライブトークンおよび Bearer 認証ヘルパー、JWT ヘルパー、ロギング）およびフロントエンドの API レイヤーと WHEP プレイヤー（`WHEPClient`、`WHEPPlaybackController`、再接続ポリシー、TURN パース）の隣に Vitest テストが配置されています。テストは対象機能の近くに `*.test.ts` または `*.test.tsx` として追加してください。`worker/database.ts` と `worker/live-state.ts` のテストは `worker/test-doubles.ts` を通じて Node の `node:sqlite` 上で実際の SQL を実行します。`worker/main.ts` のクラスは `cloudflare:workers` ランタイムモジュールを必要とするため Vitest には読み込まれません。プロトコルの境界条件、スキーマ検証、リトライ／再接続タイミング、Worker のレスポンスステータスやヘッダーの挙動に焦点を当てたテストを記述してください。

コード変更時の最低限の自動検証として `pnpm test` と `pnpm check` を扱ってください。Worker や WebRTC に変更を加えた場合は、影響するフローをローカルでも手動検証してください: `/api/me`、`/api/lives`、ライブトークン作成、`/ingest/:userId` 経由の WHIP 配信、`/play/:userId` 経由の WHEP 再生、TURN 認証情報の取得、および関連する場合は配信開始通知のクリーンアップ（60 秒の猶予期間内での OBS 再接続で 2 通目の通知が出ないこと、猶予期間後の停止で配信が終了することを含む）。

## コミットとプルリクエストのガイドライン

最近の履歴では `fix:` や `feat:` のような Conventional Commits 形式のプレフィックスを使用しています。このパターンを維持し、各コミットが単一の論理的変更になるようにしてください。PR には短いスコープ概要、ストレージスキーマ（`SCHEMA_MIGRATIONS`）・`wrangler.jsonc`・自動生成された Cloudflare 型への更新有無、関連 Issue へのリンク、UI 変更がある場合はスクリーンショットを含めてください。実行した自動検証および手動検証の手順も記載してください。

## セキュリティと設定のヒント

シークレットは `.dev.vars`（gitignore 対象）に保持し、`wrangler.jsonc` と `.dev.vars` のバインディング名を一致させてください。`worker/types.ts` は自動生成されたバインディング型のエイリアスのみを定義します。本番環境で必要なシークレットには、Discord OAuth／ギルド設定値、Cloudflare Realtime SFU アプリ認証情報、JWT およびライブトークン用ペッパー値、通知 Webhook URL、TURN キー認証情報が含まれます。

`LOG_LEVEL` は構造化アプリケーションログ用の非シークレット Worker 変数です。`debug`、`info`、`warn`、`error`、`silent` のいずれかを使用してください。

ライブインジェストトークンは作成時にのみ表示され、HMAC ハッシュとして保存され、`/ingest/:userId/*` 上の Bearer 認証で検証されます。生のトークンをログに出力しないでください。Worker のバインディングや環境変数の型を変更した後は、`pnpm cf-typegen` を実行して自動生成される Cloudflare 型を更新してください。
