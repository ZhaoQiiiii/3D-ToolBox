import { useEffect, useRef, useState } from "react";
import type { Vec3 } from "../lib/bbox";

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

const labelStyle: React.CSSProperties = {
  width: 64,
  color: "#888",
  flexShrink: 0,
};

interface Props {
  cornerMin: Vec3 | null;
  cornerMax: Vec3 | null;
  center: Vec3 | null;
  size: Vec3 | null;
  pointSize: number;
  handleRadius: number;
  lineWidth: number;
  opacity: number;
  saveState: "idle" | "saving" | "saved" | "error";
  copied: boolean;
  cloudFiles: string[];
  selectedCloud: string;
  onSelectCloud: (name: string) => void;
  onSetMin: (v: Vec3) => void;
  onSetMax: (v: Vec3) => void;
  onBeginEdit: () => void;
  onReset: () => void;
  onSave: () => void;
  onCopy: () => void;
  onPointSize: (v: number) => void;
  onHandleRadius: (v: number) => void;
  onLineWidth: (v: number) => void;
  onOpacity: (v: number) => void;
}

const PANEL_STYLE: React.CSSProperties = {
  position: "absolute",
  top: 16,
  left: 16,
  zIndex: 10,
  background: "rgba(0,0,0,0.82)",
  color: "#ccc",
  fontFamily: "monospace",
  borderRadius: 8,
  padding: "14px 16px",
  width: 440,
  maxHeight: "calc(100vh - 32px)",
  overflowY: "auto",
  fontSize: 14,
};

function VecEditor({
  label,
  value,
  onChange,
  onBeginEdit,
}: {
  label: string;
  value: Vec3;
  onChange: (v: Vec3) => void;
  onBeginEdit: () => void;
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
              style={rangeStyle}
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

function SizeControl({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
      <span style={labelStyle}>{label}</span>
      <div style={{ flex: 1 }}>
        <NumberStepper value={value} min={min} max={max} step={step} onChange={onChange} />
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={rangeStyle}
      />
    </div>
  );
}

export function BBoxPanel({
  cornerMin,
  cornerMax,
  center,
  size,
  pointSize,
  handleRadius,
  lineWidth,
  opacity,
  saveState,
  copied,
  cloudFiles,
  selectedCloud,
  onSelectCloud,
  onSetMin,
  onSetMax,
  onBeginEdit,
  onReset,
  onSave,
  onCopy,
  onPointSize,
  onHandleRadius,
  onLineWidth,
  onOpacity,
}: Props) {
  const cloudOptions = cloudFiles.includes(selectedCloud)
    ? cloudFiles
    : [selectedCloud, ...cloudFiles];

  return (
    <div data-overlay style={PANEL_STYLE}>
      <div style={{ color: "#fff", fontWeight: 700, fontSize: 15 }}>3D-BBox  Tool</div>

      <div style={{ marginTop: 8 }}>
        <div style={{ color: "#fff", fontWeight: 700, fontSize: 14, marginBottom: 6 }}>基本参数</div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={labelStyle}>点云文件</span>
          <select
            value={selectedCloud}
            onChange={(e) => onSelectCloud(e.target.value)}
            style={{
              flex: 1,
              background: "#1a1a2e",
              color: "#ddd",
              border: "1px solid #555",
              borderRadius: 4,
              padding: "4px 6px",
              fontFamily: "monospace",
              fontSize: 13,
            }}
          >
            {cloudOptions.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <SizeControl
          label="点云大小"
          value={pointSize}
          min={0.01}
          max={0.3}
          step={0.01}
          onChange={onPointSize}
        />
        <SizeControl
          label="角点大小"
          value={handleRadius}
          min={0.02}
          max={0.6}
          step={0.01}
          onChange={onHandleRadius}
        />
        <SizeControl
          label="线条粗细"
          value={lineWidth}
          min={0.01}
          max={0.2}
          step={0.01}
          onChange={onLineWidth}
        />
        <SizeControl
          label="不透明度"
          value={opacity}
          min={0}
          max={1}
          step={0.01}
          onChange={onOpacity}
        />
      </div>

      <div style={{ marginTop: 12, borderTop: "1px solid #333", paddingTop: 8 }}>
        {cornerMin && (
          <VecEditor
            label="corner_min"
            value={cornerMin}
            onChange={onSetMin}
            onBeginEdit={onBeginEdit}
          />
        )}
        {cornerMax && (
          <VecEditor
            label="corner_max"
            value={cornerMax}
            onChange={onSetMax}
            onBeginEdit={onBeginEdit}
          />
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
          <button type="button" onClick={onSave} style={btnStyle}>
            {saveState === "saving" ? "保存中…" : saveState === "saved" ? "已保存" : "保存"}
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
