import type { ReactNode } from "react";
import { surfaceClasses } from "./styles";

// Full-screen card used by the login, auth loading, and auth error screens.
export function CenteredCard({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="mx-auto flex min-h-screen max-w-xl items-center justify-center px-4 py-16 sm:px-6">
      <div className={`w-full p-8 text-center sm:p-10 ${surfaceClasses}`}>
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          ANGOU BROADCAST
        </h1>
        {children}
      </div>
    </div>
  );
}
