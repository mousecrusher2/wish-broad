import { useAuth } from "./useAuth";
import { LoginPrompt } from "./LoginPrompt";
import { WHEPPlayer } from "./WHEPPlayer";

function App() {
  const { user, isLoading, isAuthenticated } = useAuth();

  const handleLogin = () => {
    window.location.href = "/login";
  };

  if (isLoading) {
    return (
      <div className="loading-container">
        <h1>ANGOU BROADCAST</h1>
        <p>認証状態を確認中...</p>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <LoginPrompt onLogin={handleLogin} />;
  }

  return <WHEPPlayer user={user} />;
}

export default App;
