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

## 必要な環境

- Node.js
- OAuth 用の Discord アプリケーション
- 視聴を許可するメンバーの判定に使う Discord サーバー（ギルド）
- 配信通知用の Discord Webhook

## セットアップ

依存関係をインストールします。

```sh
pnpm install
```

ローカル開発用の Worker シークレットを `.dev.vars` に設定します。

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

デプロイ前に、あらかじめ Cloudflare 側へ本番用のシークレットを登録しておく必要があります。
