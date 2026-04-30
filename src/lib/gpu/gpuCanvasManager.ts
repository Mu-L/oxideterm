// Copyright (C) 2026 AnalyseDeCircuit
// SPDX-License-Identifier: GPL-3.0-only

import {
  drawTimelineLanesCanvas2D,
  drawVerticalBinsCanvas2D,
  resizeCanvasToDisplaySize,
  type GpuTimelineLanes,
} from './chartData';

export type GpuCanvasBackend =
  | { kind: 'webgpu'; adapterInfo?: unknown }
  | { kind: 'canvas2d' }
  | { kind: 'dom' };

export type GpuCanvasStatus =
  | 'disabled'
  | 'ready'
  | 'unsupported'
  | 'fallback'
  | 'failed';

export interface GpuCanvasDetection {
  status: GpuCanvasStatus;
  backend: GpuCanvasBackend;
  reason?: string;
  adapterInfo?: unknown;
}

export interface GpuCanvasRenderer {
  id: string;
  status: GpuCanvasStatus;
  backend: GpuCanvasBackend;
  renderVerticalBins(bins: Uint32Array): void;
  renderTimelineLanes(lanes: GpuTimelineLanes): void;
  renderMinimap(bins: Uint32Array): void;
  dispose(): void;
}

interface GpuNavigator {
  gpu?: {
    requestAdapter(): Promise<GpuAdapter | null>;
    getPreferredCanvasFormat(): string;
  };
}

interface GpuAdapter {
  requestDevice(): Promise<GpuDevice>;
  info?: unknown;
}

interface GpuDevice {
  createShaderModule(options: Record<string, unknown>): unknown;
  createBindGroupLayout(options: Record<string, unknown>): unknown;
  createPipelineLayout(options: Record<string, unknown>): unknown;
  createRenderPipeline(options: Record<string, unknown>): unknown;
  createBuffer(options: { size: number; usage: number }): GpuBuffer;
  createBindGroup(options: Record<string, unknown>): unknown;
  createCommandEncoder(): GpuCommandEncoder;
  queue: {
    writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBuffer | ArrayBufferView): void;
    submit(commands: unknown[]): void;
  };
}

interface GpuBuffer {
  destroy?: () => void;
}

interface GpuCommandEncoder {
  beginRenderPass(options: Record<string, unknown>): GpuRenderPass;
  finish(): unknown;
}

interface GpuRenderPass {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, bindGroup: unknown): void;
  draw(vertexCount: number): void;
  end(): void;
}

interface GpuCanvasContext {
  configure(options: Record<string, unknown>): void;
  getCurrentTexture(): { createView(): unknown };
}

const SHADER_SOURCE = `
struct Meta {
  width: f32,
  height: f32,
  binCount: f32,
  laneCount: f32,
  mode: f32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
}

struct Bins {
  values: array<u32>,
}

@group(0) @binding(0) var<storage, read> bins: Bins;
@group(0) @binding(1) var<uniform> meta: Meta;

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f( 1.0, -1.0),
    vec2f(-1.0,  1.0),
    vec2f(-1.0,  1.0),
    vec2f( 1.0, -1.0),
    vec2f( 1.0,  1.0),
  );
  return vec4f(positions[vertexIndex], 0.0, 1.0);
}

fn colorForFlags(flags: u32) -> vec4f {
  if ((flags & 4u) != 0u) {
    return vec4f(0.92, 0.72, 0.18, 0.96);
  }
  if ((flags & 64u) != 0u) {
    return vec4f(0.97, 0.44, 0.44, 0.90);
  }
  if ((flags & 32u) != 0u) {
    return vec4f(0.98, 0.75, 0.14, 0.76);
  }
  if ((flags & 16u) != 0u) {
    return vec4f(0.66, 0.33, 0.97, 0.72);
  }
  if ((flags & 2u) != 0u) {
    return vec4f(0.92, 0.72, 0.18, 0.62);
  }
  if ((flags & 8u) != 0u) {
    return vec4f(0.23, 0.51, 0.96, 0.66);
  }
  if ((flags & 1u) != 0u) {
    return vec4f(0.37, 0.65, 0.98, 0.30);
  }
  if ((flags & 128u) != 0u) {
    return vec4f(0.98, 0.75, 0.14, 0.40);
  }
  return vec4f(0.12, 0.16, 0.24, 0.24);
}

@fragment
fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let width = max(meta.width, 1.0);
  let height = max(meta.height, 1.0);
  let binCount = max(meta.binCount, 1.0);
  let laneCount = max(meta.laneCount, 1.0);
  var valueIndex: u32;

  if (meta.mode > 0.5) {
    let binIndex = min(u32((position.x / width) * binCount), u32(binCount - 1.0));
    let laneIndex = min(u32((position.y / height) * laneCount), u32(laneCount - 1.0));
    valueIndex = laneIndex * u32(binCount) + binIndex;
  } else {
    valueIndex = min(u32((position.y / height) * binCount), u32(binCount - 1.0));
  }

  return colorForFlags(bins.values[valueIndex]);
}
`;

function gpuNavigator(): GpuNavigator {
  return navigator as Navigator & GpuNavigator;
}

function gpuGlobals(): { bufferUsage?: Record<string, number>; shaderStage?: Record<string, number> } {
  const globals = globalThis as typeof globalThis & {
    GPUBufferUsage?: Record<string, number>;
    GPUShaderStage?: Record<string, number>;
  };
  return {
    bufferUsage: globals.GPUBufferUsage,
    shaderStage: globals.GPUShaderStage,
  };
}

function getWebGpuContext(canvas: HTMLCanvasElement): GpuCanvasContext | null {
  const withWebGpu = canvas as HTMLCanvasElement & {
    getContext(contextId: 'webgpu'): unknown;
  };
  return withWebGpu.getContext('webgpu') as GpuCanvasContext | null;
}

function flattenTimelineLanes(lanes: GpuTimelineLanes): Uint32Array {
  if (lanes.length === 0) return new Uint32Array(1);
  const binCount = Math.max(1, lanes[0]?.length ?? 1);
  const flattened = new Uint32Array(Math.max(1, lanes.length * binCount));
  lanes.forEach((lane, laneIndex) => {
    flattened.set(lane.slice(0, binCount), laneIndex * binCount);
  });
  return flattened;
}

class Canvas2dGpuCanvasRenderer implements GpuCanvasRenderer {
  constructor(
    public readonly id: string,
    private readonly canvas: HTMLCanvasElement,
    public readonly status: GpuCanvasStatus,
    public readonly backend: GpuCanvasBackend = { kind: 'canvas2d' },
  ) {}

  renderVerticalBins(bins: Uint32Array): void {
    drawVerticalBinsCanvas2D(this.canvas, bins);
  }

  renderTimelineLanes(lanes: GpuTimelineLanes): void {
    drawTimelineLanesCanvas2D(this.canvas, lanes);
  }

  renderMinimap(bins: Uint32Array): void {
    this.renderVerticalBins(bins);
  }

  dispose(): void {
    const context = this.canvas.getContext('2d');
    context?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

class WebGpuChartRenderer implements GpuCanvasRenderer {
  public readonly status: GpuCanvasStatus = 'ready';
  public readonly backend: GpuCanvasBackend;
  private binBuffer: GpuBuffer | null = null;
  private binCapacity = 0;
  private metaBuffer: GpuBuffer;
  private bindGroup: unknown = null;
  private configuredWidth = 0;
  private configuredHeight = 0;

  constructor(
    public readonly id: string,
    private readonly canvas: HTMLCanvasElement,
    private readonly context: GpuCanvasContext,
    private readonly device: GpuDevice,
    private readonly format: string,
    private readonly pipeline: unknown,
    private readonly bindGroupLayout: unknown,
    private readonly usage: Record<string, number>,
    adapterInfo?: unknown,
  ) {
    this.backend = { kind: 'webgpu', adapterInfo };
    this.metaBuffer = device.createBuffer({
      size: 8 * Float32Array.BYTES_PER_ELEMENT,
      usage: usage.UNIFORM | usage.COPY_DST,
    });
  }

  renderVerticalBins(bins: Uint32Array): void {
    this.renderBins(bins.length > 0 ? bins : new Uint32Array(1), bins.length, 1, 0);
  }

  renderTimelineLanes(lanes: GpuTimelineLanes): void {
    const binCount = Math.max(1, lanes[0]?.length ?? 1);
    const laneCount = Math.max(1, lanes.length);
    this.renderBins(flattenTimelineLanes(lanes), binCount, laneCount, 1);
  }

  renderMinimap(bins: Uint32Array): void {
    this.renderVerticalBins(bins);
  }

  dispose(): void {
    this.binBuffer?.destroy?.();
    this.metaBuffer.destroy?.();
    this.binBuffer = null;
    this.bindGroup = null;
  }

  private renderBins(values: Uint32Array, binCount: number, laneCount: number, mode: number): void {
    const { width, height } = resizeCanvasToDisplaySize(this.canvas);
    if (this.configuredWidth !== width || this.configuredHeight !== height) {
      this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
      this.configuredWidth = width;
      this.configuredHeight = height;
    }
    this.ensureBinBuffer(values.length);
    if (!this.binBuffer || !this.bindGroup) return;

    this.device.queue.writeBuffer(this.binBuffer, 0, values);
    this.device.queue.writeBuffer(
      this.metaBuffer,
      0,
      new Float32Array([width, height, Math.max(1, binCount), Math.max(1, laneCount), mode, 0, 0, 0]),
    );

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }

  private ensureBinBuffer(valueCount: number): void {
    if (this.binBuffer && this.binCapacity >= valueCount) return;
    this.binBuffer?.destroy?.();
    this.binCapacity = Math.max(1, valueCount);
    this.binBuffer = this.device.createBuffer({
      size: this.binCapacity * Uint32Array.BYTES_PER_ELEMENT,
      usage: this.usage.STORAGE | this.usage.COPY_DST,
    });
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.binBuffer } },
        { binding: 1, resource: { buffer: this.metaBuffer } },
      ],
    });
  }
}

export class GpuCanvasManager {
  private adapterPromise: Promise<GpuAdapter | null> | null = null;
  private devicePromise: Promise<GpuDevice | null> | null = null;
  private adapterInfo: unknown;
  private rendererCounter = 0;
  private readonly renderers = new Map<string, GpuCanvasRenderer>();

  async detect(): Promise<GpuCanvasDetection> {
    const nav = gpuNavigator();
    if (!nav.gpu) {
      return { status: 'unsupported', backend: { kind: 'canvas2d' }, reason: 'navigator.gpu unavailable' };
    }
    try {
      const adapter = await this.getAdapter();
      if (!adapter) {
        return { status: 'unsupported', backend: { kind: 'canvas2d' }, reason: 'WebGPU adapter unavailable' };
      }
      this.adapterInfo = adapter.info;
      const device = await this.getDevice();
      if (!device) {
        return { status: 'fallback', backend: { kind: 'canvas2d' }, reason: 'WebGPU device unavailable' };
      }
      return { status: 'ready', backend: { kind: 'webgpu', adapterInfo: adapter.info }, adapterInfo: adapter.info };
    } catch (caught) {
      return {
        status: 'failed',
        backend: { kind: 'canvas2d' },
        reason: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }

  async getDevice(): Promise<GpuDevice | null> {
    if (!this.devicePromise) {
      this.devicePromise = this.getAdapter()
        .then((adapter) => adapter?.requestDevice() ?? null)
        .catch(() => null);
    }
    return this.devicePromise;
  }

  async createRenderer(canvas: HTMLCanvasElement): Promise<GpuCanvasRenderer> {
    const id = `gpu-canvas-${++this.rendererCounter}`;
    const nav = gpuNavigator();
    const { bufferUsage, shaderStage } = gpuGlobals();
    if (!nav.gpu || !bufferUsage || !shaderStage) {
      const renderer = new Canvas2dGpuCanvasRenderer(id, canvas, 'unsupported');
      this.renderers.set(id, renderer);
      return renderer;
    }

    try {
      const device = await this.getDevice();
      const context = getWebGpuContext(canvas);
      if (!device || !context) {
        const renderer = new Canvas2dGpuCanvasRenderer(id, canvas, 'fallback');
        this.renderers.set(id, renderer);
        return renderer;
      }

      const format = nav.gpu.getPreferredCanvasFormat();
      const shaderModule = device.createShaderModule({ code: SHADER_SOURCE });
      const bindGroupLayout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: shaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
          { binding: 1, visibility: shaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        ],
      });
      const pipeline = device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
        vertex: { module: shaderModule, entryPoint: 'vertexMain' },
        fragment: {
          module: shaderModule,
          entryPoint: 'fragmentMain',
          targets: [{
            format,
            blend: {
              color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            },
          }],
        },
        primitive: { topology: 'triangle-list' },
      });
      const renderer = new WebGpuChartRenderer(
        id,
        canvas,
        context,
        device,
        format,
        pipeline,
        bindGroupLayout,
        bufferUsage,
        this.adapterInfo,
      );
      this.renderers.set(id, renderer);
      return renderer;
    } catch {
      const renderer = new Canvas2dGpuCanvasRenderer(id, canvas, 'failed');
      this.renderers.set(id, renderer);
      return renderer;
    }
  }

  disposeRenderer(id: string): void {
    const renderer = this.renderers.get(id);
    if (!renderer) return;
    renderer.dispose();
    this.renderers.delete(id);
  }

  rendererCount(): number {
    return this.renderers.size;
  }

  private async getAdapter(): Promise<GpuAdapter | null> {
    const nav = gpuNavigator();
    if (!nav.gpu) return null;
    if (!this.adapterPromise) {
      this.adapterPromise = nav.gpu.requestAdapter()
        .then((adapter) => {
          if (adapter) this.adapterInfo = adapter.info;
          return adapter;
        })
        .catch(() => null);
    }
    return this.adapterPromise;
  }
}

export const gpuCanvasManager = new GpuCanvasManager();
