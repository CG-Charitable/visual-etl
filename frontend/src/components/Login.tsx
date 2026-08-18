import { useState } from "react";
import { login } from "../api";

interface LoginProps {
  onLoggedIn: () => void;
}

export function Login({ onLoggedIn }: LoginProps) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(username, password);
      onLoggedIn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function signInWithGoogle() {
    window.location.href = "/auth/google?redirect=/tool/";
  }

  return (
    <div className="login">
      <form className="login__card" onSubmit={submit}>
        <h1>Visual ETL</h1>
        <button type="button" className="btn btn--google" onClick={signInWithGoogle}>
          <GoogleIcon />
          Sign in with Google
        </button>
        <div className="login__divider">
          <span>or</span>
        </div>
        <label className="field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error && <div className="login__error">{error}</div>}
        <button className="btn btn--primary" type="submit" disabled={busy}>
          {busy ? "Logging in…" : "Log in"}
        </button>
      </form>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20.5H24v7h11.3C33.9 31.9 29.4 35 24 35c-6.1 0-11.2-3.7-13.4-9-.7-1.6-1.1-3.3-1.1-5s.4-3.4 1.1-5c2.2-5.3 7.3-9 13.4-9 3.1 0 5.9 1.1 8.1 2.9l5.9-5.9C34.9 1.7 29.7 0 24 0 14.6 0 6.4 5.4 2.5 13.3c-1.6 3.2-2.5 6.9-2.5 10.7s.9 7.5 2.5 10.7C6.4 42.6 14.6 48 24 48c13.3 0 22-9.3 22-22 0-1.5-.2-3.2-.4-5.5z"
      />
      <path
        fill="#FF3D00"
        d="M6.3 14.7l5.7 4.2C13.6 15.1 18.4 12 24 12c3.1 0 5.9 1.1 8.1 2.9l5.9-5.9C34.9 5.7 29.7 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.6 0 10.7-2.1 14.5-5.7l-6.6-5.6C29.7 34.5 27 35.5 24 35.5c-5.3 0-9.8-3.4-11.4-8.1l-6.6 5.1C9.6 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20.5H24v7h11.3c-.7 2-2 3.7-3.6 5l6.6 5.6C41.6 35.2 44 30.1 44 24c0-1.5-.2-3.2-.4-5.5z"
      />
    </svg>
  );
}
