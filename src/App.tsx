import { Suspense } from "react";
import { useSuspenseAuthState } from "./api/hooks";
import { CenteredCard } from "./components/CenteredCard";
import { LoginPrompt } from "./pages/LoginPrompt";
import { WHEPPlayerPage } from "./pages/WHEPPlayerPage";
import { buttonClasses, centeredCardBodyClasses } from "./components/styles";

function AuthLoadingScreen() {
  return (
    <CenteredCard>
      <p className={centeredCardBodyClasses}>認証状態を確認中...</p>
    </CenteredCard>
  );
}

function AuthErrorScreen({ message }: Readonly<{ message: string }>) {
  return (
    <CenteredCard>
      <p className={centeredCardBodyClasses}>
        認証状態の確認中にエラーが発生しました。
      </p>
      <p className="mt-2 text-sm leading-6 wrap-break-word text-slate-400">
        {message}
      </p>
      <button
        type="button"
        onClick={() => {
          window.location.reload();
        }}
        className={`mt-8 ${buttonClasses("primary", "lg")}`}
      >
        再読み込み
      </button>
    </CenteredCard>
  );
}

function AppBootstrap() {
  const authState = useSuspenseAuthState();

  if (authState.status === "authenticated") {
    return <WHEPPlayerPage user={authState.user} />;
  }

  if (authState.status === "error") {
    return <AuthErrorScreen message={authState.error} />;
  }

  return <LoginPrompt />;
}

function App() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.16),transparent_30%),linear-gradient(180deg,#020617_0%,#0f172a_55%,#020617_100%)] text-slate-100">
      <Suspense fallback={<AuthLoadingScreen />}>
        <AppBootstrap />
      </Suspense>
    </div>
  );
}

export default App;
