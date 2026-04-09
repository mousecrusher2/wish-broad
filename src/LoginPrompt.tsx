export function LoginPrompt() {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl items-center justify-center px-6 py-16">
      <div className="w-full rounded-[2rem] border border-white/10 bg-slate-900/75 p-8 text-center shadow-2xl shadow-black/30 backdrop-blur sm:p-10">
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          ANGOU BROADCAST
        </h1>
        <p className="mt-3 text-sm leading-7 text-slate-300 sm:text-base">
          このアプリケーションを使用するにはログインが必要です。
        </p>
        <a
          href="/login"
          className="mt-6 inline-flex items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/60"
        >
          Discordでログイン
        </a>
      </div>
    </div>
  );
}
