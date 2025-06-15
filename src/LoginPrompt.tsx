export function LoginPrompt() {
  return (
    <div className="login-container">
      <h1>ANGOU BROADCAST</h1>
      <p>このアプリケーションを使用するにはログインが必要です。</p>
      <form method="POST" action="/login">
        <button type="submit" className="login-button">
          ログイン
        </button>
      </form>
    </div>
  );
}
