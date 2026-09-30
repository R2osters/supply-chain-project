// src/rb/useOglFrame.test.ts — the shared WebGL lifecycle of the ogl components (spec § 3.7), run without a DOM:
// ogl and Remotion's render hold are replaced by fakes that record what the lifecycle does.
import {createOglFrame, type UniformsAt} from './useOglFrame';

const hold = vi.hoisted(() => ({
  delayRender: vi.fn((_label: string) => 42),
  continueRender: vi.fn((_handle: number) => undefined),
  cancelRender: vi.fn((error: unknown): never => {
    throw error;
  }),
}));
vi.mock('remotion', () => hold);

// What the fake GPU does, in order, plus the switches for the failure paths.
const gpu = vi.hoisted(() => ({log: [] as string[], linked: true, webgl: true, renderers: [] as Array<Record<string, any>>}));
vi.mock('ogl', () => {
  class Renderer {
    width: number;
    height: number;
    options: Record<string, unknown>;
    gl: Record<string, any>;
    constructor(options: {width: number; height: number; dpr: number}) {
      if (!gpu.webgl) throw new TypeError("Cannot set properties of null (setting 'renderer')");
      this.options = options;
      this.width = options.width;
      this.height = options.height;
      this.gl = {
        LINK_STATUS: 0x8b82,
        canvas: {width: Math.trunc(options.width * options.dpr), height: Math.trunc(options.height * options.dpr), style: {}},
        clearColor: () => gpu.log.push('clearColor'),
        getProgramParameter: () => gpu.linked,
        getProgramInfoLog: () => "ERROR: 0:12: 'uTme' : undeclared identifier",
        getExtension: (name: string) => (name === 'WEBGL_lose_context' ? {loseContext: () => gpu.log.push('loseContext')} : null),
      };
      gpu.renderers.push(this);
    }
    setSize(width: number, height: number): void {
      gpu.log.push(`setSize ${width}x${height}`);
      this.width = width;
      this.height = height;
      this.gl.canvas.width = Math.trunc(width);
      this.gl.canvas.height = Math.trunc(height);
    }
    render({scene}: {scene: {program: {uniforms: Record<string, {value: unknown}>}}}): void {
      const u = scene.program.uniforms;
      gpu.log.push(`render ${Object.keys(u).map((k) => `${k}=${String(u[k].value)}`).join(' ')}`);
    }
  }
  class Program {
    program = {};
    uniforms: Record<string, unknown>;
    constructor(_gl: unknown, options: {uniforms: Record<string, unknown>}) {
      this.uniforms = options.uniforms;
    }
  }
  class Mesh {
    program: Program;
    constructor(_gl: unknown, options: {program: Program}) {
      this.program = options.program;
    }
  }
  class Triangle {}
  return {Renderer, Program, Mesh, Triangle};
});

const SHADERS = {vertex: 'void main() {}', fragment: 'void main() {}'};
const container = () => ({appendChild: vi.fn(), removeChild: vi.fn()});
const asElement = (c: ReturnType<typeof container>): HTMLElement => c as unknown as HTMLElement;
const at = (t: number): UniformsAt => (canvas) => ({uTime: t, uResolution: [canvas.width, canvas.height]});
const renders = (): string[] => gpu.log.filter((l) => l.startsWith('render'));

beforeEach(() => {
  vi.clearAllMocks();
  gpu.log.length = 0;
  gpu.renderers.length = 0;
  gpu.linked = true;
  gpu.webgl = true;
});

describe('createOglFrame', () => {
  it('holds the render from creation until the first draw, then releases it once', () => {
    const ogl = createOglFrame('Radar');
    expect(hold.delayRender).toHaveBeenCalledTimes(1);
    expect(hold.delayRender.mock.calls[0][0]).toBe('Radar: compiling the WebGL program');
    ogl.mount(asElement(container()), SHADERS, 640, 360);
    expect(hold.continueRender).not.toHaveBeenCalled();
    ogl.draw(640, 360, at(0));
    expect(hold.continueRender).toHaveBeenCalledTimes(1);
    expect(hold.continueRender).toHaveBeenCalledWith(42);
    ogl.draw(640, 360, at(1 / 30));
    expect(hold.continueRender).toHaveBeenCalledTimes(1);
  });

  it('creates one context per mount that keeps its pixels, at 1 device px per CSS px, and appends its canvas', () => {
    const c = container();
    createOglFrame('Radar').mount(asElement(c), SHADERS, 640, 360);
    const [renderer] = gpu.renderers;
    expect(renderer.options).toMatchObject({alpha: true, preserveDrawingBuffer: true, dpr: 1, width: 640, height: 360});
    expect(c.appendChild).toHaveBeenCalledWith(renderer.gl.canvas);
    expect(renderer.gl.canvas.style.display).toBe('block');
  });

  it('writes every uniform from the drawing-buffer size before each draw', () => {
    const ogl = createOglFrame('Threads');
    ogl.mount(asElement(container()), SHADERS, 640, 360);
    ogl.draw(640, 360, at(3.2));
    ogl.draw(640, 360, at(3.2 + 1 / 30));
    expect(renders()).toEqual([`render uTime=3.2 uResolution=640,360`, `render uTime=${3.2 + 1 / 30} uResolution=640,360`]);
  });

  it('resizes only when the size really changes, since a resize clears the drawing buffer', () => {
    const ogl = createOglFrame('Radar');
    ogl.mount(asElement(container()), SHADERS, 640, 360);
    for (const [w, h] of [[640, 360], [640, 360], [800, 360], [800, 360], [633.6, 360], [633.6, 360]]) ogl.draw(w, h, at(0));
    expect(gpu.log.filter((l) => l.startsWith('setSize'))).toEqual(['setSize 800x360', 'setSize 633.6x360']);
    expect(renders().at(-1)).toBe('render uTime=0 uResolution=633,360');
  });

  it('cancels the render at once, naming the component, when the program does not link', () => {
    gpu.linked = false;
    const c = container();
    const ogl = createOglFrame('Threads');
    expect(() => ogl.mount(asElement(c), SHADERS, 640, 360)).toThrow("Threads: the WebGL program did not link: ERROR: 0:12: 'uTme'");
    expect(hold.cancelRender).toHaveBeenCalledTimes(1);
    expect(c.appendChild).not.toHaveBeenCalled();
    expect(gpu.log).toContain('loseContext');
    ogl.draw(640, 360, at(0));
    expect(renders()).toEqual([]);
    expect(hold.continueRender).not.toHaveBeenCalled();
  });

  it('cancels the render at once when WebGL is unavailable', () => {
    gpu.webgl = false;
    expect(() => createOglFrame('Radar').mount(asElement(container()), SHADERS, 640, 360)).toThrow(/^Radar: WebGL is unavailable \(Cannot set properties of null/);
    expect(hold.cancelRender).toHaveBeenCalledTimes(1);
  });

  it('cancels the render at once when there is no container, instead of leaving the hold to time out', () => {
    expect(() => createOglFrame('Radar').mount(null, SHADERS, 640, 360)).toThrow('Radar: no container to hold the WebGL canvas');
    expect(hold.cancelRender).toHaveBeenCalledTimes(1);
    expect(gpu.renderers).toEqual([]);
  });

  it('tears down: removes the canvas, loses the context, and draws nothing afterwards', () => {
    const c = container();
    const ogl = createOglFrame('Radar');
    const teardown = ogl.mount(asElement(c), SHADERS, 640, 360);
    ogl.draw(640, 360, at(0));
    teardown();
    expect(c.removeChild).toHaveBeenCalledWith(gpu.renderers[0].gl.canvas);
    expect(gpu.log.at(-1)).toBe('loseContext');
    ogl.draw(640, 360, at(1));
    expect(renders()).toHaveLength(1);
  });

  it('draws again after a remount (React may remount layout effects), without holding the render twice', () => {
    const c = container();
    const ogl = createOglFrame('Radar');
    ogl.mount(asElement(c), SHADERS, 640, 360)();
    ogl.mount(asElement(c), SHADERS, 640, 360);
    ogl.draw(640, 360, at(0));
    expect(gpu.renderers).toHaveLength(2);
    expect(renders()).toHaveLength(1);
    expect(hold.delayRender).toHaveBeenCalledTimes(1);
    expect(hold.continueRender).toHaveBeenCalledTimes(1);
  });
});
