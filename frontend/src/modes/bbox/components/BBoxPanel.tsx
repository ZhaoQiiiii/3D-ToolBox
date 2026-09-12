import { useEffect, useRef, useState } from "react";
import type { BBoxItem, Vec3 } from "../lib/bbox";
import { colorForIndex } from "../lib/bbox";

const SLIDER_RANGES: Record<"x" | "y" | "z", [number, number]> = {
  x: [-30.0, 50.0],
  y: [-30.0, 50.0],
  z: [-10.0, 20.0],
};
const SLIDER_RES = 0.01;

function roundTo(n: number, decimals: number) {
  const f = Math.pow(10, decimals);
  return Math.round(n * f) / f;
}

const rangeStyle: React.CSSProperties = {
  width: 170,
  accentColor: "#3498db",
  height: 4,
};

const rangeStyleCompact: React.CSSProperties = {
  width: 64,
  accentColor: "#3498db",
  height: 4,
};

interface Props {
  boxes: BBoxItem[];
  activeId: string | null;
  placing: boolean;
  cornerMin: Vec3 | null;
  cornerMax: Vec3 | null;
  center: Vec3 | null;
  size: Vec3 | null;
  saveState: "idle" | "saving" | "saved" | "error";
  copied: boolean;
  onSetMin: (v: Vec3) => void;
  onSetMax: (v: Vec3) => void;
  onBeginEdit: () => void;
  onReset: () => void;
  onSave: () => void;
  onCopy: () => void;
  onNewBox: () => void;
  onSelectBox: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onDeleteBox: (id: string) => void;
}

const PANEL_STYLE: React.CSSProperties = {
  background: "rgba(10,12,24,0.88)",
  color: "#ccc",
  fontFamily: "monospace",
  borderRadius: 8,
  border: "1px solid rgba(52,152,219,0.35)",
  boxShadow: "0 8px 28px rgba(0,0,0,0.5)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  padding: "12px 14px",
  width: "100%",
  boxSizing: "border-box",
  fontSize: 12,
  flexShrink: 0,
};

function VecEditor({
  label,
  value,
  onChange,
  onBeginEdit,
  compact = false,
}: {
  label: string;
  value: Vec3;
  onChange: (v: Vec3) => void;
  onBeginEdit: () => void;
  compact?: boolean;
}) {
  const setAxis = (axis: "x" | "y" | "z", n: number) => {
    const next: Vec3 = [...value];
    next[axis === "x" ? 0 : axis === "y" ? 1 : 2] = n;
    onChange(next);
  };

  const axes: Array<{ key: "x" | "y" | "z"; idx: number }> = [
    { key: "x", idx: 0 },
    { key: "y", idx: 1 },
    { key: "z", idx: 2 },
  ];

  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: "#fff", fontWeight: 600, marginBottom: 2 }}>{label}</div>
      {axes.map(({ key, idx }) => {
        const [min, max] = SLIDER_RANGES[key];
        return (
          <div
            key={key}
            style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}
          >
            <span style={{ width: 12, color: "#888" }}>{key}</span>
            <div style={{ flex: 1 }}>
              <NumberStepper
                value={value[idx]!}
                min={min}
                max={max}
                step={SLIDER_RES}
                clamp={false}
                onChange={(n) => setAxis(key, n)}
                onBegin={onBeginEdit}
              />
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={SLIDER_RES}
              value={value[idx]!}
              onChange={(e) => setAxis(key, Number(e.target.value))}
              onPointerDown={onBeginEdit}
              style={compact ? rangeStyleCompact : rangeStyle}
            />
          </div>
        );
      })}
    </div>
  );
}

function NumberStepper({
  value,
  min,
  max,
  step,
  onChange,
  clamp: doClamp = true,
  onBegin,
  decimals = 2,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  clamp?: boolean;
  onBegin?: () => void;
  decimals?: number;
}) {
  const [draft, setDraft] = useState(value.toFixed(decimals));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value.toFixed(decimals));
  }, [value, decimals]);

  const clamp = (n: number) => (doClamp ? Math.min(max, Math.max(min, n)) : n);

  const commit = (raw: string) => {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      const v = roundTo(clamp(n), decimals);
      onBegin?.();
      onChange(v);
      setDraft(v.toFixed(decimals));
    } else {
      setDraft(value.toFixed(decimals));
    }
  };

  const stepBy = (delta: number) => {
    onBegin?.();
    onChange(roundTo(clamp(value + delta), decimals));
  };

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 4 }}>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          focusedRef.current = false;
          commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        style={{
          flex: 1,
          height: 28,
          background: "#1a1a2e",
          color: "#eee",
          border: "1px solid #3498db",
          borderRadius: 4,
          padding: "2px 6px",
          fontFamily: "monospace",
          fontSize: 13,
          textAlign: "right",
        }}
      />
      <button
        type="button"
        aria-label="increase"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => stepBy(step)}
        style={stepperBtnStyle}
      >
        ▲
      </button>
      <button
        type="button"
        aria-label="decrease"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => stepBy(-step)}
        style={stepperBtnStyle}
      >
        ▼
      </button>
    </div>
  );
}

export function BBoxPanel({
  boxes,
  activeId,
  placing,
  cornerMin,
  cornerMax,
  center,
  size,
  saveState,
  copied,
  onSetMin,
  onSetMax,
  onBeginEdit,
  onReset,
  onSave,
  onCopy,
  onNewBox,
  onSelectBox,
  onRename,
  onDeleteBox,
}: Props) {
  return (
    <div data-overlay style={PANEL_STYLE}>
      <div style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>3D-ToolBox</div>

      <div style={{ marginTop: 12, borderTop: "1px solid #333", paddingTop: 8 }}>
        <div style={{ color: "#fff", fontWeight: 700, fontSize: 14, marginBottom: 6 }}>
          物体（{boxes.length}）
        </div>

        {boxes.map((box, i) => {
          const active = box.id === activeId;
          return (
            <div
              key={box.id}
              onClick={() => onSelectBox(box.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 4,
                padding: "4px 6px",
                background: active ? "#1a1a2e" : "transparent",
                border: active ? "1px solid #3498db" : "1px solid #333",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: "50%",
                  background: colorForIndex(i),
                  flexShrink: 0,
                }}
              />
              <input
                type="text"
                value={box.label}
                onChange={(e) => onRename(box.id, e.target.value)}
                onFocus={() => onSelectBox(box.id)}
                onClick={(e) => e.stopPropagation()}
                placeholder="label"
                style={labelInputStyle}
              />
              <button
                type="button"
                aria-label="delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDeleteBox(box.id);
                }}
                style={delBtnStyle}
              >
                ×
              </button>
            </div>
          );
        })}

        <button
          type="button"
          onClick={onNewBox}
          style={{
            width: "100%",
            marginTop: 8,
            background: placing ? "#1a3a5c" : "#1a1a2e",
            color: placing ? "#7ec8ff" : "#3498db",
            border: "1px solid #3498db",
            borderRadius: 4,
            padding: "6px 0",
            cursor: "pointer",
            fontFamily: "monospace",
            fontSize: 13,
          }}
        >
          {placing ? "放置中… 在场景中点击两次" : "+ 新建物体"}
        </button>
      </div>

      <div style={{ marginTop: 12, borderTop: "1px solid #333", paddingTop: 8 }}>
        {cornerMin && cornerMax && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <VecEditor
              label="corner_min"
              value={cornerMin}
              onChange={onSetMin}
              onBeginEdit={onBeginEdit}
              compact
            />
            <VecEditor
              label="corner_max"
              value={cornerMax}
              onChange={onSetMax}
              onBeginEdit={onBeginEdit}
              compact
            />
          </div>
        )}

        <div style={{ color: "#fff", fontWeight: 600, marginBottom: 4, marginTop: 8 }}>输出（m）</div>
        {center && size ? (
          <>
            <div style={valueRowStyle}>
              center: {center[0].toFixed(3)}, {center[1].toFixed(3)}, {center[2].toFixed(3)}
            </div>
            <div style={valueRowStyle}>
              size: {size[0].toFixed(3)}, {size[1].toFixed(3)}, {size[2].toFixed(3)}
            </div>
          </>
        ) : (
          <div style={{ color: "#888" }}>（未框定）</div>
        )}

        <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
          <button type="button" onClick={onCopy} style={btnStyle}>
            {copied ? "已复制" : "复制"}
          </button>
          <button
            type="button"
            onClick={onSave}
            style={
              saveState === "error"
                ? { ...btnStyle, color: "#ff6b6b", borderColor: "#ff6b6b" }
                : btnStyle
            }
          >
            {saveState === "saving"
              ? "保存中…"
              : saveState === "saved"
                ? "已保存"
                : saveState === "error"
                  ? "保存失败"
                  : "保存"}
          </button>
          <button type="button" onClick={onReset} style={btnStyle}>
            重置
          </button>
        </div>
      </div>
    </div>
  );
}

const valueRowStyle: React.CSSProperties = {
  background: "#111",
  border: "1px solid #333",
  borderRadius: 4,
  padding: "6px 8px",
  color: "#7ee787",
  fontSize: 13,
  marginTop: 4,
};

const btnStyle: React.CSSProperties = {
  flex: 1,
  background: "#1a1a2e",
  color: "#ddd",
  border: "1px solid #555",
  borderRadius: 4,
  padding: "4px 0",
  cursor: "pointer",
  fontFamily: "monospace",
  fontSize: 12,
};

const stepperBtnStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#1a1a2e",
  color: "#3498db",
  border: "1px solid #3498db",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
  padding: 0,
};

const labelInputStyle: React.CSSProperties = {
  flex: 1,
  height: 26,
  background: "#111",
  color: "#eee",
  border: "1px solid #333",
  borderRadius: 4,
  padding: "2px 6px",
  fontFamily: "monospace",
  fontSize: 13,
};

const delBtnStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "#1a1a2e",
  color: "#ff6b6b",
  border: "1px solid #555",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 16,
  lineHeight: 1,
  padding: 0,
  flexShrink: 0,
};
