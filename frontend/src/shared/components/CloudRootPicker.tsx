import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

/**
 * Switch the server-side cloud/splat data root (POST /api/pcd-root). Shared
 * by all three modes — the root is global, so switching it here affects
 * every mode's file listing. Self-contained: fetches the current root on
 * mount, validates server-side, and calls `onRootChanged` after a successful
 * switch so the parent can re-fetch its file list.
 */
export function CloudRootPicker({
  onRootChanged,
  label = "点云根目录",
}: {
  onRootChanged?: () => void;
  label?: string;
}) {
  const [root, setRoot] = useState("");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/pcd-root")
      .then((r) => r.json())
      .then((j) => {
        if (typeof j?.root === "string") setRoot(j.root);
      })
      .catch(() => {
        /* keep placeholder empty */
      });
  }, []);

  const apply = async () => {
    const p = input.trim();
    if (!p) {
      setError("请输入服务器上的绝对路径");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/pcd-root", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p }),
      });
      const j = (await r.json().catch(() => null)) as
        | { root?: string; error?: string }
        | null;
      if (!r.ok) throw new Error(j?.error || `HTTP ${r.status}`);
      setRoot(j?.root ?? p);
      setInput("");
      onRootChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ width: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={labelStyle}>{label}</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void apply();
          }}
          placeholder={root}
          title={root || undefined}
          style={inputStyle}
        />
        <button type="button" style={btnStyle} disabled={busy} onClick={() => void apply()}>
          {busy ? "…" : "切换"}
        </button>
      </div>
      {error && <div style={errorStyle}>{error}</div>}
    </div>
  );
}

const labelStyle: CSSProperties = {
  color: "#aaa",
  fontSize: 11,
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  height: 24,
  background: "#1a1a2e",
  color: "#eee",
  border: "1px solid #555",
  borderRadius: 4,
  padding: "2px 6px",
  fontFamily: "monospace",
  fontSize: 11,
};

const btnStyle: CSSProperties = {
  background: "#1a1a2e",
  color: "#3498db",
  border: "1px solid #3498db",
  borderRadius: 4,
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 11,
  padding: "2px 8px",
  flexShrink: 0,
};

const errorStyle: CSSProperties = {
  color: "#e55",
  fontSize: 11,
  marginTop: 2,
};
