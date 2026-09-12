import type { CSSProperties, RefObject } from "react";
import type { PromptInfo, ResultInfo, TrajPoint, TrajStep } from "../lib/traj-types";

const PANEL: CSSProperties = {
  position: "absolute",
  top: 64,
  right: 16,
  zIndex: 20,
  width: 320,
  maxHeight: "calc(100% - 140px)",
  overflowY: "auto",
  background: "rgba(0,0,0,0.82)",
  color: "#ccc",
  fontFamily: "monospace",
  fontSize: 12,
  border: "1px solid rgba(52,152,219,0.28)",
  boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
  borderRadius: 6,
  padding: "10px 12px",
  userSelect: "none",
};

const ROW: CSSProperties = {
  display: "flex",
  gap: 6,
  padding: "1px 0",
};

const LABEL: CSSProperties = {
  display: "inline-block",
  width: 72,
  color: "#aaa",
  fontSize: 11,
  whiteSpace: "nowrap",
  flexShrink: 0,
};

interface Props {
  step: TrajStep;
  prompt: PromptInfo | null;
  result: ResultInfo | null;
  hasVideo: boolean;
  videoRef: RefObject<HTMLVideoElement | null>;
  playIndex: number;
  pointCount: number;
  currentPoint: TrajPoint | null;
}

/**
 * Right-side info panel for the active step: task metadata, the anchor
 * image, the worldmodel-generated video (kept paused; the parent seeks it
 * to the playhead frame) and the current point readout.
 */
export function InfoPanel({
  step,
  prompt,
  result,
  hasVideo,
  videoRef,
  playIndex,
  pointCount,
  currentPoint,
}: Props) {
  const assetUrl = (name: string) =>
    `/api/traj-asset?path=${encodeURIComponent(step.path)}&name=${name}`;

  return (
    <div data-overlay style={PANEL}>
      <div style={{ color: "#fff", fontWeight: 600, fontSize: 13 }}>
        Step 信息
      </div>

      {prompt && (
        <>
          <Row label="任务类型" value={prompt.task_type ?? "—"} />
          <Row label="目标" value={prompt.target_description ?? "—"} />
          <Row label="目标指令" value={prompt.original_goal ?? "—"} />
        </>
      )}
      {result && (
        <>
          <Row label="状态" value={result.status ?? "—"} />
          {result.session_tag && <Row label="会话" value={result.session_tag} />}
        </>
      )}

      {/* key on the step so a failed load's display:none resets when the
          user switches steps; onError hides the broken-image icon for
          steps that have no anchor.jpg. */}
      <img
        key={step.path}
        src={assetUrl("anchor.jpg")}
        alt="anchor"
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
        onLoad={(e) => {
          e.currentTarget.style.display = "block";
        }}
        style={{ width: "100%", borderRadius: 4, display: "block", marginTop: 8 }}
      />

      {hasVideo && (
        <video
          ref={videoRef}
          src={assetUrl("video.mp4")}
          muted
          playsInline
          preload="metadata"
          style={{ width: "100%", borderRadius: 4, display: "block", marginTop: 6 }}
        />
      )}

      <div style={{ borderTop: "1px solid #333", margin: "8px 0 4px" }} />
      {currentPoint ? (
        <>
          <Row
            label="当前点"
            value={`${playIndex + 1} / ${pointCount}`}
          />
          <Row
            label="位置"
            value={`(${currentPoint.x.toFixed(2)}, ${currentPoint.y.toFixed(2)}, ${currentPoint.z.toFixed(2)})`}
          />
          <Row
            label="Yaw"
            value={`${((currentPoint.yaw_rad * 180) / Math.PI).toFixed(1)}°`}
          />
        </>
      ) : (
        <div style={{ color: "#888" }}>无轨迹数据</div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={ROW}>
      <span style={LABEL}>{label}</span>
      <span style={{ color: "#ddd", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}
