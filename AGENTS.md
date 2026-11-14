# リポジトリガイドライン

## プロジェクト構成とモジュール配置

### クライアント（`src/`）

`src/` には React 19 + Vite のクライアントコードを配置しています。

- `src/main.tsx`、`src/App.tsx`: アプリケーションの起動処理
- `src/api.ts`: API リクエスト、SWR フック（`useBootstrapAuthState`、`useCurrentUser`、`useLiveStreams`、`useLiveToken`）、認証のブートストラップ状態管理
- `src/` 直下のページレベルコンポーネント: `WHEPPlayerPage.tsx`、`WHEPPlayer.tsx`、`LoginPrompt.tsx`、`OBSStreamingInfo.tsx`
- `src/components/`: 小さな UI 部品
- `src/player/`: WHEP 再生、再接続処理、TURN 認証情報の取得、PeerConnection のセッション管理

### Worker（`worker/`）

`worker/` には Cloudflare Worker と Hono のルートを配置しています。各モジュールの責務を分離したまま保ってください。

- `worker/main.ts`: Worker のエントリーポイント。Hono アプリ、`LiveState` Durable Object クラス、および `LiveState` から呼び出される `LiveEffects` エントリーポイントを再エクスポートするだけの薄いモジュールです。ここに実装ロジックを書かないでください。
- `worker/index.ts`: ルート構成層
- `worker/database.ts`: ストレージスキーマと SQL
- `worker/live-state.ts`: Durable Object の挙動（`LiveState`: トランザクション、再接続猶予アラーム、通知削除アウトボックス）
- `worker/sfu.ts`: Cloudflare Realtime SFU 連携
- `worker/discord.ts`、`worker/discord-login.ts`: Discord OAuth ヘルパー
- `worker/notifications.ts`: 配信通知
- `worker/live-end.ts`: Durable Object からの依頼で Worker が実行する再接続猶予期間と通知削除処理（`LiveEffects`）
- `worker/turn.ts`: TURN 認証情報の生成
- トークンハッシュ化や認証のヘルパーも、既存のモジュールごとに分離したまま保ってください。

### 静的アセット・設定・設計ドキュメント

- `public/`: 静的アセットを配置します。
- Durable Object の SQLite スキーマは `worker/database.ts` の `SCHEMA_MIGRATIONS` で定義します。`LiveState` は起動時に未適用のエントリを順次適用するため、テーブル構造を変更する場合は既存の適用済みエントリを編集せず、必ず末尾に新しいエントリを追加してください。
- `wrangler.jsonc`: Worker のバインディング、Durable Object クラスのマイグレーション、シークレット、アセット、オブザーバビリティ、デプロイ設定を定義します。自動生成された Cloudflare バインディング型は `worker-configuration.d.ts` にあり、アプリ向けの型エイリアスは `worker/types.ts` に置きます。
- `docs/architecture.md`: 複数のモジュールにまたがるアーキテクチャやライフサイクルの設計判断をまとめています（コードコメントとの書き分けは「コーディングスタイルと命名規則」を参照）。インジェストや再生のライフサイクル、SFU との状態整合、通知、WHEP ネゴシエーションの挙動を変更した際は、同ドキュメントも更新してください。

## ビルド・テスト・開発コマンド

クローン後に `pnpm install` を実行します。

- `pnpm dev`: ローカル開発サーバーを起動します（Cloudflare Vite プラグインがクライアントと並行して `workerd` 上で Worker を起動します）。
- `pnpm preview`: 本番バンドルをローカルでビルドし、動作確認用に起動します。
- `pnpm build`: クライアントと Worker の型チェックおよびバンドルを実行します。
- `pnpm test` / `pnpm test:watch`: Vitest テストスイートを実行します（`test:watch` は開発中のウォッチ実行）。
- `pnpm check`: PR を開く前に必ず実行してください。TypeScript の型チェック、oxlint、および Knip による未使用エクスポート検査（`pnpm check:unused-exports`）を一括実行します。なお、`src/` 向けに oxlint が JS プラグインとして `eslint-plugin-better-tailwindcss` を読み込んでおり、このリポジトリでは ESLint 自体は実行しません。
- `pnpm format` / `pnpm format:check`: リポジトリ全体の Prettier フォーマット適用および検証を行います。
- `pnpm deploy`: Worker と静的アセットをビルドして Cloudflare へ公開します。

`.cmd` や `.ps1` のシムを含め、`node_modules/` 配下の実行ファイルを直接呼び出さないでください。package.json のスクリプトには常に `pnpm run <script>`、パッケージのバイナリには `pnpm exec <binary>` を使用してください。この環境ではサンドボックス制限により `pnpm exec ...` が失敗する場合がありますが、`node_modules/` 直下の実行ファイルへフォールバックせず、昇格権限（サンドボックス外）で再実行してください。

## コーディングスタイルと命名規則

### 基本規約

- strict なコンパイラ設定の TypeScript ES モジュールと、`prettier-plugin-tailwindcss` を有効にした Prettier（それ以外はデフォルト設定: インデント幅 2、セミコロンあり、ダブルクォート）を使用します。
- 既存の命名規則に従ってください: React コンポーネントは PascalCase（例: `WHEPPlayer.tsx`）、ユーティリティは camelCase、フックは `useX`（例: `src/api.ts` の `useLiveStreams`）。
- フロントエンドから保護されたエンドポイントへリクエストする際は、同一オリジンの相対パスを使用してください（例: `fetch("/api/me", { credentials: "include" })`）。

### コメントと `docs/architecture.md` の書き分け

理由は 1 か所にだけ書き、コードとドキュメントで重複させないでください。

- `docs/architecture.md`: 複数のモジュールにまたがる設計判断、ライフサイクルと状態遷移、トレードオフ、採用しなかった代替案、運用手順を記載します。
- コードコメント: その箇所だけで完結する制約・不変条件・外部 API の仕様や癖など、知らないと誤って「直して」しまいそうな点を 1〜3 行で書きます。`docs/architecture.md` に書いた設計に従っている箇所では、何をしているかを 1 行で記したうえでドキュメントの節名を参照してください（例: `docs/architecture.md「通知」`）。
- 宣言と行コメントの使い分け: 宣言（関数・クラス・メソッド・型とそのフィールド・定数）の説明には `/** */` の JSDoc を使い、関数本体の中の注記や複数の宣言にまたがる注記には `//` を使います。JSDoc には「何をするか」「`null` や `false` など特別な戻り値の意味」「`@throws`」だけを書き、名前や型から明らかな宣言には付けないでください。
- 不要なコメントの禁止: コードの言い換え、テスト名の繰り返し、変更履歴はコメントに書きません。テストコードのコメントは、テスト名だけでは分からない前提条件（再現している競合状態など）を補足する場合に限ります。

### バリデーション・エラー処理・責務分離

- 信頼できない JSON 境界のバリデーションには Valibot を使用し、失敗時は例外をスローして報告します。
- 名前付きの `Error` サブクラスは、呼び出し元がその失敗から回復する場合、または実行時にその種別で分岐する場合にのみ作成します（同じクラス内で複数パターンを区別するときは `kind` プロパティを使います）。各外部 API ラッパーの独自サブクラス（`SfuApiError`、`DiscordApiError`、`TurnApiError`、`DiscordWebhookError`、クライアント側の `WHEPSessionError`）と、`LiveNotFoundError`、`UnauthorizedError` がこれに当たります。保存データの不整合や呼び出し側の誤りなど、どちらにも該当しない失敗には素の `Error` をそのまま使ってください。
- 関数が意図的にスローするエラーは JSDoc の `@throws` に明記してください。失敗の種類に応じて分岐する呼び出し元は、対象の呼び出しだけを `try`/`catch` で囲み、`instanceof` でエラーを確認したうえで、自身が処理しない例外は再スローしてください。
- ベストエフォート処理（通知、トラックのクリーンアップ、トークン失効、`waitUntil` や `finally` 内の処理など）は呼び出し箇所でキャッチしてログ出力し、その失敗でメインレスポンスが置き換わらないようにしてください。
- 例外として `src/api.ts` の SWR レイヤーでは、より新しいリクエストやローカルの `mutate` で置き換えられた後でも SWR が reject されたリクエストを反映してしまうのを防ぐため、フェッチャーがすべての失敗をキャッチして `{ status: "error" }` データとしてキャッシュします。
- 新しい SQL アクセスはルートハンドラに散在させず `worker/database.ts` にまとめ、ルートからは `getLiveState(env)` の RPC メソッド経由で参照してください。SFU、Discord、TURN、通知、トークン認証の関心事は既存の Worker モジュールごとに分離したまま保ってください。

### `LiveState` Durable Object の制約

- `LiveState` Durable Object は外部応答の待機時間に対しても課金されるため、Realtime SFU や Discord その他の外部 API を呼び出してはならず、自身のストレージおよびアラーム呼び出し以外のものを `await` してはなりません。
- 各メソッドは SQL 操作とアラーム呼び出しをまとめて 1 回の `ctx.storage.transaction()` に収め、失敗時は `rollback()` でロールバックしてください（`transactionSync()` は同期操作しか対象にできないため、その中で行ったアラーム呼び出しはトランザクションに含まれません）。
- 外部 API 呼び出しは Worker 側で、`LiveState` への 2 回の呼び出しの合間に行ってください。`LiveState` 自身が外部処理を開始する必要がある場合は `LiveEffects` へ引き渡してください。`LiveEffects` のメソッドは即座に制御を返し、実際の処理を `waitUntil` 内で実行します。

## テストガイドライン

### テストの配置と実行環境

- ほとんどの Worker モジュール（ルート、Durable Object の SQL と挙動、SFU、Discord OAuth、通知、Durable Object からの依頼で実行される通知削除、TURN 認証情報、ライブトークンおよび Bearer 認証ヘルパー、JWT ヘルパー、ロギング）およびフロントエンドの API レイヤーと WHEP プレイヤー（`WHEPClient`、`WHEPPlaybackController`、再接続ポリシー、TURN パース）の近くに Vitest テストを配置しています。新規テストも対象機能の近くに `*.test.ts` または `*.test.tsx` として追加してください。
- `worker/` のテストは `@cloudflare/vitest-plugin` により `wrangler.jsonc` の設定で `workerd` 上で実行され、`src/` のテストは Node 上で実行されます（`vitest.config.ts` の `worker` / `client` プロジェクト）。

### Worker テストの書き方と注意点

- `worker/` のテストは `cloudflare:workers` の `env` を通じて、SQLite ストレージとアラームを備えた実際の `LiveState` と `LiveEffects` を使用します。`LiveState` をモジュールモックや自作のフェイクで置き換えないでください。
- 状態は公開 RPC メソッドで準備し、結果は RPC の戻り値、または `cloudflare:test` の `runInDurableObject` でストレージを読んで検証します。障害は `vi.spyOn(LiveState.prototype, ...)` や Durable Object の `state.storage` へのスパイで注入し、アラームは `runDurableObjectAlarm` で明示的に発火させてください。
- 実際のアラームが自動発火しないようテストの時計は `vi.setSystemTime` で遠い未来に置き（Durable Object も同じ時計を参照します）、グローバルな `LiveState` を使うテストは `afterEach` で `reset()` を呼んでストレージを消去してください。
- 外部 HTTP API（Realtime SFU、Discord、TURN）は、各ラッパーモジュールのテストでは `fetch` をスパイし、ルートのテストではラッパーモジュールを境界でモックします。
- Durable Object スタブの RPC 呼び出しが返す Promise は関数としても呼び出せるため、`expect(...).rejects` に渡す前に通常の `Promise` で包んでください。
- テストランナーの `console` はアクセスするたびに別の関数を返すため、検証時は `vi.spyOn(console, ...)` の戻り値を使って確認してください。
- テスト内の前提確認や型の絞り込みには `throw new Error(...)` ではなく、Vitest の `assert`（`assert.isDefined`、`assert.instanceOf` など）を使用してください。
- プロトコルの境界条件、スキーマ検証、リトライ／再接続タイミング、Worker のレスポンスステータスやヘッダーの挙動に焦点を当てたテストを記述してください。

### 最低限の検証と手動チェック

コード変更時の最低限の自動検証として `pnpm test` と `pnpm check` を実行してください。Worker や WebRTC に変更を加えた場合は、影響するフローをローカルでも手動検証してください。

- `/api/me`、`/api/lives`
- ライブトークン作成
- `/ingest/:userId` 経由の WHIP 配信
- `/play/:userId` 経由の WHEP 再生
- TURN 認証情報の取得
- 配信開始通知のクリーンアップ（関係する変更の場合: 60 秒の猶予期間内に OBS を再接続した際に 2 通目の通知が出ないこと、猶予期間後の停止で配信が終了し通知が削除されること）

## コミットとプルリクエストのガイドライン

- 最近の履歴では `fix:` や `feat:` のような Conventional Commits 形式のプレフィックスを使用しています。このパターンを維持し、各コミットが単一の論理的変更になるようにしてください。
- PR には、短いスコープ概要、ストレージスキーマ（`SCHEMA_MIGRATIONS`）・`wrangler.jsonc`・自動生成された Cloudflare 型への更新有無、関連 Issue へのリンク、UI 変更がある場合はスクリーンショットを含めてください。実行した自動検証および手動検証の手順も記載してください。

## セキュリティと設定のヒント

- シークレットは `.dev.vars`（`.gitignore` 対象）に保持し、`wrangler.jsonc` と `.dev.vars` のバインディング名を一致させてください。`worker/types.ts` は自動生成されたバインディング型のエイリアスのみを定義します。本番環境で必要なシークレットには、Discord OAuth／ギルド設定値、Cloudflare Realtime SFU アプリ認証情報、JWT およびライブトークン用ペッパー値、通知 Webhook URL、TURN キー認証情報が含まれます。
- `LOG_LEVEL` は構造化アプリケーションログ用の非シークレット Worker 変数です。`debug`、`info`、`warn`、`error`、`silent` のいずれかを指定してください。
- ライブインジェストトークンは発行時にのみ画面に表示され、HMAC ハッシュとして保存されたうえで、`/ingest/:userId/*` へのリクエスト時に Bearer 認証で検証されます。生のトークンをログに出力しないでください。
- Worker のバインディングや環境変数の型を変更した後は、`pnpm cf-typegen` を実行して自動生成される Cloudflare 型を更新してください。
