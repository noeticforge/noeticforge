/**
 * renderer/modules/webgl-fire.js
 * Claude Range Slider (Astraeus WebGL2) 真实流体火焰渲染管线
 * 四通道：流体模拟 (FRAG_SIM) -> 横向高斯模糊 -> 纵向高斯模糊 -> 屏幕混合色调映射
 */

const VERT = `#version 300 es
layout(location=0) in vec2 a_pos;
out vec2 v_uv;
void main(){ v_uv=a_pos*0.5+0.5; gl_Position=vec4(a_pos,0.0,1.0); }`;

const FRAG_SIM = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fc;
uniform float u_time, u_slider, u_elapsed;
uniform sampler2D u_back;
float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
void main(){
  vec2 uv=v_uv;
  vec2 g=uv*vec2(72.0,6.0);
  vec2 id=floor(g); vec2 cf=fract(g);
  float h=hash(id);
  vec2 ap=abs(cf-0.5);
  float cell=smoothstep(0.34,0.22,max(ap.x*0.9,ap.y));
  vec3 prev=texture(u_back,uv).rgb;
  float fade_mask=smoothstep(0.0,0.45,uv.x);
  vec3 decay=prev*0.90*fade_mask;
  float act=smoothstep(0.95,1.0,u_slider);
  if(act<0.01||u_elapsed<0.0){ fc=vec4(decay,1.0); return; }
  float t=u_time;
  float cellAge=max(u_elapsed - h*1.2, 0.0);
  float ignited=step(0.001, cellAge);
  float eased=1.0-pow(1.0-clamp(cellAge/2.5, 0.0, 1.0), 3.0);
  float dist=eased * u_slider * (0.85+h*0.3) * ignited;
  float front=max(u_slider - dist - (h-0.5)*0.05, 0.02);
  float tail=max(u_slider - front, 0.001);
  float inZ=step(front-0.003, uv.x)*step(uv.x, u_slider+0.003);
  float dn=clamp(max(u_slider-uv.x, 0.0)/tail, 0.0, 1.0);
  float bright=pow(1.0-dn, 0.65);
  bright=max(bright, 0.04*ignited)*inZ * (1.0-smoothstep(0.94, 1.05, dn));
  float es=mix(0.15, 0.5, min(u_elapsed, 1.0));
  float vy=abs(uv.y-0.5)*2.0; float vf=pow(max(1.0-vy*vy*0.45, 0.0), 0.75);
  float ts=mix(0.85, 1.0, min(u_elapsed/1.5, 1.0));
  float f1=sin(uv.x*30.0 + t*15.0*ts + h*6.28);
  float f2=sin(uv.x*17.0 + t*8.0*ts + h*3.14);
  float flame=smoothstep(0.08, 0.92, (f1+f2*0.5)*0.35+0.5);
  float energy=(bright * vf * flame + exp(-max(cellAge, 0.0)*3.2)*bright*vf*0.55)*es;
  float edge=exp(-pow((uv.x-front)*18.0, 2.0))*1.6*act*es;
  float total=energy + edge;
  vec3 ember=vec3(0.28, 0.10, 0.58); vec3 wpur=vec3(0.62, 0.32, 1.0); vec3 wht=vec3(1.0, 0.94, 0.98);
  float temp=1.0-dn;
  vec3 col=mix(mix(ember, wpur, temp), wht, pow(temp, 4.5)) * total;
  float pulse=sin(t*2.8)*0.15+1.0;
  col += wht * exp(-pow((uv.x-u_slider)*16.0, 2.0)) * 2.2 * pulse * act * es;
  col *= cell * fade_mask;
  fc=vec4(min(decay+col, vec3(1.5)), 1.0);
}`;

const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fc;
uniform sampler2D u_tex; uniform vec2 u_dir, u_res; uniform float u_ext;
vec3 s(vec2 uv){
  vec3 c=texture(u_tex,uv).rgb;
  return u_ext>0.5 && dot(c,vec3(0.2126,0.7152,0.0722))<0.3 ? vec3(0.0) : c;
}
void main(){
  vec2 o=u_dir*1.8/u_res;
  vec3 r=s(v_uv)*0.227027 + (s(v_uv+o)+s(v_uv-o))*0.194595 + (s(v_uv+o*2.0)+s(v_uv-o*2.0))*0.121622 + (s(v_uv+o*3.0)+s(v_uv-o*3.0))*0.054054;
  fc=vec4(r,1.0);
}`;

const FRAG_COMP = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 fc;
uniform sampler2D u_scene, u_glow;
void main(){
  vec3 s=texture(u_scene,v_uv).rgb; vec3 g=texture(u_glow,v_uv).rgb;
  fc=vec4(1.0-exp(-(s+g*1.2+s*g*0.35)*1.15),1.0);
}`;

export class WebglFireEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl2', { preserveDrawingBuffer: false, antialias: false });
    this.rafId = null;
    this.loopRunning = false;
    this.sliderVal = 0.75;
    this.active = false;
    this.ultraStart = null;
    this.idleFrames = 0;
    if (!this.gl) return;
    this.initPipeline();
  }

  compile(type, src) {
    const gl = this.gl;
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  }

  makeProgram(vs, fs) {
    const gl = this.gl;
    const p = gl.createProgram();
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    return p;
  }

  initPipeline() {
    const gl = this.gl;
    this.simProg = this.makeProgram(VERT, FRAG_SIM);
    this.blurProg = this.makeProgram(VERT, FRAG_BLUR);
    this.compProg = this.makeProgram(VERT, FRAG_COMP);

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.u = {
      simTime: gl.getUniformLocation(this.simProg, 'u_time'),
      simSlider: gl.getUniformLocation(this.simProg, 'u_slider'),
      simElapsed: gl.getUniformLocation(this.simProg, 'u_elapsed'),
      simBack: gl.getUniformLocation(this.simProg, 'u_back'),
      blurDir: gl.getUniformLocation(this.blurProg, 'u_dir'),
      blurExt: gl.getUniformLocation(this.blurProg, 'u_ext'),
      blurTex: gl.getUniformLocation(this.blurProg, 'u_tex'),
      blurRes: gl.getUniformLocation(this.blurProg, 'u_res'),
      compScene: gl.getUniformLocation(this.compProg, 'u_scene'),
      compGlow: gl.getUniformLocation(this.compProg, 'u_glow'),
    };
    this.resize();
  }

  makeFBO() {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    const tex = gl.createTexture();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.canvas.width, this.canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
    return { fbo, tex };
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.simA = this.makeFBO();
    this.simB = this.makeFBO();
    this.blurH = this.makeFBO();
    this.blurV = this.makeFBO();
  }

  update(sliderVal, isActive) {
    this.sliderVal = sliderVal;
    if (isActive && !this.active) this.ultraStart = performance.now();
    else if (!isActive) this.ultraStart = null;
    this.active = isActive;
    this.ensureLoop();
  }

  ensureLoop() {
    if (!this.gl || this.loopRunning) return;
    this.loopRunning = true;
    this.idleFrames = 0;
    const render = (t) => {
      if (!this.active) {
        if (++this.idleFrames > 45) {
          this.loopRunning = false;
          this.rafId = null;
          return;
        }
      } else {
        this.idleFrames = 0;
      }
      this.draw(t);
      this.rafId = requestAnimationFrame(render);
    };
    this.rafId = requestAnimationFrame(render);
  }

  draw(t) {
    const gl = this.gl;
    if (!gl || !this.simA) return;
    const w = this.canvas.width; const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao);

    const elapsed = this.active ? (performance.now() - (this.ultraStart || 0)) / 1000 : -1.0;

    // Pass 1: Sim
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.simB.fbo);
    gl.useProgram(this.simProg);
    gl.uniform1f(this.u.simTime, t * 0.001);
    gl.uniform1f(this.u.simSlider, this.sliderVal);
    gl.uniform1f(this.u.simElapsed, elapsed);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.simA.tex);
    gl.uniform1i(this.u.simBack, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 2: Blur H
    gl.useProgram(this.blurProg);
    gl.uniform2f(this.u.blurRes, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurH.fbo);
    gl.uniform2f(this.u.blurDir, 1.0, 0.0);
    gl.uniform1f(this.u.blurExt, 1.0);
    gl.bindTexture(gl.TEXTURE_2D, this.simB.tex);
    gl.uniform1i(this.u.blurTex, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 3: Blur V
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.blurV.fbo);
    gl.uniform2f(this.u.blurDir, 0.0, 1.0);
    gl.uniform1f(this.u.blurExt, 0.0);
    gl.bindTexture(gl.TEXTURE_2D, this.blurH.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 4: Composite to Canvas Screen
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.useProgram(this.compProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.simB.tex);
    gl.uniform1i(this.u.compScene, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.blurV.tex);
    gl.uniform1i(this.u.compGlow, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Swap Sim A/B
    const tmp = this.simA; this.simA = this.simB; this.simB = tmp;
  }

  destroy() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.loopRunning = false;
  }
}
