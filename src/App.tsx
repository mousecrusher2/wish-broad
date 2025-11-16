import { Suspense } from "react";
import { checkAuth, useAuthFromPromise } from "./useAuth";
import { LoginPrompt } from "./LoginPrompt";
import { WHEPPlayer } from "./WHEPPlayer";

// React の外側で一度だけ作る認証チェック Promise
const authPromise = checkAuth();

function AppContent() {
  const auth = useAuthFromPromise(authPromise);

  if (auth.status === "authenticated") {
    return <WHEPPlayer user={auth.user} />;
  }

  if (auth.status === "error") {
    return (
      <div className="loading-container">
        <h1>ANGOU BROADCAST</h1>
        <p>認証状態の確認中にエラーが発生しました。</p>
        <p>ページを再読み込みしてもう一度お試しください。</p>
        <button onClick={() => window.location.reload()}>再読み込み</button>
      </div>
    );
  }

  // unauthenticated や loading はログイン画面へ
  return <LoginPrompt />;
}

function App() {
  return (
    <Suspense
      fallback={
        <div className="loading-container">
          <h1>ANGOU BROADCAST</h1>
          <p>認証状態を確認中...</p>
        </div>
      }
    >
      <AppContent />
    </Suspense>
  );
}

export default App;
