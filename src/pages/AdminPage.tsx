import { useEffect, useState, type ReactNode } from "react";
import { Navigate, Link } from "react-router-dom";
import { LoaderCircle, LogOut, ShieldCheck, Map as MapIcon, Users as UsersIcon, Trash2, Plus, Check, KeyRound, Copy, Lock, ArrowUpRight } from "lucide-react";
import { useAuth } from "../lib/AuthContext";
import {
  fetchMapSettings,
  updateMapSettings,
  fetchPermissionCatalog,
  fetchAdminUsers,
  createAdminUser,
  updateUserPermissions,
  deleteAdminUser,
  fetchApiClients,
  createApiClient,
  setApiClientActive,
  deleteApiClient,
  type MapSettings,
  type Permission,
  type AdminUser,
  type ApiClient,
} from "../lib/api";

export default function AdminPage() {
  const { user, loading, logout, hasPermission } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-stone-100">
        <LoaderCircle className="h-6 w-6 animate-spin text-green-800" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;

  const initial = user.username.slice(0, 1).toUpperCase();

  return (
    <div className="min-h-screen bg-stone-100">
      <header className="sticky top-0 z-10 border-b border-black/10 bg-gradient-to-r from-green-950 via-green-900 to-emerald-900 text-white shadow-sm">
        <div className="mx-auto flex max-w-[1100px] items-center gap-3 px-4 py-3.5">
          <img src="/algon-seal.png" alt="ALGON seal" className="h-9 w-9 shrink-0 rounded-full bg-white shadow" />
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-black uppercase tracking-[0.18em] text-emerald-300/80">Admin console</p>
            <h1 className="truncate text-base font-black leading-tight">ALGON POA SYSTEM</h1>
          </div>
          <div className="hidden items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-3 text-xs font-bold ring-1 ring-white/15 sm:flex">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-400 text-[11px] font-black text-green-950">{initial}</span>
            {user.username}
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-1 rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold ring-1 ring-white/15 hover:bg-white/20"
          >
            View public map <ArrowUpRight className="h-3 w-3" />
          </Link>
          <button
            onClick={() => logout()}
            className="flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-green-900 hover:bg-amber-50"
          >
            <LogOut className="h-3.5 w-3.5" /> Log out
          </button>
        </div>
      </header>

      <main className="mx-auto flex max-w-[1100px] flex-col gap-5 p-4 pb-16 pt-5">
        <MapSettingsPanel hasPermission={hasPermission} />
        {hasPermission("manage_users") ? (
          <UsersPanel />
        ) : (
          <RestrictedSection permission="manage_users" what="user management" />
        )}
        {hasPermission("manage_api_clients") ? (
          <ApiClientsPanel />
        ) : (
          <RestrictedSection permission="manage_api_clients" what="3rd-party API client management" />
        )}
      </main>
    </div>
  );
}

function RestrictedSection({ permission, what }: { permission: string; what: string }) {
  return (
    <section className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white/50 p-7 text-center">
      <Lock className="h-5 w-5 text-slate-300" />
      <p className="text-sm font-bold text-slate-500">Restricted</p>
      <p className="max-w-sm text-xs leading-relaxed text-slate-400">
        You don't have the <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-500">{permission}</code> permission, so {what} is hidden.
        Ask another admin with <span className="font-semibold text-slate-500">Manage users</span> to grant it.
      </p>
    </section>
  );
}

function SectionHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-green-50 text-green-700 ring-1 ring-green-100">{icon}</div>
        <div>
          <h2 className="text-sm font-black text-slate-800">{title}</h2>
          {description && <p className="mt-0.5 max-w-md text-xs leading-snug text-slate-500">{description}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return <p className="mb-3 rounded-xl bg-red-50 px-3 py-2.5 text-xs font-semibold text-red-700 ring-1 ring-red-200">{message}</p>;
}

function PrimaryButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-green-900 px-3 py-2 text-xs font-bold text-white shadow-sm hover:bg-green-950 active:scale-[0.98]"
    >
      {children}
    </button>
  );
}

function MapSettingsPanel({ hasPermission }: { hasPermission: (key: string) => boolean }) {
  const [settings, setSettings] = useState<MapSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchMapSettings().then(setSettings).catch((e) => setError(e.message));
  }, []);

  const canProvider = hasPermission("change_map_provider");
  const canWards = hasPermission("toggle_layer_wards");
  const canBuildings = hasPermission("toggle_layer_buildings");
  const canSettlements = hasPermission("toggle_layer_settlements");
  const canEditAnything = canProvider || canWards || canBuildings || canSettlements;

  async function save(patch: Partial<MapSettings>) {
    if (!settings) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await updateMapSettings(patch);
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <SectionHeader icon={<MapIcon className="h-4.5 w-4.5" />} title="Public map settings" description="Controls what every visitor sees on the live map — no login required to view." />

      {!settings && !error && <LoaderCircle className="h-4 w-4 animate-spin text-slate-400" />}
      {error && <ErrorBanner message={error} />}

      {settings && (
        <div className="flex flex-col gap-5">
          <div>
            <p className="mb-2 text-[11px] font-black uppercase tracking-widest text-slate-400">Map provider</p>
            <div className="flex gap-2">
              {(["google", "mapbox", "osm"] as const).map((p) => (
                <button
                  key={p}
                  disabled={!canProvider}
                  onClick={() => save({ provider: p })}
                  className={`rounded-xl px-3.5 py-2 text-xs font-bold capitalize ring-1 transition ${
                    settings.provider === p
                      ? "bg-green-900 text-white ring-green-900"
                      : "bg-white text-slate-600 ring-slate-300 hover:bg-slate-50"
                  } ${!canProvider ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  {p === "osm" ? "OSM" : p}
                </button>
              ))}
            </div>
            {!canProvider && (
              <p className="mt-1.5 text-[11px] text-slate-400">
                Requires <code className="rounded bg-slate-100 px-1">change_map_provider</code>.
              </p>
            )}
          </div>

          <div>
            <p className="mb-2 text-[11px] font-black uppercase tracking-widest text-slate-400">Layers visible on the public map</p>
            <div className="flex flex-col gap-2.5 rounded-xl border border-slate-200 p-3">
              <LayerToggle label="Ward / LGA boundaries" checked={settings.show_wards} disabled={!canWards} onChange={(v) => save({ show_wards: v })} />
              <LayerToggle label="Building footprints" checked={settings.show_buildings} disabled={!canBuildings} onChange={(v) => save({ show_buildings: v })} />
              <LayerToggle
                label="GRID3 settlement density blocks"
                checked={settings.show_settlements}
                disabled={!canSettlements}
                onChange={(v) => save({ show_settlements: v })}
              />
            </div>
          </div>

          <div className="flex min-h-[18px] items-center gap-2 text-xs">
            {saving && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-slate-400" />}
            {saved && (
              <span className="flex items-center gap-1 font-semibold text-green-700">
                <Check className="h-3.5 w-3.5" /> Saved
              </span>
            )}
            {!canEditAnything && <span className="text-slate-400">You have no permission to change these settings.</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function LayerToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`flex items-center gap-2.5 text-sm font-medium text-slate-700 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 accent-green-800"
      />
      {label}
    </label>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-green-100 text-xs font-black text-green-800 ring-1 ring-green-200">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function UsersPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [catalog, setCatalog] = useState<Permission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  async function refresh() {
    try {
      const [u, p] = await Promise.all([fetchAdminUsers(), fetchPermissionCatalog()]);
      setUsers(u);
      setCatalog(p);
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function togglePermission(u: AdminUser, key: string) {
    const next = u.permissions.includes(key) ? u.permissions.filter((k) => k !== key) : [...u.permissions, key];
    setUsers((prev) => prev.map((x) => (x.id === u.id ? { ...x, permissions: next } : x)));
    try {
      await updateUserPermissions(u.id, next);
    } catch (e: any) {
      setError(e.message);
      refresh();
    }
  }

  async function removeUser(u: AdminUser) {
    if (!confirm(`Delete user "${u.username}"? This cannot be undone.`)) return;
    try {
      await deleteAdminUser(u.id);
      setUsers((prev) => prev.filter((x) => x.id !== u.id));
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <SectionHeader
        icon={<UsersIcon className="h-4.5 w-4.5" />}
        title="Users & permissions"
        description={`${users.length || 0} account${users.length === 1 ? "" : "s"} with access to this admin console.`}
        action={
          <PrimaryButton onClick={() => setShowCreate((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> New user
          </PrimaryButton>
        }
      />

      {error && <ErrorBanner message={error} />}

      {showCreate && (
        <CreateUserForm
          catalog={catalog}
          onCreated={() => {
            setShowCreate(false);
            refresh();
          }}
        />
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <th className="py-2.5 pl-3 pr-3 font-bold">Username</th>
              <th className="py-2.5 pr-3 font-bold">Permissions</th>
              <th className="py-2.5 pr-3" />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50/60">
                <td className="py-3 pl-3 pr-3">
                  <div className="flex items-center gap-2 font-semibold text-slate-800">
                    <Avatar name={u.username} /> {u.username}
                  </div>
                </td>
                <td className="py-3 pr-3">
                  <div className="flex flex-wrap gap-1.5">
                    {catalog.map((p) => (
                      <button
                        key={p.key}
                        title={p.description}
                        onClick={() => togglePermission(u, p.key)}
                        className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 transition ${
                          u.permissions.includes(p.key)
                            ? "bg-green-100 text-green-800 ring-green-300"
                            : "bg-white text-slate-400 ring-slate-200 hover:bg-slate-50"
                        }`}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </td>
                <td className="py-3 pr-3 text-right">
                  <button onClick={() => removeUser(u)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {!users.length && (
              <tr>
                <td colSpan={3} className="py-5 text-center text-xs text-slate-400">
                  No users yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-slate-400">{children}</p>;
}

function CreateUserForm({ catalog, onCreated }: { catalog: Permission[]; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggle(key: string) {
    setPermissions((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createAdminUser(username, password, permissions);
      onCreated();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>Username</FieldLabel>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-green-700 focus:ring-2 focus:ring-green-700/15"
          />
        </div>
        <div>
          <FieldLabel>Password</FieldLabel>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-green-700 focus:ring-2 focus:ring-green-700/15"
          />
        </div>
      </div>
      <FieldLabel>Permissions</FieldLabel>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {catalog.map((p) => (
          <button
            type="button"
            key={p.key}
            title={p.description}
            onClick={() => toggle(p.key)}
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 transition ${
              permissions.includes(p.key) ? "bg-green-100 text-green-800 ring-green-300" : "bg-white text-slate-400 ring-slate-200"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      {error && <ErrorBanner message={error} />}
      <button
        disabled={busy || !username || !password}
        className="flex items-center gap-1.5 rounded-lg bg-green-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-green-950 disabled:opacity-50"
      >
        {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
        Create user
      </button>
    </form>
  );
}

function ApiClientsPanel() {
  const [clients, setClients] = useState<ApiClient[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  // shown once, right after creation — the server never returns the raw key again after this
  const [revealedKey, setRevealedKey] = useState<{ name: string; apiKey: string } | null>(null);

  async function refresh() {
    try {
      setClients(await fetchApiClients());
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function toggleActive(c: ApiClient) {
    setClients((prev) => prev.map((x) => (x.id === c.id ? { ...x, active: !x.active } : x)));
    try {
      await setApiClientActive(c.id, !c.active);
    } catch (e: any) {
      setError(e.message);
      refresh();
    }
  }

  async function removeClient(c: ApiClient) {
    if (!confirm(`Revoke and delete API client "${c.name}"? Any 3rd party using this key will immediately lose access.`)) return;
    try {
      await deleteApiClient(c.id);
      setClients((prev) => prev.filter((x) => x.id !== c.id));
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <SectionHeader
        icon={<KeyRound className="h-4.5 w-4.5" />}
        title="3rd-party API clients"
        description={
          <>
            Keys authenticate requests to <code className="rounded bg-slate-100 px-1 py-0.5 text-slate-600">POST /api/v1/verify-address</code> — the
            address/building existence check used by external integrations.
          </>
        }
        action={
          <PrimaryButton onClick={() => setShowCreate((v) => !v)}>
            <Plus className="h-3.5 w-3.5" /> New API key
          </PrimaryButton>
        }
      />

      {error && <ErrorBanner message={error} />}

      {showCreate && (
        <CreateApiClientForm
          onCreated={(created) => {
            setShowCreate(false);
            setRevealedKey({ name: created.name, apiKey: created.apiKey });
            refresh();
          }}
        />
      )}

      {revealedKey && (
        <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3.5">
          <p className="mb-1.5 text-xs font-bold text-amber-900">API key for "{revealedKey.name}" — copy it now, it won't be shown again:</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto whitespace-nowrap rounded-lg bg-white px-2 py-1.5 text-xs text-slate-800 ring-1 ring-amber-200">
              {revealedKey.apiKey}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(revealedKey.apiKey)}
              className="flex shrink-0 items-center gap-1 rounded-lg bg-amber-900 px-2.5 py-1.5 text-xs font-bold text-white hover:bg-amber-950"
            >
              <Copy className="h-3.5 w-3.5" /> Copy
            </button>
            <button
              onClick={() => setRevealedKey(null)}
              className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-amber-800 hover:bg-amber-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <th className="py-2.5 pl-3 pr-3 font-bold">Name</th>
              <th className="py-2.5 pr-3 font-bold">Status</th>
              <th className="py-2.5 pr-3 font-bold">Created</th>
              <th className="py-2.5 pr-3 font-bold">Last used</th>
              <th className="py-2.5 pr-3" />
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} className="border-b border-slate-100 align-top last:border-0 hover:bg-slate-50/60">
                <td className="py-3 pl-3 pr-3 font-semibold text-slate-800">{c.name}</td>
                <td className="py-3 pr-3">
                  <button
                    onClick={() => toggleActive(c)}
                    title={c.active ? "Click to revoke" : "Click to reactivate"}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 transition ${
                      c.active ? "bg-green-100 text-green-800 ring-green-300" : "bg-slate-100 text-slate-500 ring-slate-300"
                    }`}
                  >
                    {c.active ? "Active" : "Revoked"}
                  </button>
                </td>
                <td className="py-3 pr-3 text-xs text-slate-500">{new Date(c.created_at).toLocaleDateString()}</td>
                <td className="py-3 pr-3 text-xs text-slate-500">{c.last_used_at ? new Date(c.last_used_at).toLocaleString() : "Never"}</td>
                <td className="py-3 pr-3 text-right">
                  <button onClick={() => removeClient(c)} className="rounded-lg p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {!clients.length && (
              <tr>
                <td colSpan={5} className="py-5 text-center text-xs text-slate-400">
                  No API clients yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CreateApiClientForm({ onCreated }: { onCreated: (created: ApiClient & { apiKey: string }) => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createApiClient(name);
      onCreated(created);
      setName("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mb-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <FieldLabel>Client name</FieldLabel>
      <input
        placeholder="e.g. NIMC"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-3 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-green-700 focus:ring-2 focus:ring-green-700/15 sm:max-w-xs"
      />
      {error && <ErrorBanner message={error} />}
      <button
        disabled={busy || !name.trim()}
        className="flex items-center gap-1.5 rounded-lg bg-green-900 px-3 py-1.5 text-xs font-bold text-white hover:bg-green-950 disabled:opacity-50"
      >
        {busy ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <KeyRound className="h-3.5 w-3.5" />}
        Generate key
      </button>
    </form>
  );
}
