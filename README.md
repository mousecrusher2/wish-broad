# wish-broad

Discord OAuth で視聴者を制限する、Cloudflare Workers + Cloudflare Realtime SFU 向けのライブ配信アプリです。

OBS から WHIP で配信し、認証済みユーザーはアプリ独自の再生フローを使ってブラウザ上で視聴します。視聴側の SDP 交換やセッション管理は WHEP を参考にしていますが、公開用の汎用 WHEP エンドポイントとの互換性を目的とした実装ではありません。

## 機能

- 指定した Discord サーバー（ギルド）への参加状況に基づくログイン認証
- ユーザーごとの OBS 用インジェスト URL と Bearer 形式のライブトークン
- OBS 向けの WHIP インジェストエンドポイント
- WHEP を参考にした認証付きの再生フロー
- Cloudflare Realtime SFU によるメディアセッション管理
- Durable Object を用いた配信状態とライブトークンの管理
- ログインユーザー向けの TURN 認証情報エンドポイント
- Discord への配信開始通知（ベストエフォートで送信。インジェスト URL に `?notify=false` を付けると配信ごとにスキップ可能）
- OBS の再接続を 60 秒間猶予する仕組み（猶予期間内の再接続では再通知せず、視聴者は配信の復帰をそのまま待機）

## 技術スタック

- React 19（React Compiler 有効）
- Vite（Cloudflare Vite プラグイン使用）
- Tailwind CSS v4
- Hono
- Cloudflare Workers
- Cloudflare Durable Objects（SQLite ストレージとアラーム機能）
- Cloudflare Realtime SFU / TURN（旧称 Calls）
- SWR
- Valibot
- Vitest
- oxlint、Knip、Prettier

## 必要な環境

- Node.js および pnpm
- Workers、Durable Objects、Realtime SFU、Realtime TURN が利用可能な Cloudflare アカウント
- OAuth 用の Discord アプリケーション
- 視聴を許可するメンバーの判定に使う Discord サーバー（ギルド）
- 配信通知用の Discord Webhook

## セットアップ

依存関係をインストールします。

```sh
pnpm install
```

ローカル開発用の Worker シークレットを `.dev.vars` に設定します（このファイルは Git にコミットしないでください）。

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

シークレット以外のランタイム変数は `wrangler.jsonc` で設定します。`wrangler.jsonc` と `.dev.vars` のバインディング名は一致させてください。バインディングを変更した後は、`pnpm cf-typegen` を実行して `worker-configuration.d.ts` を再生成する必要があります。

## 開発

開発サーバーを起動します。

```sh
pnpm dev
```

Cloudflare Vite プラグインにより、クライアントと並行してローカルの `workerd` ランタイム上で Worker が起動するため、開発中も API・インジェスト・再生の各ルートが同一オリジンで動作します。

ローカル環境で本番バンドルをビルドして起動します。

```sh
pnpm preview
```

本番ビルド特有の挙動を確認したい場合は `pnpm preview` を使用してください。

## 検証

以下のコマンドで標準の検証を実行します。

```sh
pnpm check
pnpm test
pnpm run format:check
pnpm build
```

## デプロイ

Wrangler でビルドおよびデプロイを行います。

```sh
pnpm deploy
```

デプロイ前に、あらかじめ Cloudflare 側へ本番用のシークレットを登録しておく必要があります。`LIVE_STATE` Durable Object のバインディングとストレージは `wrangler.jsonc` の設定に従って `wrangler deploy` が作成し、テーブルの作成とマイグレーションも起動時に `LiveState` 自身が自動で行うため、手動でデータベースを作成したりマイグレーションを実行したりする必要はありません。

なお、まだ D1 に状態を保存している旧バージョンから本バージョンへ上書きデプロイすると、既存のデータは破棄されます（Durable Object は空の状態から開始し、D1 のデータは移行されません）。実行前に [D1からの切り替え](docs/architecture.md#d1からの切り替え) を確認してください。切り替え後、配信者は新しいライブトークンを再発行する必要があります。

## アーキテクチャメモ

Worker 自体は意図的にステートレスな設計にしています。永続化が必要な状態は単一の Durable Object（`LiveState`）の SQLite ストレージに集約し、実際のメディアセッションは Cloudflare Realtime SFU が管理します。Durable Object は外部処理の応答を待っている時間に対しても課金されるため、`LiveState` 内では自身のストレージに対する短いトランザクションのみを実行し、Realtime SFU や Discord などの外部 API は一切呼び出しません。また、アクティブな全セッションの定期ポーリングや、長寿命のインメモリ状態の保持も行いません。

スケジュール実行されるのは `LiveState` のアラームだけで、60 秒間の OBS 再接続猶予期間が切れた配信の終了処理や、Discord 通知の削除ジョブの Worker への引き渡しを行います。このアラームは、OBS の再接続待ちまたは削除待ちの通知が存在する間だけ設定されます。

視聴機能はあえて認証必須・アプリ固有の仕様としています。TURN サーバーの情報は汎用 WHEP の `OPTIONS`/`Link` ではなく `/api/turn-credentials` から取得します。また、現在の SFU 経路は実質的にノン・トリクル（non-trickle）であるため、再生クライアントは `POST`/`PATCH` を送信する前にローカルの ICE 収集が完了するまで待機します。

詳細は [docs/architecture.md](docs/architecture.md) を参照してください。

## セキュリティ上の注意

- 生の OBS Bearer トークン、JWT、Cookie、Discord OAuth 認可コード、Cloudflare シークレットをログに出力しないでください。
- ライブトークンは発行時にのみ画面に表示され、`LIVE_TOKEN_PEPPER` を用いた HMAC ハッシュとして保存されます。
- 視聴者認証には、Discord サーバー（ギルド）への所属確認後にアプリが発行する JWT Cookie を使用します。
- 本アプリは限定されたメンバー間での視聴を想定しており、公開 WHEP 互換エンドポイントとして提供することを目的としていません。
