# wish-broad

Discord OAuthで視聴者を制限する、Cloudflare Workers + Cloudflare Realtime SFU向けの配信アプリです。

OBSはWHIPで配信し、認証済みユーザーはブラウザからアプリ専用の視聴フローで再生します。視聴側のSDP交換やセッション管理はWHEPを参考にしていますが、公開WHEPエンドポイント互換を目的にした実装ではありません。

## 機能

- Discord サーバー（ギルド）メンバーシップに基づくログイン認証
- ユーザーごとの OBS インジェスト URL と Bearer ライブトークン
- OBS 向け WHIP インジェストエンドポイント
- WHEP に着想を得た認証付き再生フロー
- Cloudflare Realtime SFU セッション管理
- Durable Object をバックエンドとした配信状態・トークン状態の管理
- 認証付き TURN 認証情報エンドポイント
- ベストエフォートの Discord 配信開始通知（インジェスト URL に `?notify=false` を付けることで配信ごとにスキップ可能）
- OBS が再接続しても 60 秒間は配信が維持されて再通知せず、視聴者は配信の復帰を待機し続けます

## 技術スタック

- React 19（React Compiler 有効）
- Vite（Cloudflare Vite プラグイン使用）
- Tailwind CSS v4
- Hono
- Cloudflare Workers
- Cloudflare Durable Objects（SQLite ストレージおよびアラーム）
- Cloudflare Realtime SFU / TURN（旧称 Calls）
- SWR
- Valibot
- Vitest
- oxlint、Knip、Prettier

## 必要な環境

- Node.js および pnpm
- Workers、Durable Objects、Realtime SFU、Realtime TURN が利用可能な Cloudflare アカウント
- OAuth 用の Discord アプリケーション
- 視聴者許可リストとして使用する Discord サーバー（ギルド）
- 配信通知用の Discord Webhook

## セットアップ

依存関係をインストールします:

```sh
pnpm install
```

ローカル開発用の Worker 変数を `.dev.vars` に作成します（このファイルはコミットしないでください）。

必要なシークレット:

```text
AUTHORIZED_GUILD_ID
CALLS_APP_ID
CALLS_APP_SECRET
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
JWT_SECRET
LIVE_TOKEN_PEPPER
NOTIFICATIONS_DISCORD_WEBHOOK_URL
TURN_KEY_API_TOKEN
TURN_KEY_ID
```

非シークレットのランタイム変数は `wrangler.jsonc` で設定します。`wrangler.jsonc` と `.dev.vars` のバインディング名を一致させ、バインディングを変更した後は `pnpm cf-typegen` を実行して `worker-configuration.d.ts` を再生成してください。

## 開発

開発サーバーを起動します:

```sh
pnpm dev
```

Cloudflare Vite プラグインによりクライアントの隣でローカルの `workerd` ランタイム上で Worker が実行されるため、開発中も API、インジェスト、再生の各ルートが同一オリジンから配信されます。

本番バンドルをローカルでビルドして提供します:

```sh
pnpm preview
```

本番バンドルに依存する動作を検証する場合は `pnpm preview` を使用してください。

## 検証

標準のチェックを実行します:

```sh
pnpm check
pnpm test
pnpm run format:check
pnpm build
```

## デプロイ

Wrangler でビルドおよびデプロイします:

```sh
pnpm deploy
```

デプロイ前に Cloudflare 側へ本番シークレットを設定しておく必要があります。`LIVE_STATE` Durable Object バインディングとそのストレージは `wrangler.jsonc` に基づいて `wrangler deploy` が作成し、オブジェクトは起動時に自身のテーブルを作成するため、手動でデータベースを作成・マイグレーションする必要はありません。

まだ D1 に状態を保持しているバージョンからこのバージョンへ上書きデプロイすると、その状態は破棄されます。Durable Object は空の状態で開始され、D1 の行はインポートされません。実行する前に [D1からの切り替え](docs/architecture.md#d1からの切り替え) を確認してください。切り替え後、配信者は新しいライブトークンを再発行する必要があります。

## アーキテクチャメモ

Worker は意図的にステートレスに設計されています。永続化が必要な状態は単一の Durable Object（`LiveState`）の SQLite ストレージに保存され、メディアセッションの状態は Cloudflare Realtime SFU が管理します。Durable Object は待機時間に対しても課金されるため、自身のストレージに対する短いトランザクションのみを実行し、Realtime SFU や Discord その他の外部 API は一切呼び出しません。また、すべてのライブセッションをポーリングしたり、長寿命のインメモリ状態を保持したりする設計も避けています。唯一の定期実行タスクはオブジェクトのアラームであり、60 秒間の OBS 再接続猶予期間が経過した配信を終了し、Discord 通知の削除処理を Worker へ引き渡します。アラームは OBS の再接続待ち中または削除待ちの通知がある間のみ設定されます。

視聴機能は意図的に認証付きかつアプリ固有の仕様としています。TURN サーバーの探索は汎用的な WHEP の `OPTIONS`/`Link` ではなく `/api/turn-credentials` を通じて提供されます。現在の SFU 経路は実質的にノン・トリクル（non-trickle）であるため、再生クライアントは POST/PATCH を送信する前にローカルの ICE 収集完了を待機します。

詳細は [docs/architecture.md](docs/architecture.md) に記載しています。

## セキュリティ上の注意

- 生の OBS Bearer トークン、JWT、Cookie、Discord OAuth コード、Cloudflare シークレットをログに出力しないでください。
- ライブトークンは発行時にのみ画面に表示され、`LIVE_TOKEN_PEPPER` を用いた HMAC ハッシュとして保存されます。
- 視聴者認証では、Discord サーバー（ギルド）への所属確認後にアプリが発行する JWT Cookie を使用します。
- 本アプリは限定された視聴用途向けに設計されており、公開 WHEP 互換エンドポイントとして公開することを目的としていません。
