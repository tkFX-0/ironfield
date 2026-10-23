// WebGL2 sprite batcher with a texture-array atlas, plus the terrain shader.

const SPRITE_VS = `#version 300 es
layout(location=0) in vec2 aPos;
layout(location=1) in vec3 aUV;
layout(location=2) in vec4 aCol;
uniform vec4 uCam; // scale x, scale y, offset x, offset y (world px -> clip)
out vec3 vUV; out vec4 vCol;
void main(){ vUV=aUV; vCol=aCol; gl_Position=vec4(aPos*uCam.xy+uCam.zw,0.,1.); }`;
const SPRITE_FS = `#version 300 es
precision mediump float; precision mediump sampler2DArray;
uniform sampler2DArray uTex;
in vec3 vUV; in vec4 vCol; out vec4 o;
void main(){
  if(vUV.z<0.){ o=vCol; return; }
  vec4 t=texture(uTex,vUV);
  o=t*vCol;
}`;

// terrain: a map texture of tile codes, blended with noise for organic borders
const TERRAIN_VS = `#version 300 es
layout(location=0) in vec2 aPos;
uniform vec4 uView; // world x0,y0 (tiles) at top-left, width,height in tiles
out vec2 vW;
void main(){ vW=uView.xy+vec2((aPos.x+1.)*.5,(1.-aPos.y)*.5)*uView.zw; gl_Position=vec4(aPos,0.,1.); }`;
const TERRAIN_FS = `#version 300 es
precision highp float;
uniform sampler2D uMap; uniform vec2 uMapSize; uniform vec2 uMapOrigin; uniform vec2 uPlot; uniform float uTime; uniform float uPx;
in vec2 vW; out vec4 o;
float h(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float n(vec2 p){ vec2 i=floor(p),f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y); }
float fbm(vec2 p){ float s=0.,a=.5; for(int i=0;i<4;i++){ s+=a*n(p); p=p*2.03+17.1; a*=.5; } return s; }
vec3 mat(float c, vec2 w){
  float g=fbm(w*1.3), d=fbm(w*5.1+3.), f=n(w*14.);
  if(c<0.5){ // grass
    vec3 a=vec3(.27,.33,.13), b=vec3(.36,.40,.17);
    return mix(a,b,g)*(.86+.22*d)+vec3(.02,.025,0.)*f;
  } else if(c<1.5){ // dry grass
    vec3 a=vec3(.40,.37,.18), b=vec3(.47,.42,.22);
    return mix(a,b,g)*(.86+.2*d)+vec3(.02)*f;
  } else if(c<2.5){ // dirt
    vec3 a=vec3(.42,.32,.20), b=vec3(.50,.39,.25);
    return mix(a,b,g)*(.84+.2*d)+vec3(.03,.02,.01)*f;
  } else if(c<3.5){ // sand
    vec3 a=vec3(.66,.58,.40), b=vec3(.74,.66,.47);
    return mix(a,b,g)*(.9+.12*d)+vec3(.02)*f;
  }
  return vec3(0.);
}
float code(vec2 t){ return texture(uMap,(floor(t)-uMapOrigin+.5)/uMapSize).r*255.; }
void main(){
  vec2 w=vW;
  // jitter lookup position for wavy borders
  vec2 j=vec2(fbm(w*.9),fbm(w*.9+9.))-.5;
  vec2 q=w+j*.9;
  float c=code(q);
  vec3 col;
  float cw=code(w);
  if(c>=3.5){
    // water: depth from the deep/shallow code and distance to land
    float deep=c>4.5?1.:0.;
    float t=uTime;
    float wave=fbm(w*.6+vec2(t*.05,t*.03))*.6+fbm(w*2.2-vec2(t*.08,0.))*.4;
    vec3 sh=vec3(.10,.24,.30), dp=vec3(.04,.12,.20);
    col=mix(sh,dp,deep*.8+.2*wave);
    col+=vec3(.05,.08,.09)*smoothstep(.62,.8,wave);
    // shore foam: land nearby
    float land=0.;
    for(int k=0;k<4;k++){ vec2 o2=vec2(k==0?1.:k==1?-1.:0., k==2?1.:k==3?-1.:0.)*.55; if(code(q+o2)<3.5) land=1.; }
    col=mix(col,vec3(.45,.52,.50),land*.25*(.5+.5*sin(t*1.3+w.x*2.+w.y)));
  } else {
    col=mat(c,w);
    // soft shore darkening next to water
    float wet=0.;
    for(int k=0;k<4;k++){ vec2 o2=vec2(k==0?1.:k==1?-1.:0., k==2?1.:k==3?-1.:0.)*.6; if(code(q+o2)>=3.5) wet=1.; }
    col=mix(col,col*vec3(.7,.75,.72),wet*.5);
    // blend toward the neighbouring material
    float c2=code(w+(j.yx)*1.6);
    if(c2!=c && c2<3.5) col=mix(col,mat(c2,w),.35);
  }
  // subtle tile grid at close zoom (helps placement)
  vec2 fw=fract(w);
  float gl=step(fw.x,1./uPx)+step(fw.y,1./uPx);
  col*= 1.-min(gl,1.)*.06*smoothstep(24.,60.,uPx);
  // the neighbouring plots around yours: dimmed, with a line along your plot's border
  float e=max(max(-w.x,w.x-uPlot.x),max(-w.y,w.y-uPlot.y));
  if(e>0.) col=mix(col,vec3(dot(col,vec3(.3,.5,.2))),.35)*.62;
  col=mix(col,vec3(1.,.8,.45),.75*(1.-smoothstep(.0,max(.07,2.5/uPx),abs(e))));
  // outside the map
  vec2 m=w-uMapOrigin;
  if(m.x<0.||m.y<0.||m.x>=uMapSize.x||m.y>=uMapSize.y) col=vec3(.03,.08,.13);
  o=vec4(col,1.);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

const MAXQ = 16384;
const FLOATS = 6; // x, y, u, v, layer, rgba(packed)

export class GL {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true, powerPreference: 'high-performance' });
    if (!gl) throw new Error('WebGL2 が使えません');
    this.gl = gl;
    this.canvas = canvas;
    this.sp = program(gl, SPRITE_VS, SPRITE_FS);
    this.tp = program(gl, TERRAIN_VS, TERRAIN_FS);
    this.uCam = gl.getUniformLocation(this.sp, 'uCam');
    this.uTex = gl.getUniformLocation(this.sp, 'uTex');
    this.tu = {
      view: gl.getUniformLocation(this.tp, 'uView'), map: gl.getUniformLocation(this.tp, 'uMap'),
      size: gl.getUniformLocation(this.tp, 'uMapSize'), origin: gl.getUniformLocation(this.tp, 'uMapOrigin'),
      plot: gl.getUniformLocation(this.tp, 'uPlot'), time: gl.getUniformLocation(this.tp, 'uTime'), px: gl.getUniformLocation(this.tp, 'uPx'),
    };
    this.buf = new ArrayBuffer(MAXQ * 4 * FLOATS * 4);
    this.f32 = new Float32Array(this.buf);
    this.u32 = new Uint32Array(this.buf);
    this.n = 0;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.buf.byteLength, gl.DYNAMIC_DRAW);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, stride, 20);
    const idx = new Uint16Array(MAXQ * 6);
    for (let q = 0, v = 0; q < MAXQ * 6; q += 6, v += 4) { idx[q] = v; idx[q + 1] = v + 1; idx[q + 2] = v + 2; idx[q + 3] = v; idx[q + 4] = v + 2; idx[q + 5] = v + 3; }
    // 16-bit indices cap at 65535 vertices = 16383 quads
    this.ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    // fullscreen quad for terrain
    this.tvao = gl.createVertexArray();
    gl.bindVertexArray(this.tvao);
    const tb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 8, 0);
    gl.bindVertexArray(null);
    this.blendAdd = false;
  }

  uploadAtlas(canvases) {
    const gl = this.gl;
    const size = canvases[0].width;
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, Math.floor(Math.log2(size)) + 1, gl.RGBA8, size, size, canvases.length);
    canvases.forEach((c, i) => gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, size, size, 1, gl.RGBA, gl.UNSIGNED_BYTE, c));
    gl.generateMipmap(gl.TEXTURE_2D_ARRAY);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.atlasSize = size;
  }

  // bytes: w x h tile codes whose top-left tile is (ox, oy); the playable map is (0,0)..(pw,ph)
  uploadMap(bytes, w, h, ox = 0, oy = 0, pw = w, ph = h) {
    const gl = this.gl;
    if (!this.mapTex) this.mapTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.mapW = w; this.mapH = h; this.mapOX = ox; this.mapOY = oy; this.plotW = pw; this.plotH = ph;
  }

  resize(w, h) {
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.gl.viewport(0, 0, w, h);
  }

  drawTerrain(x0, y0, wTiles, hTiles, time, pxPerTile) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.useProgram(this.tp);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mapTex);
    gl.uniform1i(this.tu.map, 1);
    gl.uniform4f(this.tu.view, x0, y0, wTiles, hTiles);
    gl.uniform2f(this.tu.size, this.mapW, this.mapH);
    gl.uniform2f(this.tu.origin, this.mapOX, this.mapOY);
    gl.uniform2f(this.tu.plot, this.plotW, this.plotH);
    gl.uniform1f(this.tu.time, time);
    gl.uniform1f(this.tu.px, pxPerTile);
    gl.bindVertexArray(this.tvao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  // camera: world pixel coords (atlas px units) -> clip space
  begin(camX, camY, scale) {
    const gl = this.gl;
    this.flush();
    gl.useProgram(this.sp);
    const w = this.canvas.width, h = this.canvas.height;
    gl.uniform4f(this.uCam, 2 * scale / w, -2 * scale / h, -2 * camX * scale / w, 2 * camY * scale / h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.tex);
    gl.uniform1i(this.uTex, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  setAdditive(on) {
    if (on === this.blendAdd) return;
    this.flush();
    this.blendAdd = on;
    const gl = this.gl;
    if (on) gl.blendFunc(gl.ONE, gl.ONE); else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  // premultiplied colour
  static rgba(r, g, b, a) {
    return ((Math.round(a * 255) << 24) | (Math.round(b * a * 255) << 16) | (Math.round(g * a * 255) << 8) | Math.round(r * a * 255)) >>> 0;
  }

  // axis-aligned quad
  quad(x, y, w, h, s, col = 0xffffffff) {
    if (this.n >= MAXQ - 1) this.flush();
    const f = this.f32, u = this.u32;
    let o = this.n * 4 * FLOATS;
    const L = s ? s.layer : -1;
    const u0 = s ? s.u0 : 0, v0 = s ? s.v0 : 0, u1 = s ? s.u1 : 0, v1 = s ? s.v1 : 0;
    f[o] = x; f[o + 1] = y; f[o + 2] = u0; f[o + 3] = v0; f[o + 4] = L; u[o + 5] = col; o += FLOATS;
    f[o] = x + w; f[o + 1] = y; f[o + 2] = u1; f[o + 3] = v0; f[o + 4] = L; u[o + 5] = col; o += FLOATS;
    f[o] = x + w; f[o + 1] = y + h; f[o + 2] = u1; f[o + 3] = v1; f[o + 4] = L; u[o + 5] = col; o += FLOATS;
    f[o] = x; f[o + 1] = y + h; f[o + 2] = u0; f[o + 3] = v1; f[o + 4] = L; u[o + 5] = col;
    this.n++;
  }
  // rotated quad about (cx,cy); w,h are the unrotated size
  quadRot(cx, cy, w, h, ang, s, col = 0xffffffff) {
    if (this.n >= MAXQ - 1) this.flush();
    const c = Math.cos(ang), sn = Math.sin(ang);
    const hw = w / 2, hh = h / 2;
    const f = this.f32, u = this.u32;
    let o = this.n * 4 * FLOATS;
    const L = s ? s.layer : -1;
    const uv = s ? [s.u0, s.v0, s.u1, s.v0, s.u1, s.v1, s.u0, s.v1] : [0, 0, 0, 0, 0, 0, 0, 0];
    const pts = [-hw, -hh, hw, -hh, hw, hh, -hw, hh];
    for (let k = 0; k < 4; k++) {
      const px = pts[k * 2], py = pts[k * 2 + 1];
      f[o] = cx + px * c - py * sn; f[o + 1] = cy + px * sn + py * c;
      f[o + 2] = uv[k * 2]; f[o + 3] = uv[k * 2 + 1]; f[o + 4] = L; u[o + 5] = col;
      o += FLOATS;
    }
    this.n++;
  }
  // line as a thin quad
  line(x0, y0, x1, y1, width, col) {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    this.quadRot((x0 + x1) / 2, (y0 + y1) / 2, len, width, Math.atan2(dy, dx), null, col);
  }

  flush() {
    if (!this.n) return;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, this.n * 4 * FLOATS);
    gl.drawElements(gl.TRIANGLES, this.n * 6, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    this.n = 0;
  }
}
