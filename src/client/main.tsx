import React from "react";
import ReactDOM from "react-dom/client";
import { Download, FileArchive, Hand, ImagePlus, MoveHorizontal, RefreshCw, RotateCcw, Settings2, Wand2 } from "lucide-react";
import type { BatchResponse, JobResult, OutputFormat, Preset, ProcessOptions, ResizeKernel, ResizeMethod } from "../shared/types";
import "./styles.css";

const outputFormats: Array<{ value: OutputFormat; label: string }> = [
  { value: "auto", label: "Auto" },
  { value: "original", label: "Original" },
  { value: "avif", label: "AVIF" },
  { value: "webp", label: "WebP" },
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "jxl", label: "JXL" }
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
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [isReprocessing, setIsReprocessing] = React.useState(false);
  const [pendingImages, setPendingImages] = React.useState<PendingImage[]>([]);
  const [jobs, setJobs] = React.useState<JobResult[]>([]);
  const [zipUrl, setZipUrl] = React.useState<string>();
  const [engineStatus, setEngineStatus] = React.useState<{ active: number; label: string }>({ active: 0, label: "Built-in race" });

  React.useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then((payload) => {
        const tools = Array.isArray(payload.specialistTools) ? payload.specialistTools : [];
        const bundled = Array.isArray(payload.bundledEngines) ? payload.bundledEngines : [];
        const activeTools = tools.filter((tool: { available?: boolean }) => tool.available).length;
        const activeBundled = bundled.filter((tool: { available?: boolean }) => tool.available).length;
        const active = activeTools + activeBundled;
        setEngineStatus({
          active,
          label: active ? `${active} active add-ons` : "Built-in race"
        });
      })
      .catch(() => setEngineStatus({ active: 0, label: "Built-in race" }));
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
  const updateLabel = liveTone.active ? "Apply Preview" : "Update";

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
    if (!pendingImages.length) return;
    const formData = new FormData();
    pendingImages.forEach((item) => formData.append("images", item.file));
    formData.append("options", JSON.stringify(options));
    setIsProcessing(true);

    try {
      const response = await fetch("/api/jobs", { method: "POST", body: formData });
      const payload = (await response.json()) as BatchResponse;
      setJobs((current) => [...payload.jobs, ...current]);
      setZipUrl(payload.zipUrl);
      setProcessedOptionsKey(optionsKey);
      clearPendingImages();
    } finally {
      setIsProcessing(false);
      setIsDragging(false);
    }
  }

  const reprocessResults = React.useCallback(async (): Promise<JobResult[]> => {
    if (!jobs.length) return [];
    setIsReprocessing(true);
    try {
      const updated: JobResult[] = [];
      for (const job of jobs) {
        const response = await fetch(`/api/jobs/${job.id}/reprocess`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ options })
        });
        updated.push((await response.json()) as JobResult);
      }
      setJobs(updated);
      setZipUrl(updated.some((job) => job.variants.length) ? "/api/download.zip" : undefined);
      setProcessedOptionsKey(optionsKey);
      return updated;
    } finally {
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

  async function downloadAll(event: React.MouseEvent<HTMLAnchorElement>) {
    if (!hasStaleResults) return;
    event.preventDefault();
    const updated = await currentJobsForDownload();
    if (updated.some((job) => job.variants.length)) {
      startDownload("/api/download.zip");
    }
  }

  async function downloadVariant(event: React.MouseEvent<HTMLAnchorElement>, jobIndex: number, variantId: string, fallbackUrl: string) {
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
    setZipUrl(undefined);
    setProcessedOptionsKey(optionsKey);
  }

  const totals = jobs.reduce(
    (acc, job) => {
      const variant = bestVariant(job);
      acc.input += job.input.size;
      acc.output += variant?.size || 0;
      acc.done += job.status === "done" ? 1 : 0;
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
            <div className="mark"><Wand2 size={22} /></div>
            <div>
              <h1>Local Tiny Optimizer</h1>
              <p>Private batch compression and conversion</p>
            </div>
          </div>

          <div className="control-group">
            <label>Preset</label>
            <div className="segmented">
              {presetOptions.map((item) => (
                <button className={preset === item.value ? "active" : ""} key={item.value} onClick={() => setPreset(item.value)} title={item.title} type="button">
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <div className="control-group">
            <label>Output</label>
            <div className="format-grid">
              {outputFormats.map((format) => (
                <button className={formats.includes(format.value) ? "active" : ""} key={format.value} onClick={() => toggleFormat(format.value)} type="button">
                  {format.label}
                </button>
              ))}
            </div>
          </div>

          <div className="engine-status">
            <span>Engine</span>
            <strong>{engineStatus.label}</strong>
          </div>

          <div className="control-group">
            <div className="inline-label">
              <label htmlFor="resize">Resize</label>
              <input id="resize" checked={resizeEnabled} onChange={(event) => setResizeEnabled(event.target.checked)} type="checkbox" />
            </div>
            <div className="resize-grid">
              <select disabled={!resizeEnabled} onChange={(event) => setResizeMethod(event.target.value as ResizeMethod)} value={resizeMethod}>
                <option value="fit">Fit</option>
                <option value="cover">Cover</option>
                <option value="thumb">Smart thumb</option>
                <option value="scale">Scale</option>
              </select>
              <select disabled={!resizeEnabled} onChange={(event) => setResizeKernel(event.target.value as ResizeKernel)} value={resizeKernel}>
                {resizeQualityOptions.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <input disabled={!resizeEnabled} min="1" onChange={(event) => updateResizeWidth(event.target.value)} placeholder="Width" type="number" value={width} />
              <input disabled={!resizeEnabled} min="1" onChange={(event) => updateResizeHeight(event.target.value)} placeholder="Height" type="number" value={height} />
            </div>
          </div>

          <div className="control-group">
            <label>Noise</label>
            <div className="range-row">
              <input max="10" min="0" onChange={(event) => setDenoise(event.target.value)} type="range" value={denoise} />
              <output>{denoise}</output>
            </div>
          </div>

          <div className="control-group">
            <label>Brightness</label>
            <div className="range-row">
              <input max="50" min="-50" onChange={(event) => setBrightness(event.target.value)} type="range" value={brightness} />
              <output>{formatSigned(brightness)}</output>
            </div>
          </div>

          <div className="control-group">
            <label>Contrast</label>
            <div className="range-row">
              <input max="50" min="-50" onChange={(event) => setContrast(event.target.value)} type="range" value={contrast} />
              <output>{formatSigned(contrast)}</output>
            </div>
          </div>

          <div className="control-group">
            <label>Sharpen</label>
            <div className="range-row">
              <input max="10" min="0" onChange={(event) => setSharpen(event.target.value)} type="range" value={sharpen} />
              <output>{sharpen}</output>
            </div>
          </div>

          <div className="control-group">
            <label>Transparency Fill</label>
            <input aria-label="Background color" className="color-field" onChange={(event) => setBackground(event.target.value)} type="color" value={background} />
          </div>

          <div className="control-group compact-row">
            <Settings2 size={18} />
            <label htmlFor="metadata">Preserve metadata</label>
            <input id="metadata" checked={preserveMetadata} onChange={(event) => setPreserveMetadata(event.target.checked)} type="checkbox" />
          </div>
        </aside>

        <section className="main-panel">
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
              <ImagePlus size={34} />
              <span>{pendingImages.length ? `${pendingImages.length} queued - adjust settings, then Optimize` : "Drop images here or choose files"}</span>
            </label>
          </div>

          {pendingImages.length > 0 && (
            <div className="queue-strip" aria-label="Queued images">
              <div>
                <strong>{pendingImages.length} queued</strong>
                <span>{formatBytes(pendingBytes)} ready</span>
              </div>
              <div className="queue-files">
                {pendingImages.slice(0, 4).map((item) => (
                  <span key={item.id}>{item.file.name}</span>
                ))}
                {pendingImages.length > 4 && <span>+{pendingImages.length - 4} more</span>}
              </div>
              <button className="action-button attention" disabled={isProcessing} onClick={optimizePendingImages} type="button">
                <Wand2 size={17} />
                {isProcessing ? "Optimizing" : "Optimize"}
              </button>
            </div>
          )}

          <div className="stats-band">
            <div>
              <strong>{pendingImages.length || jobs.length}</strong>
              <span>{pendingImages.length ? "queued" : "processed"}</span>
            </div>
            <div>
              <strong>{formatBytes(totals.input)}</strong>
              <span>original</span>
            </div>
            <div>
              <strong>{formatBytes(totals.output)}</strong>
              <span>optimized</span>
            </div>
            <div>
              <strong>{Math.abs(Math.round(totalSavings * 100))}%</strong>
              <span>{totalSavings >= 0 ? "saved" : "larger"}</span>
            </div>
            <div className="stat-actions">
              {jobs.length > 0 && (
                <button className={`action-button ${hasStaleResults ? "attention" : ""}`} disabled={isReprocessing || !hasStaleResults} onClick={reprocessResults} type="button">
                  <RefreshCw size={17} />
                  {isReprocessing ? "Updating" : updateLabel}
                </button>
              )}
              {zipUrl && (
                <a className="icon-button" href={zipUrl} onClick={downloadAll} title={hasStaleResults ? "Apply current settings and download all" : "Download all"}>
                  <FileArchive size={19} />
                </a>
              )}
              <button className="icon-button" onClick={clearAll} title="Clear results" type="button">
                <RotateCcw size={19} />
              </button>
            </div>
          </div>

          <div className="results">
            {jobs.length === 0 ? (
              <div className="empty-state">{pendingImages.length ? "Choose your settings, then press Optimize to process the queued files." : "Optimized files, conversion variants, quality metrics, and downloads will appear here."}</div>
            ) : (
              jobs.map((job, jobIndex) => {
                const variant = bestVariant(job);
                return (
                  <article className="result-card" key={job.id}>
                    <ComparePreview job={job} liveToneFilter={liveToneFilter} stale={hasStaleResults || isReprocessing} variant={variant} />
                    <div className="file-meta">
                      <strong>{job.originalFilename}</strong>
                      <span>{job.input.width && job.input.height ? `${job.input.width} x ${job.input.height}` : job.input.type}</span>
                    </div>
                    {job.status === "error" ? (
                      <p className="error-text">{job.error}</p>
                    ) : (
                      <>
                        <div className={`savings-pill ${variant && variant.savings < 0 ? "larger" : ""}`}>{variant ? formatSavings(variant.savings) : "optimized"}</div>
                        <div className="variant-list">
                          {job.variants.map((item) => (
                            <a
                              className="variant-row"
                              href={item.downloadUrl}
                              key={item.id}
                              onClick={(event) => downloadVariant(event, jobIndex, item.id, item.downloadUrl)}
                              title={hasStaleResults ? "Apply current settings and download" : "Download"}
                            >
                              <span>{item.metrics?.autoSelected ? `AUTO ${item.format.toUpperCase()}` : item.format.toUpperCase()}</span>
                              <span>{formatBytes(item.size)}</span>
                              <span>{item.metrics?.ssim ? `SSIM ${item.metrics.ssim}` : "metric pending"}</span>
                              <Download size={17} />
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
