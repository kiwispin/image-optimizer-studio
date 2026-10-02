import React from "react";
import ReactDOM from "react-dom/client";
import { Download, FileArchive, Hand, ImagePlus, Info, MoveHorizontal, RefreshCw, RotateCcw, Settings2, Wand2, X } from "lucide-react";
import type { BatchResponse, JobResult, OutputFormat, Preset, ProcessOptions, ResizeKernel, ResizeMethod } from "../shared/types";
import "./styles.css";

const outputFormats: Array<{ value: OutputFormat; label: string; title: string }> = [
  { value: "auto", label: "Auto", title: "Try the modern formats and keep the smallest that passes the quality checks" },
  { value: "original", label: "Original", title: "Keep the same format as the uploaded file" },
  { value: "avif", label: "AVIF", title: "Smallest files, slowest to encode" },
  { value: "webp", label: "WebP", title: "Small files, supported by every modern browser" },
  { value: "jpeg", label: "JPEG", title: "Works everywhere; no transparency" },
  { value: "png", label: "PNG", title: "Lossless or palette PNG; best for graphics and transparency" },
  { value: "jxl", label: "JXL", title: "JPEG XL; limited browser support" }
];

const presetOptions: Array<{ value: Preset; label: string; title: string }> = [
  { value: "smallest", label: "Compact", title: "Smallest files, most aggressive compression" },
  { value: "balanced", label: "Balanced", title: "Recommended everyday compression" },
  { value: "ultra", label: "Optimal", title: "Slower candidate search for the best size that passes quality checks" },
  { value: "fidelity", label: "Pristine", title: "Closest match to the original" }
];

const resizeQualityOptions: Array<{ value: ResizeKernel; label: string }> = [
  { value: "nearest", label: "Nearest" },
  { value: "linear", label: "Bilinear" },
  { value: "cubic", label: "Bicubic" },
  { value: "mitchell", label: "Bicubic Smoother" },
  { value: "lanczos3", label: "Bicubic Sharper" }
];

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power === 0 ? 0 : 1)} ${units[power]}`;
}

function formatSavings(savings: number): string {
  const percentage = Math.round(Math.abs(savings) * 100);
  return savings >= 0 ? `${percentage}% smaller` : `${percentage}% bigger`;
}

function formatSigned(value: string): string {
  const number = Number(value);
  return number > 0 ? `+${number}` : String(number);
}

function zipUrlFor(jobs: JobResult[]): string | undefined {
  const ids = jobs.flatMap((job) => job.variants.map((variant) => variant.id));
  return ids.length ? `/api/download.zip?ids=${ids.map(encodeURIComponent).join(",")}` : undefined;
}

function formatSimilarity(ssim?: number): string {
  if (!ssim) return "-";
  return `${(ssim * 100).toFixed(ssim >= 0.9995 ? 2 : 1)}% match`;
}

function errorJob(file: File, message: string): JobResult {
  return {
    id: `error-${pendingId()}`,
    originalFilename: file.name,
    input: { size: file.size, type: file.type || "unknown" },
    status: "error",
    error: message,
    variants: []
  };
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = await response.json();
    if (payload?.error) return String(payload.error);
  } catch {
    // Non-JSON error (e.g. a proxy or host limit page).
  }
  if (response.status === 413) return "This image is too large for this server.";
  if (response.status === 502 || response.status === 503) return "The server ran out of resources or restarted while processing. Try fewer or smaller images, or run the app locally.";
  return `${fallback} (HTTP ${response.status})`;
}

interface ServerInfo {
  localOnly: boolean;
  maxUploadMb?: number;
  retentionHours?: number;
  engines: string[];
}

function bestVariant(job: JobResult) {
  return [...job.variants].sort((a, b) => a.size - b.size)[0];
}

interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
  width?: number;
  height?: number;
}

function pendingId() {
  return crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readImageDimensions(url: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = reject;
    image.src = url;
  });
}

function proportionalSize(value: string, from: number, to: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !from || !to) return "";
  return String(Math.max(1, Math.round((parsed * to) / from)));
}

function clampFilterFactor(value: number) {
  return Math.max(0.5, Math.min(1.5, value));
}

function toneFilter(current: ProcessOptions, processed: ProcessOptions) {
  const currentBrightness = current.enhance?.brightness || 0;
  const processedBrightness = processed.enhance?.brightness || 0;
  const currentContrast = current.enhance?.contrast || 0;
  const processedContrast = processed.enhance?.contrast || 0;
  const brightness = clampFilterFactor((1 + currentBrightness / 100) / (1 + processedBrightness / 100));
  const contrast = clampFilterFactor((1 + currentContrast / 100) / (1 + processedContrast / 100));
  const active = Math.abs(brightness - 1) > 0.001 || Math.abs(contrast - 1) > 0.001;

  return {
    active,
    filter: active ? `brightness(${brightness.toFixed(3)}) contrast(${contrast.toFixed(3)})` : undefined
  };
}

function ComparePreview({
  job,
  liveToneFilter,
  stale,
  variant
}: {
  job: JobResult;
  liveToneFilter?: string;
  stale: boolean;
  variant?: ReturnType<typeof bestVariant>;
}) {
  const [split, setSplit] = React.useState(50);
  const [zoom, setZoom] = React.useState(1);
  const [pan, setPan] = React.useState({ x: 0, y: 0 });
  const [previewMode, setPreviewMode] = React.useState<"compare" | "pan">("compare");
  const [dragStart, setDragStart] = React.useState<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  React.useEffect(() => {
    if (zoom <= 1 && previewMode === "pan") {
      setPreviewMode("compare");
      setDragStart(null);
    }
  }, [previewMode, zoom]);

  if (!variant || !job.input.previewUrl) {
    return <div className="preview-empty">Preview unavailable</div>;
  }

  const imageStyle = {
    transform: `scale(${zoom})`,
    translate: `${pan.x}px ${pan.y}px`,
    transformOrigin: "50% 50%"
  };
  const optimizedStyle = liveToneFilter ? { ...imageStyle, filter: liveToneFilter } : imageStyle;

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setPreviewMode("compare");
  }

  const isPanMode = zoom > 1 && previewMode === "pan";

  return (
    <div
      className={`compare-preview ${zoom > 1 ? "is-zoomed" : ""} ${isPanMode ? "is-panning" : ""}`}
      onPointerCancel={() => setDragStart(null)}
      onPointerDown={(event) => {
        const target = event.target instanceof Element ? event.target.closest("button, input, textarea, select") : null;
        if (!isPanMode || target) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragStart({
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          panX: pan.x,
          panY: pan.y
        });
      }}
      onPointerMove={(event) => {
        if (!dragStart || event.pointerId !== dragStart.pointerId) return;
        setPan({
          x: dragStart.panX + event.clientX - dragStart.x,
          y: dragStart.panY + event.clientY - dragStart.y
        });
      }}
      onPointerUp={(event) => {
        if (dragStart?.pointerId === event.pointerId) {
          setDragStart(null);
        }
      }}
    >
      <img alt={`${job.originalFilename} optimized`} className="compare-image compare-base" src={variant.previewUrl} style={optimizedStyle} />
      <div className="compare-overlay" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }}>
        <img alt={`${job.originalFilename} original`} className="compare-image" src={job.input.previewUrl} style={imageStyle} />
      </div>
      <div className="compare-divider" style={{ left: `${split}%` }} />
      {stale && <div className="preview-stale">{liveToneFilter ? "Live preview - update to render" : "Preview needs update"}</div>}
      <div className="zoom-controls" aria-label="Preview zoom controls">
        <button
          aria-pressed={previewMode === "compare"}
          className={previewMode === "compare" ? "active" : ""}
          onClick={() => setPreviewMode("compare")}
          title="Compare before and after"
          type="button"
        >
          <MoveHorizontal aria-hidden="true" size={16} />
          <span>Preview</span>
        </button>
        <button
          aria-pressed={isPanMode}
          className={isPanMode ? "active" : ""}
          disabled={zoom <= 1}
          onClick={() => setPreviewMode("pan")}
          title={zoom <= 1 ? "Zoom in to pan around the preview" : "Pan around the zoomed preview"}
          type="button"
        >
          <Hand aria-hidden="true" size={16} />
          <span>Pan</span>
        </button>
        <button onClick={() => setZoom((value) => Math.max(1, Number((value - 0.25).toFixed(2))))} title="Zoom out" type="button">
          -
        </button>
        <span>{Math.round(zoom * 100)}%</span>
        <button onClick={() => setZoom((value) => Math.min(4, Number((value + 0.25).toFixed(2))))} title="Zoom in" type="button">
          +
        </button>
        <button onClick={resetView} title="Reset zoom and position" type="button">
          Reset
        </button>
      </div>
      <input
        aria-label={`Compare original and optimized ${job.originalFilename}`}
        className="compare-slider"
        max="100"
        min="0"
        onChange={(event) => setSplit(Number(event.target.value))}
        type="range"
        value={split}
      />
      <div className="compare-label before">Original</div>
      <div className="compare-label after">Optimized</div>
    </div>
  );
}

function App() {
  const [preset, setPreset] = React.useState<Preset>("balanced");
  const [formats, setFormats] = React.useState<OutputFormat[]>(["original"]);
  const [resizeEnabled, setResizeEnabled] = React.useState(false);
  const [resizeMethod, setResizeMethod] = React.useState<ResizeMethod>("fit");
  const [resizeKernel, setResizeKernel] = React.useState<ResizeKernel>("lanczos3");
  const [width, setWidth] = React.useState("");
  const [height, setHeight] = React.useState("");
  const [autoResizeField, setAutoResizeField] = React.useState<"width" | "height" | null>(null);
  const [denoise, setDenoise] = React.useState("0");
  const [sharpen, setSharpen] = React.useState("0");
  const [brightness, setBrightness] = React.useState("0");
  const [contrast, setContrast] = React.useState("0");
  const [background, setBackground] = React.useState("#ffffff");
  const [preserveMetadata, setPreserveMetadata] = React.useState(false);
  const [isDragging, setIsDragging] = React.useState(false);
  const [adjustmentsOpen] = React.useState(() => typeof window === "undefined" || window.matchMedia("(min-width: 901px)").matches);
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [isReprocessing, setIsReprocessing] = React.useState(false);
  const [pendingImages, setPendingImages] = React.useState<PendingImage[]>([]);
  const [jobs, setJobs] = React.useState<JobResult[]>([]);
  const [progress, setProgress] = React.useState<{ done: number; total: number; current?: string } | null>(null);
  const [serverInfo, setServerInfo] = React.useState<ServerInfo>({ localOnly: true, engines: [] });
  const zipUrl = React.useMemo(() => zipUrlFor(jobs), [jobs]);

  React.useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((payload) => {
        const tools = Array.isArray(payload.specialistTools) ? payload.specialistTools : [];
        const bundled = Array.isArray(payload.bundledEngines) ? payload.bundledEngines : [];
        const engines = [...bundled, ...tools]
          .filter((tool: { available?: boolean }) => tool.available)
          .map((tool: { name: string }) => tool.name);
        setServerInfo({
          localOnly: payload.localOnly !== false,
          maxUploadMb: payload.limits?.maxUploadMb,
          retentionHours: payload.limits?.retentionHours,
          engines
        });
      })
      .catch(() => undefined);
  }, []);

  const aspectSource = React.useMemo(() => {
    const pending = pendingImages.find((item) => item.width && item.height);
    if (pending) return pending;
    return jobs.find((job) => job.input.width && job.input.height)?.input;
  }, [jobs, pendingImages]);

  React.useEffect(() => {
    if (!aspectSource?.width || !aspectSource.height) return;
    if (width && !height) {
      setHeight(proportionalSize(width, aspectSource.width, aspectSource.height));
      setAutoResizeField("height");
    }
    if (height && !width) {
      setWidth(proportionalSize(height, aspectSource.height, aspectSource.width));
      setAutoResizeField("width");
    }
  }, [aspectSource?.height, aspectSource?.width, height, width]);

  const options = React.useMemo<ProcessOptions>(
    () => ({
      preset,
      formats,
      preserve: preserveMetadata ? ["copyright", "creation", "location"] : [],
      transform: { background },
      resize: resizeEnabled
        ? {
            method: resizeMethod,
            width: width ? Number(width) : undefined,
            height: height ? Number(height) : undefined,
            kernel: resizeKernel
          }
        : undefined,
      enhance: {
        denoise: Number(denoise),
        sharpen: Number(sharpen),
        brightness: Number(brightness),
        contrast: Number(contrast)
      }
    }),
    [background, brightness, contrast, denoise, formats, height, preserveMetadata, preset, resizeEnabled, resizeKernel, resizeMethod, sharpen, width]
  );
  const optionsKey = React.useMemo(() => JSON.stringify(options), [options]);
  const [processedOptionsKey, setProcessedOptionsKey] = React.useState(optionsKey);
  const processedOptions = React.useMemo<ProcessOptions>(() => {
    try {
      return JSON.parse(processedOptionsKey) as ProcessOptions;
    } catch {
      return options;
    }
  }, [options, processedOptionsKey]);
  const liveTone = React.useMemo(() => toneFilter(options, processedOptions), [options, processedOptions]);
  const hasStaleResults = jobs.length > 0 && (processedOptionsKey !== optionsKey || liveTone.active);
  const liveToneFilter = jobs.length > 0 && liveTone.active ? liveTone.filter : undefined;
  const updateLabel = liveTone.active ? "Apply preview" : "Apply new settings";
  const adjustmentsChanged =
    denoise !== "0" || sharpen !== "0" || brightness !== "0" || contrast !== "0" || background.toLowerCase() !== "#ffffff" || preserveMetadata;

  function addPendingImages(files: FileList | File[]) {
    const selected = Array.from(files).filter((file) => file.type.startsWith("image/") || /\.(jxl|heic|heif|apng)$/i.test(file.name));
    if (!selected.length) return;

    const items = selected.map((file) => ({
      id: pendingId(),
      file,
      previewUrl: URL.createObjectURL(file)
    }));
    setPendingImages((current) => [...items, ...current]);
    setIsDragging(false);

    items.forEach((item) => {
      readImageDimensions(item.previewUrl)
        .then((dimensions) => {
          setPendingImages((current) => current.map((candidate) => (candidate.id === item.id ? { ...candidate, ...dimensions } : candidate)));
        })
        .catch(() => undefined);
    });
  }

  function clearPendingImages() {
    pendingImages.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setPendingImages([]);
  }

  async function optimizePendingImages() {
    if (!pendingImages.length || isProcessing || isReprocessing) return;
    // Oldest first, one request per image: results appear as they finish, a single bad file
    // can't sink the whole batch, and the server never holds the whole batch in memory.
    const queue = [...pendingImages].reverse();
    const requestOptions = JSON.stringify(options);
    setIsProcessing(true);
    setProcessedOptionsKey(optionsKey);

    try {
      for (const [index, item] of queue.entries()) {
        setProgress({ done: index, total: queue.length, current: item.file.name });
        const formData = new FormData();
        formData.append("options", requestOptions);
        formData.append("images", item.file);
        let result: JobResult[];
        try {
          const response = await fetch("/api/jobs", { method: "POST", body: formData });
          result = response.ok
            ? ((await response.json()) as BatchResponse).jobs
            : [errorJob(item.file, await readError(response, "Could not optimize this image"))];
        } catch {
          result = [errorJob(item.file, "Lost connection to the optimizer. Check the server is still running.")];
        }
        setJobs((current) => [...result, ...current]);
        URL.revokeObjectURL(item.previewUrl);
        setPendingImages((current) => current.filter((candidate) => candidate.id !== item.id));
      }
    } finally {
      setProgress(null);
      setIsProcessing(false);
      setIsDragging(false);
    }
  }

  function removePending(id: string) {
    setPendingImages((current) => {
      const item = current.find((candidate) => candidate.id === id);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return current.filter((candidate) => candidate.id !== id);
    });
  }

  function removeJob(id: string) {
    setJobs((current) => current.filter((job) => job.id !== id));
  }

  const reprocessResults = React.useCallback(async (): Promise<JobResult[]> => {
    if (!jobs.length) return [];
    setIsReprocessing(true);
    try {
      const updated: JobResult[] = [];
      for (const [index, job] of jobs.entries()) {
        setProgress({ done: index, total: jobs.length, current: job.originalFilename });
        if (job.id.startsWith("error-")) {
          updated.push(job);
          continue;
        }
        try {
          const response = await fetch(`/api/jobs/${job.id}/reprocess`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ options })
          });
          updated.push(
            response.ok
              ? ((await response.json()) as JobResult)
              : { ...job, status: "error", variants: [], error: await readError(response, "Could not update this image") }
          );
        } catch {
          updated.push({ ...job, status: "error", variants: [], error: "Lost connection to the optimizer." });
        }
      }
      // Merge by id so anything added meanwhile isn't overwritten by this snapshot.
      const replacements = new Map(jobs.map((job, index) => [job.id, updated[index]]));
      setJobs((current) => current.map((job) => replacements.get(job.id) ?? job));
      setProcessedOptionsKey(optionsKey);
      return updated;
    } finally {
      setProgress(null);
      setIsReprocessing(false);
    }
  }, [jobs, options, optionsKey]);

  async function currentJobsForDownload() {
    if (!hasStaleResults) return jobs;
    return reprocessResults();
  }

  function startDownload(url?: string) {
    if (!url) return;
    window.location.assign(url);
  }

  const isBusy = isProcessing || isReprocessing;

  async function downloadAll(event: React.MouseEvent<HTMLAnchorElement>) {
    if (isBusy) {
      event.preventDefault();
      return;
    }
    if (!hasStaleResults) return;
    event.preventDefault();
    const updated = await currentJobsForDownload();
    startDownload(zipUrlFor(updated));
  }

  async function downloadVariant(event: React.MouseEvent<HTMLAnchorElement>, jobIndex: number, variantId: string, fallbackUrl: string) {
    if (isBusy && hasStaleResults) {
      event.preventDefault();
      return;
    }
    if (!hasStaleResults) return;
    event.preventDefault();
    const updated = await currentJobsForDownload();
    const clickedJob = jobs[jobIndex];
    const updatedJob =
      updated.find((job) => job.id === clickedJob?.id) ||
      updated.find((job) => job.originalFilename === clickedJob?.originalFilename) ||
      updated[jobIndex];
    const clickedVariant = clickedJob?.variants.find((variant) => variant.id === variantId);
    const replacement =
      updatedJob?.variants.find((variant) => variant.format === clickedVariant?.format) ||
      (updatedJob ? bestVariant(updatedJob) : undefined);
    startDownload(replacement?.downloadUrl || fallbackUrl);
  }

  function toggleFormat(format: OutputFormat) {
    setFormats((current) => {
      if (current.includes(format)) {
        const next = current.filter((item) => item !== format);
        return next.length ? next : ["original"];
      }
      return [...current, format];
    });
  }

  function updateResizeWidth(value: string) {
    setWidth(value);
    if (!value) {
      if (autoResizeField === "height") setHeight("");
      setAutoResizeField(null);
      return;
    }

    if (aspectSource?.width && aspectSource.height && (!height || autoResizeField === "height")) {
      setHeight(proportionalSize(value, aspectSource.width, aspectSource.height));
      setAutoResizeField("height");
    } else {
      setAutoResizeField(null);
    }
  }

  function updateResizeHeight(value: string) {
    setHeight(value);
    if (!value) {
      if (autoResizeField === "width") setWidth("");
      setAutoResizeField(null);
      return;
    }

    if (aspectSource?.width && aspectSource.height && (!width || autoResizeField === "width")) {
      setWidth(proportionalSize(value, aspectSource.height, aspectSource.width));
      setAutoResizeField("width");
    } else {
      setAutoResizeField(null);
    }
  }

  function clearAll() {
    clearPendingImages();
    setJobs([]);
    setProcessedOptionsKey(optionsKey);
  }

  const totals = jobs.reduce(
    (acc, job) => {
      const variant = bestVariant(job);
      if (job.status !== "done" || !variant) return acc;
      acc.input += job.input.size;
      acc.output += variant.size;
      acc.done += 1;
      return acc;
    },
    { input: 0, output: 0, done: 0 }
  );
  const totalSavings = totals.input ? 1 - totals.output / totals.input : 0;
  const pendingBytes = pendingImages.reduce((total, item) => total + item.file.size, 0);

  return (
    <main className="app-shell">
      <section className="workspace">
        <aside className="controls" aria-label="Optimization settings">
          <div className="brand-row">
            <div className="mark" aria-hidden="true"><Wand2 size={22} /></div>
            <div>
              <h1>Image Optimizer Studio</h1>
              <p>Batch compression, conversion, and previews</p>
            </div>
          </div>

          <div className="control-group" role="group" aria-labelledby="preset-label">
            <span className="group-label" id="preset-label">Preset</span>
            <div className="segmented">
              {presetOptions.map((item) => (
                <button
                  aria-pressed={preset === item.value}
                  className={preset === item.value ? "active" : ""}
                  key={item.value}
                  onClick={() => setPreset(item.value)}
                  title={item.title}
                  type="button"
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="hint">{presetOptions.find((item) => item.value === preset)?.title}</p>
          </div>

          <div className="control-group" role="group" aria-labelledby="output-label">
            <span className="group-label" id="output-label">Output formats</span>
            <div className="format-grid">
              {outputFormats.map((format) => (
                <button
                  aria-pressed={formats.includes(format.value)}
                  className={formats.includes(format.value) ? "active" : ""}
                  key={format.value}
                  onClick={() => toggleFormat(format.value)}
                  title={format.title}
                  type="button"
                >
                  {format.label}
                </button>
              ))}
            </div>
          </div>

          <div className="engine-status" title={serverInfo.engines.length ? `Extra engines: ${serverInfo.engines.join(", ")}` : "Using the built-in Sharp/libvips encoders"}>
            <span>Engines</span>
            <strong>{serverInfo.engines.length ? `Built-in + ${serverInfo.engines.length} extra` : "Built-in"}</strong>
          </div>

          <div className="control-group">
            <div className="inline-label">
              <label htmlFor="resize">Resize</label>
              <input id="resize" checked={resizeEnabled} onChange={(event) => setResizeEnabled(event.target.checked)} type="checkbox" />
            </div>
            <div className="resize-grid">
              <select aria-label="Resize method" disabled={!resizeEnabled} onChange={(event) => setResizeMethod(event.target.value as ResizeMethod)} value={resizeMethod}>
                <option value="fit">Fit</option>
                <option value="cover">Cover</option>
                <option value="thumb">Smart thumb</option>
                <option value="scale">Scale</option>
              </select>
              <select aria-label="Resize quality" disabled={!resizeEnabled} onChange={(event) => setResizeKernel(event.target.value as ResizeKernel)} value={resizeKernel}>
                {resizeQualityOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <input disabled={!resizeEnabled} min="1" onChange={(event) => updateResizeWidth(event.target.value)} placeholder="Width" aria-label="Width in pixels" type="number" value={width} />
              <input disabled={!resizeEnabled} min="1" onChange={(event) => updateResizeHeight(event.target.value)} placeholder="Height" aria-label="Height in pixels" type="number" value={height} />
            </div>
          </div>

          <details className="adjustments" open={adjustmentsOpen}>
            <summary>
              <span>Adjustments</span>
              {adjustmentsChanged && <span className="badge">Modified</span>}
            </summary>
            <div className="adjustments-body">
          <div className="control-group">
            <label htmlFor="denoise">Noise reduction</label>
            <div className="range-row">
              <input id="denoise" max="10" min="0" onChange={(event) => setDenoise(event.target.value)} onDoubleClick={() => setDenoise("0")} title="Double-click to reset" type="range" value={denoise} />
              <output htmlFor="denoise">{denoise}</output>
            </div>
          </div>

          <div className="control-group">
            <label htmlFor="brightness">Brightness</label>
            <div className="range-row">
              <input id="brightness" max="50" min="-50" onChange={(event) => setBrightness(event.target.value)} onDoubleClick={() => setBrightness("0")} title="Double-click to reset" type="range" value={brightness} />
              <output htmlFor="brightness">{formatSigned(brightness)}</output>
            </div>
          </div>

          <div className="control-group">
            <label htmlFor="contrast">Contrast</label>
            <div className="range-row">
              <input id="contrast" max="50" min="-50" onChange={(event) => setContrast(event.target.value)} onDoubleClick={() => setContrast("0")} title="Double-click to reset" type="range" value={contrast} />
              <output htmlFor="contrast">{formatSigned(contrast)}</output>
            </div>
          </div>

          <div className="control-group">
            <label htmlFor="sharpen">Sharpen</label>
            <div className="range-row">
              <input id="sharpen" max="10" min="0" onChange={(event) => setSharpen(event.target.value)} onDoubleClick={() => setSharpen("0")} title="Double-click to reset" type="range" value={sharpen} />
              <output htmlFor="sharpen">{sharpen}</output>
            </div>
          </div>

          <div className="control-group">
            <label htmlFor="background">Transparency fill</label>
            <div className="color-row">
              <input id="background" className="color-field" onChange={(event) => setBackground(event.target.value)} type="color" value={background} />
              <span>{background.toUpperCase()}</span>
              <small>Used when converting transparent images to JPEG</small>
            </div>
          </div>

          <div className="control-group compact-row">
            <Settings2 aria-hidden="true" size={18} />
            <label htmlFor="metadata">Preserve metadata</label>
            <input id="metadata" checked={preserveMetadata} onChange={(event) => setPreserveMetadata(event.target.checked)} type="checkbox" />
          </div>
            </div>
          </details>
        </aside>

        <section className="main-panel">
          {!serverInfo.localOnly && (
            <div className="host-notice" role="note">
              <Info aria-hidden="true" size={17} />
              <span>
                Hosted version: images up to {serverInfo.maxUploadMb ?? "?"} MB, processed one at a time, and deleted after{" "}
                {serverInfo.retentionHours && serverInfo.retentionHours < 1 ? `${Math.round(serverInfo.retentionHours * 60)} minutes` : `${serverInfo.retentionHours ?? 1} hour${serverInfo.retentionHours === 1 ? "" : "s"}`}
                . For big batches or large photos, run the app locally.
              </span>
            </div>
          )}
          <div
            className={`dropzone ${isDragging ? "dragging" : ""}`}
            onDragLeave={() => setIsDragging(false)}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDrop={(event) => {
              event.preventDefault();
              addPendingImages(event.dataTransfer.files);
            }}
          >
            <input
              id="file-picker"
              multiple
              onChange={(event) => {
                if (event.target.files) addPendingImages(event.target.files);
                event.target.value = "";
              }}
              type="file"
              accept="image/*,.jxl,.heic,.heif,.apng"
            />
            <label htmlFor="file-picker">
              <ImagePlus aria-hidden="true" size={30} />
              <span className="dropzone-title">{isDragging ? "Drop to add" : "Drop images here or choose files"}</span>
              <span className="dropzone-hint">JPEG, PNG, WebP, AVIF, GIF, HEIC and JPEG XL. Files are queued so you can adjust settings first.</span>
            </label>
          </div>

          {(pendingImages.length > 0 || (progress && isProcessing)) && (
            <div className="queue-strip" aria-label="Queued images">
              <div>
                <strong>{progress && isProcessing ? `Optimizing ${progress.done + 1} of ${progress.total}` : `${pendingImages.length} queued`}</strong>
                <span>{progress && isProcessing ? progress.current : `${formatBytes(pendingBytes)} ready`}</span>
              </div>
              <div className="queue-files">
                {pendingImages.slice(0, 4).map((item) => (
                  <span className="queue-chip" key={item.id}>
                    <span>{item.file.name}</span>
                    {!isProcessing && (
                      <button aria-label={`Remove ${item.file.name} from the queue`} onClick={() => removePending(item.id)} type="button">
                        <X aria-hidden="true" size={13} />
                      </button>
                    )}
                  </span>
                ))}
                {pendingImages.length > 4 && <span className="queue-chip">+{pendingImages.length - 4} more</span>}
              </div>
              <button className="action-button attention" disabled={isBusy || !pendingImages.length} onClick={optimizePendingImages} type="button">
                <Wand2 aria-hidden="true" size={17} />
                {isProcessing ? "Optimizing..." : `Optimize ${pendingImages.length > 1 ? `${pendingImages.length} images` : ""}`.trim()}
              </button>
              {progress && isProcessing && (
                <div
                  aria-label="Optimization progress"
                  aria-valuemax={progress.total}
                  aria-valuemin={0}
                  aria-valuenow={progress.done}
                  className="progress-track"
                  role="progressbar"
                >
                  <div style={{ width: `${Math.max(4, (progress.done / progress.total) * 100)}%` }} />
                </div>
              )}
            </div>
          )}

          <div className="stats-band">
            <div>
              <strong>{totals.done}</strong>
              <span>optimized</span>
            </div>
            <div>
              <strong>{formatBytes(totals.input)}</strong>
              <span>original</span>
            </div>
            <div>
              <strong>{formatBytes(totals.output)}</strong>
              <span>now</span>
            </div>
            <div>
              <strong>{Math.abs(Math.round(totalSavings * 100))}%</strong>
              <span>{totalSavings >= 0 ? "saved" : "larger"}</span>
            </div>
            <div className={`stat-actions ${jobs.length || pendingImages.length ? "" : "is-empty"}`}>
              {jobs.length > 0 && hasStaleResults && (
                <button className="action-button attention" disabled={isReprocessing || isProcessing} onClick={reprocessResults} title="Re-run the results with the current settings" type="button">
                  <RefreshCw aria-hidden="true" size={17} />
                  {isReprocessing && progress ? `Updating ${progress.done + 1}/${progress.total}` : updateLabel}
                </button>
              )}
              {zipUrl && (
                <a
                  aria-disabled={isBusy}
                  className={`action-button ${isBusy ? "is-disabled" : ""}`}
                  href={zipUrl}
                  onClick={downloadAll}
                  title={isBusy ? "Wait for processing to finish" : hasStaleResults ? "Apply current settings and download all as a ZIP" : "Download all as a ZIP"}
                >
                  <FileArchive aria-hidden="true" size={17} />
                  Download all
                </a>
              )}
              {(jobs.length > 0 || pendingImages.length > 0) && (
                <button aria-label="Clear queue and results" className="icon-button" disabled={isProcessing || isReprocessing} onClick={clearAll} title="Clear queue and results" type="button">
                  <RotateCcw aria-hidden="true" size={19} />
                </button>
              )}
            </div>
          </div>

          <div className="results">
            {jobs.length === 0 ? (
              <div className="empty-state">{pendingImages.length ? "Choose your settings, then press Optimize to process the queued files." : "Optimized files, conversion variants, quality metrics, and downloads will appear here."}</div>
            ) : (
              jobs.map((job, jobIndex) => {
                const variant = bestVariant(job);
                return (
                  <article className={`result-card ${job.status === "error" ? "is-error" : ""}`} key={job.id}>
                    {job.status !== "error" && <ComparePreview job={job} liveToneFilter={liveToneFilter} stale={hasStaleResults || isReprocessing} variant={variant} />}
                    <div className="file-meta">
                      <strong title={job.originalFilename}>{job.originalFilename}</strong>
                      <span>
                        {job.input.width && job.input.height ? `${job.input.width} × ${job.input.height}` : job.input.type} · {formatBytes(job.input.size)}
                      </span>
                    </div>
                    <button aria-label={`Remove ${job.originalFilename} from results`} className="remove-result" disabled={isReprocessing} onClick={() => removeJob(job.id)} title="Remove from results" type="button">
                      <X aria-hidden="true" size={16} />
                    </button>
                    {job.status === "error" ? (
                      <p className="error-text">{job.error}</p>
                    ) : (
                      <>
                        <div className={`savings-pill ${variant && variant.savings < 0 ? "larger" : ""}`}>{variant ? formatSavings(variant.savings) : "optimized"}</div>
                        {job.notes?.map((note) => (
                          <p className="note-text" key={note}>
                            {note}
                          </p>
                        ))}
                        <div className="variant-list">
                          {job.variants.map((item) => (
                            <a
                              className="variant-row"
                              href={item.downloadUrl}
                              key={item.id}
                              onClick={(event) => downloadVariant(event, jobIndex, item.id, item.downloadUrl)}
                              title={hasStaleResults ? "Apply current settings and download" : `Download ${item.filename}`}
                            >
                              <span className="variant-format">{item.metrics?.autoSelected ? `Auto · ${item.format.toUpperCase()}` : item.format.toUpperCase()}</span>
                              <span>{formatBytes(item.size)}</span>
                              <span title={item.metrics?.ssim ? `Structural similarity (SSIM ${item.metrics.ssim}) measured at thumbnail scale` : undefined}>{formatSimilarity(item.metrics?.ssim)}</span>
                              <Download aria-hidden="true" size={17} />
                            </a>
                          ))}
                        </div>
                      </>
                    )}
                  </article>
                );
              })
            )}
          </div>
        </section>
      </section>
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
