import { useBootstrapAuthState } from "./api";
import { LoginPrompt } from "./LoginPrompt";
import { WHEPPlayerPage } from "./WHEPPlayerPage";

const screenShellClasses =
  "mx-auto flex min-h-screen max-w-3xl items-center justify-center px-6 py-16";
const panelClasses =
  "w-full rounded-4xl border border-white/10 bg-slate-900/75 p-8 text-center shadow-2xl shadow-black/30 backdrop-blur sm:p-10";
const titleClasses =
  "text-3xl font-semibold tracking-tight text-white sm:text-4xl";
const bodyClasses = "mt-3 text-sm leading-7 text-slate-300 sm:text-base";
const actionButtonClasses =
  "mt-6 inline-flex items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60";

function AuthLoadingScreen() {
  return (
    <div className={screenShellClasses}>
      <div className={panelClasses}>
        <h1 className={titleClasses}>ANGOU BROADCAST</h1>
        <p className={bodyClasses}>認証状態を確認中...</p>
      </div>
    </div>
  );
}

function AuthErrorScreen({ message }: Readonly<{ message: string }>) {
  return (
    <div className={screenShellClasses}>
      <div className={panelClasses}>
        <h1 className={titleClasses}>ANGOU BROADCAST</h1>
        <p className={bodyClasses}>認証状態の確認中にエラーが発生しました。</p>
        <p className="mt-2 text-sm leading-7 text-slate-400 sm:text-base">
          {message}
        </p>
        <button
          onClick={() => {
            window.location.reload();
          }}
          className={actionButtonClasses}
        >
          再読み込み
        </button>
      </div>
    </div>
  );
}

function AppBootstrap() {
  const authState = useBootstrapAuthState();

  if (authState.status === "loading") {
    return <AuthLoadingScreen />;
  }

  if (authState.status === "authenticated") {
    return <WHEPPlayerPage />;
  }

  if (authState.status === "error") {
    return <AuthErrorScreen message={authState.error} />;
  }

  return <LoginPrompt />;
}

function App() {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(34,211,238,0.16),transparent_30%),linear-gradient(180deg,#020617_0%,#0f172a_55%,#020617_100%)] text-slate-100">
      <AppBootstrap />
    </div>
  );
}

export default App;
