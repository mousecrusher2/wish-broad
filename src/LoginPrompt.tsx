import { CenteredCard } from "./components/CenteredCard";
import { buttonClasses, centeredCardBodyClasses } from "./components/styles";

export function LoginPrompt() {
  return (
    <CenteredCard>
      <p className={centeredCardBodyClasses}>
        このアプリケーションを使用するにはログインが必要です。
      </p>
      <a href="/login" className={`mt-8 ${buttonClasses("primary", "lg")}`}>
        Discordでログイン
      </a>
    </CenteredCard>
  );
}
