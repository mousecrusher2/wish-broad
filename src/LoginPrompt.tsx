export function LoginPrompt() {
  return (
    <div className="login-container">
      <h1>ANGOU BROADCAST</h1>
      <p>このアプリケーションを使用するにはログインが必要です。</p>
      <a href="/login" className="login-button">
        Discordでログイン
      </a>
    </div>
  );
}
