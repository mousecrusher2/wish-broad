import type { LoginPromptProps } from "./types";

export function LoginPrompt({ onLogin }: LoginPromptProps) {
  return (
    <div className="login-container">
      <h1>WISH WHEP Player</h1>
      <p>このアプリケーションを使用するにはログインが必要です。</p>
      <button onClick={onLogin} className="login-button">
        ログイン
      </button>
    </div>
  );
}
