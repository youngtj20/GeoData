import { useEffect, useRef, useState } from "react";
import { Search, X, LoaderCircle, MapPin } from "lucide-react";
import { geocode, type GeocodeResult } from "../lib/api";

function typeLabel(t: string) {
  const m: Record<string, string> = {
    road: "Road",
    street: "Road",
    path: "Path",
    suburb: "Area",
    neighbourhood: "Area",
    hamlet: "Settlement",
    village: "Village",
    town: "Town",
    city: "City",
    county: "County",
    amenity: "Place",
    building: "Building",
    office: "Office",
    shop: "Shop",
    place: "Place",
  };
  return m[t] || (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Place");
}

export default function SearchBar({ onSelect }: { onSelect: (r: GeocodeResult) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [active, setActive] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (q.trim().length < 3) {
      setResults([]);
      setLoading(false);
      setHasSearched(false);
      setOpen(false);
      setActive(-1);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        const data = await geocode(q.trim(), ac.signal);
        if (ac.signal.aborted) return;
        setResults(data);
        setOpen(true);
        setActive(data.length ? 0 : -1);
        setHasSearched(true);
      } catch {
        if (!ac.signal.aborted) {
          setResults([]);
          setOpen(true);
          setHasSearched(true);
        }
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const pick = (r: GeocodeResult) => {
    setOpen(false);
    setQ(r.display_name);
    onSelect(r);
  };

  return (
    <div ref={wrapRef} className="relative">
      <div className="flex items-center gap-2 rounded-xl border border-slate-300 bg-white px-3 py-2.5 shadow-sm transition focus-within:border-green-700 focus-within:ring-2 focus-within:ring-green-700/20">
        <Search className="h-4 w-4 shrink-0 text-slate-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((v) => Math.min(v + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((v) => Math.max(v - 1, 0));
            } else if (e.key === "Enter") {
              if (active >= 0 && results[active]) pick(results[active]);
            } else if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Search address — e.g. Allen Avenue, Ikeja"
          className="w-full bg-transparent text-sm outline-none placeholder:text-slate-400"
          aria-label="Search address"
        />
        {loading ? (
          <LoaderCircle className="h-4 w-4 shrink-0 animate-spin text-green-700" />
        ) : q ? (
          <button
            onClick={() => {
              setQ("");
              setResults([]);
              setOpen(false);
            }}
            aria-label="Clear"
            className="shrink-0 text-slate-400 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {open && (
        <div className="absolute z-30 mt-2 max-h-80 w-full overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
          {results.length === 0 ? (
            <div className="px-4 py-3 text-sm text-slate-500">
              {hasSearched && !loading ? (
                <>No matches for “{q}”. Try adding the area or city, e.g. “{q}, Ikeja, Lagos”.</>
              ) : (
                "Searching Nigerian addresses…"
              )}
            </div>
          ) : (
            results.map((r, i) => {
              const loc = [r.parts.suburb, r.parts.city, r.parts.state].filter(Boolean).join(" · ");
              return (
                <button
                  key={`${r.lat}-${r.lon}-${i}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(r);
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left ${i === active ? "bg-green-50" : "bg-white hover:bg-slate-50"}`}
                >
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-green-700" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-semibold text-slate-800">{r.parts.road || r.display_name.split(",")[0]}</span>
                      <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-500">
                        {typeLabel(r.type)}
                      </span>
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-slate-500">{r.display_name}</span>
                    {loc && <span className="mt-0.5 block truncate text-[11px] text-slate-400">{loc}</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
