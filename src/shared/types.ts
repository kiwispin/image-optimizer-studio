export type Preset = "balanced" | "smallest" | "fidelity" | "ultra";

export type OutputFormat = "auto" | "original" | "png" | "jpeg" | "webp" | "avif" | "jxl";

export type ResizeMethod = "scale" | "fit" | "cover" | "thumb";

export type ResizeKernel = "nearest" | "linear" | "cubic" | "mitchell" | "lanczos2" | "lanczos3";

export interface ResizeOptions {
  method: ResizeMethod;
  width?: number;
  height?: number;
  kernel?: ResizeKernel;
}

export interface TransformOptions {
  background?: string;
}

export interface EnhancementOptions {
  denoise?: number;
  sharpen?: number;
  brightness?: number;
  contrast?: number;
}

export interface ProcessOptions {
  preset: Preset;
  formats: OutputFormat[];
  resize?: ResizeOptions;
  preserve?: Array<"copyright" | "creation" | "location">;
  transform?: TransformOptions;
  enhance?: EnhancementOptions;
}

export interface OutputVariant {
  id: string;
  filename: string;
  size: number;
  type: string;
  width?: number;
  height?: number;
  savings: number;
  format: OutputFormat;
  downloadUrl: string;
  previewUrl: string;
  metrics?: {
    psnr?: number;
    ssim?: number;
    colorDelta?: number;
    contrastRatio?: number;
    saturationRatio?: number;
    sizeRatio: number;
    candidateCount?: number;
    selectedQuality?: number;
    targetSsim?: number;
    contentClass?: string;
    losslessFallback?: boolean;
    autoSelected?: boolean;
    autoCandidateFormats?: string[];
    externalOptimizer?: string;
  };
}

export interface JobResult {
  id: string;
  originalFilename: string;
  input: {
    size: number;
    type: string;
    width?: number;
    height?: number;
    previewUrl?: string;
  };
  status: "done" | "error";
  error?: string;
  variants: OutputVariant[];
}

export interface BatchResponse {
  jobs: JobResult[];
  zipUrl?: string;
}
