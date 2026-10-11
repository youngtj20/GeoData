import { useState } from "react";
import { useNavigate, Navigate, Link } from "react-router-dom";
import { ShieldCheck, LoaderCircle } from "lucide-react";
import { useAuth } from "../lib/AuthContext";

export default function LoginPage() {
  const { login, user } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/admin" replace />;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(username, password);
      navigate("/admin", { replace: true });
    } catch (err: any) {
      setError(err?.message || "Login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-stone-100 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-3">
          <img src="/algon-seal.png" alt="ALGON seal" className="h-10 w-10 rounded-full bg-white shadow" />
          <div>
            <h1 className="text-lg font-black leading-tight text-slate-900">Admin login</h1>
            <p className="text-xs text-slate-500">ALGON POA SYSTEM</p>
          </div>
        </div>

        <label className="mb-3 block text-sm">
          <span className="mb-1 block font-semibold text-slate-700">Username</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100"
          />
        </label>
        <label className="mb-4 block text-sm">
          <span className="mb-1 block font-semibold text-slate-700">Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm outline-none focus:border-green-600 focus:ring-2 focus:ring-green-100"
          />
        </label>

        {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 ring-1 ring-red-200">{error}</p>}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-900 px-3 py-2.5 text-sm font-bold text-white hover:bg-green-950 disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
          Sign in
        </button>

        <Link to="/" className="mt-4 block text-center text-xs font-semibold text-slate-500 hover:text-slate-700">
          ← Back to the public map
        </Link>
      </form>
    </div>
  );
}
