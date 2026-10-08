/*
 * PetRig —— 喵灵角色运行时：米露（黑猫 · 发光眼 · 抱星）与波比（橘色虎斑 · 晨光信使）
 *
 * 一份源码四处用：App 原生端（WebView 内嵌）、App 网页端（直接跑）、官网短片、鸿蒙 ArkWeb。
 * 改完运行 `npm run rig:build`（frontend-demo）同步到各处，不要手改副本。
 *
 * 结构：
 *   - 角色画在一棵「脱离文档的 SVG 场景图」上：骨骼、属性都在节点上改；
 *   - 每帧由一个小解释器把场景图画进 canvas（SVG 直接显示会按瓦片反复光栅化，手机上扛不住）；
 *   - 贴纸白边 / 投影 = 同一套骨骼的两份副本，只留外轮廓，强制涂成纯色并加粗描边；
 *   - mountPet：单只桌宠，状态驱动（idle / listening / thinking / speaking / happy / sleep）；
 *   - mountFilm：40 秒短片（官网首屏），所有运动都是 t 的纯函数，可任意跳帧。
 *
 * 外部接口：window.PetRig = { mountPet, mountFilm, version }
 */
(function (root) {
  'use strict';
  const VERSION = '1.0.0';
  const NS = 'http://www.w3.org/2000/svg';
  const TAU = Math.PI * 2;

  /* ═══════════════════════════ 基础工具 ═══════════════════════════ */
  const f = n => (Math.round(n * 100) / 100);
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, t) => a + (b - a) * t;
  const Ease = {
    linear: t => t,
    sine: t => -(Math.cos(Math.PI * t) - 1) / 2,
    inOut: t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
    out: t => 1 - Math.pow(1 - t, 3),
    in: t => t * t * t,
    expoOut: t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t),
  };
  /** 关键帧轨道：[[t, v, ease?], ...]，ease 描述「到达这一帧」的曲线 */
  function track(keys) {
    return t => {
      if (t <= keys[0][0]) return keys[0][1];
      for (let i = 1; i < keys.length; i++) {
        if (t < keys[i][0]) {
          const [t0, v0] = keys[i - 1], [t1, v1, e] = keys[i];
          return lerp(v0, v1, (Ease[e || 'sine'])((t - t0) / (t1 - t0)));
        }
      }
      return keys[keys.length - 1][1];
    };
  }
  const ramp = (t, a, b, e = 'sine') => Ease[e](clamp((t - a) / (b - a)));
  /** 事件触发的阻尼振荡：t0 之前为 0 */
  const wobble = (t, t0, amp, freq = 14, decay = 6) => t < t0 ? 0 : amp * Math.exp(-decay * (t - t0)) * Math.sin(freq * (t - t0));
  /** 眨眼形状：0.17 秒，先快合后慢开；d 为距离眨眼开始的秒数 */
  const blinkShape = d => (d < 0 || d >= .17) ? 0 : (d < .06 ? d / .06 : 1 - (d - .06) / .11);
  function blinkAt(t, times) { let v = 0; for (const b of times) v = Math.max(v, blinkShape(t - b)); return v; }
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const bez = (p0, p1, p2, p3, t) => {
    const u = 1 - t;
    return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
  };
  /** Catmull-Rom → 三次贝塞尔，给尾巴这类链条用 */
  function smooth(pts) {
    let d = `M${f(pts[0][0])},${f(pts[0][1])}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
      d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)},${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)},${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])},${f(p2[1])}`;
    }
    return d;
  }
  function chain(base, ang, segs, bend, phase, amp) {
    let a = ang, p = base.slice();
    const pts = [p.slice()];
    segs.forEach((L, i) => {
      a += bend[i] + amp * Math.sin(phase - i * .75) * (.35 + i * .22);
      p = [p[0] + Math.cos(a) * L, p[1] + Math.sin(a) * L];
      pts.push(p);
    });
    return pts;
  }
  function starPath(R, r) {
    let d = '';
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + i * Math.PI / 5, k = i % 2 ? r : R;
      d += (i ? 'L' : 'M') + f(Math.cos(a) * k) + ',' + f(Math.sin(a) * k);
    }
    return d + 'Z';
  }
  const sparkle = s => { const w = s * .16; return `M0,${-s} C${w},${-w} ${w},${-w} ${s},0 C${w},${w} ${w},${w} 0,${s} C${-w},${w} ${-w},${w} ${-s},0 C${-w},${-w} ${-w},${-w} 0,${-s}Z`; };
  const T = (x = 0, y = 0, r = 0, sx = 1, sy = sx) => `translate(${f(x)} ${f(y)}) rotate(${f(r)}) scale(${f(sx)} ${f(sy)})`;
  const quad = (s, e, bow) => {
    const mx = (s[0] + e[0]) / 2, my = (s[1] + e[1]) / 2, dx = e[0] - s[0], dy = e[1] - s[1], L = Math.hypot(dx, dy) || 1;
    return `M${f(s[0])},${f(s[1])} Q${f(mx - dy / L * bow)},${f(my + dx / L * bow)} ${f(e[0])},${f(e[1])}`;
  };
  const hexRgba = (hex, a) => { const c = parseInt(hex.slice(1), 16); return `rgba(${c >> 16},${c >> 8 & 255},${c & 255},${a})`; };

  /* ═══════════════════════════ 调色板 ═══════════════════════════ */
  const C = {
    paper: '#F5EFE2', stickerEdge: '#FFFBF2', shadow: '#5B4633',
    // 米露
    fur: '#231D1A', furL: '#3A302B', furD: '#150F0D', earIn: '#F2A5B3', pad: '#F4A9B6',
    eye: '#FFF6DF', eyeArc: '#FFE6AE', blush: '#E98595',
    star: '#FFD467', starO: '#E6A038', starHi: '#FFF3C8',
    // 波比
    or: '#F0A45C', orD: '#D7803A', orL: '#F8C088', cream: '#FFEBD0', earB: '#F4AFA6',
    eyeB: '#3A281C', iris: '#C9812F', nose: '#EE8B8B', mouth: '#7A3029', tongue: '#F29090',
    scarf: '#EE8676', scarfD: '#D56A5C', sun: '#FFCF5C',
    // 世界
    far: '#BFCBC4', mid: '#AFC0A0', ground: '#D5DBB2', groundD: '#C3CC9C', noteInk: '#6B5842', note: '#FFF8EA',
  };

  /* ═══════════════════════════ 角色造型（局部坐标：脚底中心为原点，y 向上为负） ═══════════════════════════ */
  function miroMarkup() {
    const star = `
      <path d="${starPath(38, 18)}" fill="${C.starO}" stroke="${C.starO}" stroke-width="13" stroke-linejoin="round"/>
      <path d="${starPath(38, 18)}" fill="${C.star}" stroke="${C.star}" stroke-width="7" stroke-linejoin="round"/>
      <path d="${starPath(20, 9.5)}" transform="translate(-4 -5)" fill="${C.starHi}" stroke="${C.starHi}" stroke-width="5" stroke-linejoin="round"/>
      <circle cx="-13" cy="-14" r="3.2" fill="#FFFFFF"/>`;
    const ear = `<path d="M-40,14 C-44,-30 -30,-72 -6,-94 C4,-96 10,-90 14,-82 C30,-50 42,-20 44,10 Z" fill="${C.fur}"/><path d="M-24,6 C-25,-24 -16,-54 -2,-70 C12,-48 22,-22 24,6 Z" fill="${C.earIn}"/>`;
    return `
    <g id="m-root">
      <ellipse id="m-contact" cx="0" cy="4" rx="118" ry="13" fill="#4A3A2A" opacity=".18"/>
      <g id="m-stk" data-stk="1">
        <path id="m-tail" fill="none" stroke="${C.fur}" stroke-width="25" stroke-linecap="round" stroke-linejoin="round"/>
        <g id="m-body">
          <path d="M-104,-14 C-116,-70 -92,-138 -52,-158 L52,-158 C92,-138 116,-70 104,-14 C96,4 -96,4 -104,-14 Z" fill="${C.fur}"/>
          <path d="M60,-150 C98,-128 114,-70 104,-14 C100,-6 88,-2 76,-1 C94,-40 92,-110 60,-150 Z" fill="${C.furD}"/>
          <path d="M-52,-156 C-88,-136 -108,-80 -100,-30 C-94,-80 -80,-126 -40,-150 Z" fill="${C.furL}"/>
        </g>
        <g id="m-headG">
          <g id="m-earL">${ear}</g>
          <g id="m-earR"><g transform="scale(-1 1)">${ear}</g></g>
          <path d="M-122,-92 C-124,-168 -68,-205 0,-205 C68,-205 124,-168 122,-92 C120,-26 70,12 0,12 C-70,12 -120,-26 -122,-92 Z" fill="${C.fur}"/>
          <path d="M-104,-150 C-80,-188 -40,-199 -6,-199 C-46,-190 -84,-168 -100,-126 Z" fill="${C.furL}"/>
          <path d="M117,-72 C104,-20 66,8 10,11 C60,-2 98,-30 117,-72 Z" fill="${C.furD}"/>
          <path id="m-tuft" d="M0,0 C2,-14 14,-22 24,-16 C30,-12 28,-4 22,-4" fill="none" stroke="${C.fur}" stroke-width="10" stroke-linecap="round"/>
          <ellipse id="m-blushL" cx="-80" cy="-50" rx="17" ry="9" fill="${C.blush}"/>
          <ellipse id="m-blushR" cx="80" cy="-50" rx="17" ry="9" fill="${C.blush}"/>
          <g id="m-face">
            <g id="m-eyeL"><ellipse rx="13.5" ry="22" fill="${C.eye}"/><ellipse cx="-4" cy="-8" rx="4" ry="6" fill="#FFFFFF" opacity=".8"/></g>
            <g id="m-eyeR"><ellipse rx="13.5" ry="22" fill="${C.eye}"/><ellipse cx="-4" cy="-8" rx="4" ry="6" fill="#FFFFFF" opacity=".8"/></g>
            <g id="m-sleepArcs" fill="none" stroke="${C.eyeArc}" stroke-width="5.5" stroke-linecap="round">
              <path d="M-61,-94 Q-46,-83 -31,-94"/><path d="M31,-94 Q46,-83 61,-94"/></g>
            <g id="m-happyArcs" fill="none" stroke="${C.eyeArc}" stroke-width="6" stroke-linecap="round">
              <path d="M-60,-88 Q-46,-106 -32,-88"/><path d="M32,-88 Q46,-106 60,-88"/></g>
            <path id="m-mouth" d="M-10,-58 Q-5,-51 0,-57 Q5,-51 10,-58" fill="none" stroke="${C.eyeArc}" stroke-width="3.2" stroke-linecap="round"/>
          </g>
        </g>
        <g id="m-feet">
          ${[-1, 1].map(s => `<g transform="translate(${s * 56} -18)"><ellipse rx="38" ry="26" fill="${C.fur}"/><ellipse cy="5" rx="14" ry="11" fill="${C.pad}"/>${[-14, 0, 14].map((x, i) => `<circle cx="${x}" cy="${i === 1 ? -12 : -9}" r="5.6" fill="${C.pad}"/>`).join('')}</g>`).join('')}
        </g>
        <g id="m-star">${star}</g>
        <path id="m-armL" fill="none" stroke="${C.fur}" stroke-width="30" stroke-linecap="round"/>
        <path id="m-armR" fill="none" stroke="${C.fur}" stroke-width="30" stroke-linecap="round"/>
        ${['L', 'R'].map(s => `<g id="m-hand${s}" opacity="0"><ellipse rx="17" ry="15" fill="${C.fur}"/><ellipse cy="4" rx="7" ry="5.5" fill="${C.pad}"/>${[-7, 0, 7].map((x, i) => `<circle cx="${x}" cy="${i === 1 ? -7 : -5}" r="3" fill="${C.pad}"/>`).join('')}</g>`).join('')}
      </g>
    </g>`;
  }
  function miroGlowMarkup() {
    return `
      <circle id="g-pool" r="360" fill="url(#gl-pool)" opacity="0"/>
      <g id="gm-root"><g id="gm-headG"><g id="gm-face">
        <ellipse id="g-eyeL" rx="34" ry="44" fill="url(#gl-eye)"/><ellipse id="g-eyeR" rx="34" ry="44" fill="url(#gl-eye)"/>
      </g></g><circle id="g-star" r="95" fill="url(#gl-star)"/></g>`;
  }
  function bobiMarkup() {
    const eye = id => `<g id="${id}"><circle r="19.5" fill="${C.eyeB}"/><ellipse cy="8" rx="13" ry="8.5" fill="${C.iris}"/><circle cx="6.5" cy="-7" r="6.8" fill="#FFFFFF"/><circle cx="-6" cy="7" r="3" fill="#FFFFFF" opacity=".9"/></g>`;
    const ear = `<path d="M-34,12 C-36,-40 -22,-88 -2,-106 C8,-102 30,-52 36,8 Z" fill="${C.or}"/><path d="M-20,4 C-20,-32 -12,-68 -2,-84 C10,-58 20,-28 22,4 Z" fill="${C.earB}"/><path d="M-6,0 C-8,-14 -4,-26 2,-34 M6,2 C6,-10 10,-20 14,-26" fill="none" stroke="${C.cream}" stroke-width="3" stroke-linecap="round"/>`;
    const paw = id => `<g id="${id}"><circle r="14" fill="${C.cream}"/><path d="M-5,-4 L-5,4 M5,-4 L5,4" stroke="#E2C3A0" stroke-width="2.4" stroke-linecap="round"/></g>`;
    return `
    <g id="b-root">
      <ellipse id="b-contact" cx="0" cy="4" rx="92" ry="12" fill="#4A3A2A" opacity=".18"/>
      <g id="b-stk" data-stk="1">
        <path id="b-tail" fill="none" stroke="${C.or}" stroke-width="21" stroke-linecap="round"/>
        <path id="b-tailRing" fill="none" stroke="${C.orD}" stroke-width="21" stroke-dasharray="9 15" stroke-dashoffset="-6"/>
        <g id="b-body">
          <path d="M-76,-12 C-86,-60 -66,-112 -40,-128 L40,-128 C66,-112 86,-60 76,-12 C70,2 -70,2 -76,-12 Z" fill="${C.or}"/>
          <path d="M-66,-100 C-58,-96 -50,-96 -44,-100 M-74,-76 C-64,-72 -54,-72 -46,-76 M66,-100 C58,-96 50,-96 44,-100 M74,-76 C64,-72 54,-72 46,-76" fill="none" stroke="${C.orD}" stroke-width="7" stroke-linecap="round"/>
          <ellipse cy="-58" rx="38" ry="50" fill="${C.cream}"/>
          ${[-1, 1].map(s => `<ellipse cx="${s * 58}" cy="-32" rx="30" ry="31" fill="${C.or}"/><path d="M${s * 46},-52 C${s * 56},-50 ${s * 64},-44 ${s * 70},-36 M${s * 44},-38 C${s * 54},-36 ${s * 62},-30 ${s * 66},-22" fill="none" stroke="${C.orD}" stroke-width="6" stroke-linecap="round"/><ellipse cx="${s * 58}" cy="-7" rx="25" ry="12" fill="${C.cream}"/>`).join('')}
        </g>
        <g id="b-headG">
          <g id="b-earL">${ear}</g>
          <g id="b-earR"><g transform="scale(-1 1)">${ear}</g></g>
          <path d="M-100,-70 C-104,-140 -58,-172 0,-172 C58,-172 104,-140 100,-70 L113,-56 L99,-50 L108,-34 L90,-34 C74,-4 38,10 0,10 C-38,10 -74,-4 -90,-34 L-108,-34 L-99,-50 L-113,-56 Z" fill="${C.or}" stroke="${C.or}" stroke-width="6" stroke-linejoin="round"/>
          <path d="M-84,-132 C-66,-158 -34,-166 -10,-166 C-40,-156 -64,-142 -80,-118 Z" fill="${C.orL}"/>
          <path d="M-18,-168 Q-15,-150 -9,-138 M0,-172 Q0,-154 0,-142 M18,-168 Q15,-150 9,-138 M-100,-88 L-78,-84 M-101,-74 L-80,-72 M100,-88 L78,-84 M101,-74 L80,-72" fill="none" stroke="${C.orD}" stroke-width="7.5" stroke-linecap="round"/>
          <ellipse cx="-19" cy="-38" rx="25" ry="19" fill="${C.cream}"/><ellipse cx="19" cy="-38" rx="25" ry="19" fill="${C.cream}"/><ellipse cy="-24" rx="22" ry="14" fill="${C.cream}"/>
          <ellipse id="b-blushL" cx="-64" cy="-50" rx="15" ry="8" fill="${C.blush}"/>
          <ellipse id="b-blushR" cx="64" cy="-50" rx="15" ry="8" fill="${C.blush}"/>
          <g id="b-face">
            ${eye('b-eyeL')}${eye('b-eyeR')}
            <g id="b-happyArcs" fill="none" stroke="${C.eyeB}" stroke-width="6" stroke-linecap="round"><path d="M-54,-78 Q-38,-98 -22,-78"/><path d="M22,-78 Q38,-98 54,-78"/></g>
            <g id="b-sleepArcs" fill="none" stroke="${C.eyeB}" stroke-width="5.5" stroke-linecap="round"><path d="M-54,-84 Q-38,-72 -22,-84"/><path d="M22,-84 Q38,-72 54,-84"/></g>
            <g id="b-mouthOpen"><path d="M-14,-46 Q0,-18 14,-46 Q0,-42 -14,-46 Z" fill="${C.mouth}"/><ellipse cy="-30" rx="8" ry="6" fill="${C.tongue}"/></g>
            <path d="M-7,-61 Q0,-67 7,-61 Q3,-54 0,-53 Q-3,-54 -7,-61 Z" fill="${C.nose}"/>
            <path id="b-mouth" d="M-13,-46 Q-6.5,-38 0,-47 Q6.5,-38 13,-46" fill="none" stroke="${C.mouth}" stroke-width="3.2" stroke-linecap="round"/>
          </g>
        </g>
        <g id="b-scarf">
          <path d="M-54,-128 Q0,-104 54,-128 L52,-110 Q0,-86 -52,-110 Z" fill="${C.scarf}"/>
          <path d="M-52,-114 Q0,-92 52,-114" fill="none" stroke="${C.scarfD}" stroke-width="3" opacity=".6"/>
          <g id="b-flap" transform="translate(-32 -110)"><path d="M0,0 L-15,30 L6,22 Z M0,0 L10,31 L20,14 Z" fill="${C.scarf}" stroke="${C.scarf}" stroke-width="4" stroke-linejoin="round"/></g>
          <circle cx="-32" cy="-110" r="9" fill="${C.scarfD}"/>
          <g transform="translate(14 -98)"><circle r="12.5" fill="none" stroke="${C.sun}" stroke-width="5" stroke-dasharray="3 3.54"/><circle r="8.5" fill="${C.sun}"/><circle cx="-2.5" cy="-2.5" r="3" fill="#FFF0C0"/></g>
        </g>
        <path id="b-legL" fill="none" stroke="${C.or}" stroke-width="25" stroke-linecap="round"/>
        <path id="b-legR" fill="none" stroke="${C.or}" stroke-width="25" stroke-linecap="round"/>
        ${paw('b-pawL')}${paw('b-pawR')}
      </g>
      <!-- 胡须不做白边：细线外扩白边会变粗 -->
      <g id="b-over"><g id="b-overHead" fill="none" stroke="#FFF6E6" stroke-width="2.4" stroke-linecap="round" opacity=".9">
        <path d="M-86,-46 L-128,-54 M-86,-38 L-126,-34 M86,-46 L128,-54 M86,-38 L126,-34"/></g></g>
    </g>`;
  }
  function cupMarkup() {
    return `
    <g id="cupG">
      <g id="cupStk" data-stk="1">
        <path d="M-18,-46 L18,-46 L14,0 L-14,0 Z" fill="#E4F0EC"/>
        <path id="cupWater" d="M-16.4,-28 Q0,-24 16.4,-28 L14,0 L-14,0 Z" fill="#8DC4D2"/>
        <path d="M-11,-40 L-9,-8" stroke="#FFFFFF" stroke-width="3.5" stroke-linecap="round" opacity=".85"/>
      </g>
    </g>`;
  }
  const GLOW_DEFS = `
    <radialGradient id="gl-moon"><stop offset="0" stop-color="#FFF1C8" stop-opacity=".55"/><stop offset="1" stop-color="#FFE0A0" stop-opacity="0"/></radialGradient>
    <radialGradient id="gl-eye"><stop offset="0" stop-color="#FFE7A8" stop-opacity=".95"/><stop offset=".45" stop-color="#FFC877" stop-opacity=".35"/><stop offset="1" stop-color="#FFB45A" stop-opacity="0"/></radialGradient>
    <radialGradient id="gl-star"><stop offset="0" stop-color="#FFF0C0" stop-opacity="1"/><stop offset=".35" stop-color="#FFC45E" stop-opacity=".55"/><stop offset="1" stop-color="#FF9C3A" stop-opacity="0"/></radialGradient>
    <radialGradient id="gl-pool"><stop offset="0" stop-color="#FFB864" stop-opacity=".42"/><stop offset=".45" stop-color="#E88A4A" stop-opacity=".14"/><stop offset="1" stop-color="#C0643A" stop-opacity="0"/></radialGradient>
    <radialGradient id="gl-dot"><stop offset="0" stop-color="#FFE9A8" stop-opacity="1"/><stop offset="1" stop-color="#FFB85A" stop-opacity="0"/></radialGradient>`;

  /* ═══════════════════════════ 场景图 ═══════════════════════════ */
  // 贴纸副本里要剔除的「轮廓内部细节」：它们对白边没有贡献，却要付粗描边的光栅化代价
  const DETAIL = new Set([C.furL, C.furD, C.earIn, C.pad, C.blush, C.eye, C.eyeArc, C.cream, C.orL, C.orD, C.earB, C.eyeB, C.iris,
    C.nose, C.mouth, C.tongue, C.scarfD, C.sun, C.starHi, '#FFFFFF', '#FFF0C0', '#E2C3A0']);

  function createScene(mainInner, glowInner) {
    const holder = document.createElement('div');
    holder.innerHTML = `<svg xmlns="${NS}"><defs>${GLOW_DEFS}</defs><g id="cam">${mainInner}</g></svg>`
      + `<svg xmlns="${NS}"><defs>${GLOW_DEFS}</defs>${glowInner}</svg>`;
    const svgMain = holder.children[0], svgGlow = holder.children[1];
    // 贴纸白边与投影：克隆骨骼两份（投影 s-、白边 o-）垫在下面
    svgMain.querySelectorAll('[data-stk]').forEach(orig => {
      for (const [pre, cls] of [['s-', 'sh'], ['o-', 'ol']]) {
        const cl = orig.cloneNode(true);
        cl.id = pre + orig.id; cl.setAttribute('class', 'sil ' + cls); cl.removeAttribute('data-stk');
        cl.querySelectorAll('[id]').forEach(n => { n.id = pre + n.id; });
        cl.querySelectorAll('path,ellipse,circle').forEach(n => {
          if (n.tagName === 'circle' && n.closest('[id$="pawL"],[id$="pawR"]')) return;
          const fill = n.getAttribute('fill') || n.parentNode.getAttribute('fill'), stroke = n.getAttribute('stroke') || n.parentNode.getAttribute('stroke');
          if (DETAIL.has(fill) || (fill === 'none' && DETAIL.has(stroke))) n.remove();
        });
        ['m-face', 'm-star', 'b-face', 'b-tailRing'].forEach(k => { const n = cl.querySelector('#' + pre + k); if (n) n.remove(); });
        orig.parentNode.insertBefore(cl, orig);
      }
    });
    const el = {};
    holder.querySelectorAll('[id]').forEach(n => { if (!el[n.id]) el[n.id] = n; });
    const last = new Map();
    function put(node, key, v) {
      if (!node) return;
      v = String(v);
      let m = last.get(node); if (!m) last.set(node, m = {});
      if (m[key] === v) return;
      m[key] = v; node.setAttribute(key, v);
    }
    const mirror = (id, k, v) => { put(el['o-' + id], k, v); put(el['s-' + id], k, v); };
    const stopsCache = {};
    return {
      holder, svgMain, svgGlow, el, put,
      setT(id, v) { put(el[id], 'transform', v); mirror(id, 'transform', v); },
      setA(id, k, v) { put(el[id], k, v); if (k === 'd') mirror(id, k, v); },
      stops(id) {
        if (stopsCache[id]) return stopsCache[id];
        const g = el[id]; if (!g) return (stopsCache[id] = []);
        return (stopsCache[id] = [...g.querySelectorAll('stop')].map(n => {
          const a = n.getAttribute('stop-opacity');
          return [parseFloat(n.getAttribute('offset')), hexRgba(n.getAttribute('stop-color'), a === null ? 1 : a)];
        }));
      },
      /** 手绘抖线的廉价版：白边副本每 1/8 秒换一个亚像素偏移和微缩放 */
      boil(id, t, salt) {
        const r = rng(Math.floor(t * 8) * 31 + salt);
        const jx = (r() - .5) * 2.2, jy = (r() - .5) * 2.2, k = 1 + (r() - .5) * .012;
        put(el['o-' + id], 'transform', `translate(${f(jx)} ${f(jy)}) scale(${k.toFixed(4)})`);
        put(el['s-' + id], 'transform', `translate(${f(6 + jx)} ${f(10 + jy)})`);
      },
    };
  }

  /* ═══════════════════════════ Canvas 解释器 ═══════════════════════════ */
  const P2D = new Map();
  const path2d = d => { let p = P2D.get(d); if (!p) { if (P2D.size > 3000) P2D.clear(); P2D.set(d, p = new Path2D(d)); } return p; };
  const TR_RE = /(\w+)\(([^)]*)\)/g;
  function applyTransform(ctx, tr) {
    TR_RE.lastIndex = 0; let m;
    while ((m = TR_RE.exec(tr))) {
      const v = m[2].split(/[\s,]+/).filter(Boolean).map(Number);
      if (m[1] === 'translate') ctx.translate(v[0], v[1] || 0);
      else if (m[1] === 'rotate') ctx.rotate(v[0] * Math.PI / 180);
      else if (m[1] === 'scale') ctx.scale(v[0], v.length > 1 ? v[1] : v[0]);
    }
  }
  const SIL_W = { 'm-tail': 43, 'm-armL': 48, 'm-armR': 48, 'm-tuft': 28, 'b-tail': 42, 'b-legL': 42, 'b-legR': 42 };
  const PRES = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset'];

  /** st.mode：'shadow' 只画投影副本，'main' 跳过投影副本 */
  function drawNode(sc, ctx, n, st) {
    const tag = n.tagName;
    if (tag === 'defs' || tag === 'text' || tag === 'radialGradient' || tag === 'stop') return;
    const op = n.getAttribute('opacity');
    const alpha = op === null ? st.alpha : st.alpha * parseFloat(op);
    if (alpha < .002) return;
    const cls = n.getAttribute('class');
    const sh = cls === 'sil sh';
    if (sh && st.mode !== 'shadow') return;
    if (tag !== 'g' && st.mode === 'shadow' && !st.inSh) return;
    const s = Object.create(st); s.alpha = alpha;
    for (const k of PRES) { const v = n.getAttribute(k); if (v !== null) s[k] = v; }
    if (cls && cls.startsWith('sil')) s.sil = sh ? C.shadow : C.stickerEdge;
    if (sh) { s.inSh = true; s.alpha = 1; }
    const tr = n.getAttribute('transform');
    ctx.save();
    if (tr) applyTransform(ctx, tr);
    if (tag === 'g' || tag === 'svg') { for (const c of n.children) drawNode(sc, ctx, c, s); }
    else drawShape(sc, ctx, n, s);
    ctx.restore();
  }
  function drawShape(sc, ctx, n, s) {
    const tag = n.tagName;
    ctx.globalAlpha = s.alpha;
    if (tag === 'image') { if (n._img) ctx.drawImage(n._img, +n.getAttribute('x'), +n.getAttribute('y'), +n.getAttribute('width'), +n.getAttribute('height')); return; }
    let fill = s.fill || '#000', stroke = s.stroke || 'none', sw = s['stroke-width'] ? parseFloat(s['stroke-width']) : 1;
    let join = s['stroke-linejoin'] || 'miter', cap = s['stroke-linecap'] || 'butt';
    if (s.sil) {
      if (fill !== 'none') fill = s.sil;
      stroke = s.sil; sw = SIL_W[n.id.replace(/^[os]-/, '')] || 18; join = cap = 'round';
    }
    let path;
    if (tag === 'path') { const d = n.getAttribute('d'); if (!d) return; path = path2d(d); }
    else if (tag === 'ellipse' || tag === 'circle') {
      const cx = +(n.getAttribute('cx') || 0), cy = +(n.getAttribute('cy') || 0);
      const rx = +(tag === 'circle' ? n.getAttribute('r') : n.getAttribute('rx')), ry = tag === 'circle' ? rx : +n.getAttribute('ry');
      if (!(rx > 0) || !(ry > 0)) return;
      if (fill.startsWith('url(')) {
        ctx.save(); ctx.translate(cx, cy); ctx.scale(1, ry / rx);
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
        for (const [o, c] of sc.stops(fill.slice(5, -1))) g.addColorStop(o, c);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, TAU); ctx.fill(); ctx.restore();
        return;
      }
      path = new Path2D(); path.ellipse(cx, cy, rx, ry, 0, 0, TAU);
    } else return;
    if (fill !== 'none') { ctx.fillStyle = fill; ctx.fill(path); }
    if (stroke !== 'none' && sw > 0) {
      ctx.strokeStyle = stroke; ctx.lineWidth = sw; ctx.lineJoin = join; ctx.lineCap = cap;
      const da = s['stroke-dasharray'], dashed = da && da !== 'none';
      if (dashed) { ctx.setLineDash(da.split(/[\s,]+/).map(Number)); ctx.lineDashOffset = +(s['stroke-dashoffset'] || 0); }
      ctx.stroke(path);
      if (dashed) ctx.setLineDash([]);
    }
  }
  /** 画一棵树：先投影（离屏、整体 20%），再本体 */
  function drawTree(sc, ctx, off, base, rootNode, withShadow) {
    if (withShadow) {
      const ox = off.getContext('2d');
      ox.setTransform(1, 0, 0, 1, 0, 0); ox.clearRect(0, 0, off.width, off.height);
      const k = off.width / ctx.canvas.width;
      ox.setTransform(base[0] * k, base[1] * k, base[2] * k, base[3] * k, base[4] * k, base[5] * k);
      for (const c of rootNode.children) drawNode(sc, ox, c, { alpha: 1, mode: 'shadow' });
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = .2;
      ctx.drawImage(off, 0, 0, ctx.canvas.width, ctx.canvas.height); ctx.restore();
    }
    ctx.save(); ctx.setTransform(...base);
    for (const c of rootNode.children) drawNode(sc, ctx, c, { alpha: 1, mode: 'main' });
    ctx.restore();
  }

  /* ═══════════════════════════ 姿态 → 骨骼 ═══════════════════════════ */
  /**
   * 米露姿态参数：x,y 世界坐标；breath -1..1；sleep/happy 0..1；eyeOpen 0..1；lx,ly 视线 -1..1；
   * tilt 头歪（度）；drop 低头（px）；earL/earR（度）；tuft；tail 相位 / tailAmp；
   * star 世界坐标 [x,y]；starGlow 亮度；starPop 缩放增量；starRot（度）
   */
  function applyMiro(sc, P, t, night, opt = {}) {
    sc.setT('m-root', T(P.x, P.y));
    sc.boil('m-stk', t, 1);
    sc.setT('m-body', `scale(${f(1 - .008 * P.breath)} ${f(1 + .016 * P.breath * (1 + P.sleep * .5))})`);
    const neckY = -150 - 150 * .016 * P.breath;
    const head = `translate(0 ${f(neckY + P.drop)}) rotate(${f(P.tilt)})`;
    sc.setT('m-headG', head); sc.setT('gm-headG', head);
    sc.setT('m-earL', `translate(-78 -168) rotate(${f(P.earL)})`);
    sc.setT('m-earR', `translate(78 -168) rotate(${f(P.earR)})`);
    sc.setT('m-tuft', `translate(6 -202) rotate(${f(P.tuft)})`);
    const face = `translate(${f(P.lx * 10)} ${f(P.ly * 6)})`;
    sc.setT('m-face', face); sc.setT('gm-face', face);
    const eyeSX = 1 - Math.abs(P.lx) * .08, eyeSY = Math.max(.04, P.eyeOpen);
    sc.setT('m-eyeL', `translate(-46 -96) scale(${f(eyeSX)} ${f(eyeSY)})`);
    sc.setT('m-eyeR', `translate(46 -96) scale(${f(eyeSX)} ${f(eyeSY)})`);
    sc.setA('m-eyeL', 'opacity', P.eyeOpen < .06 ? 0 : 1); sc.setA('m-eyeR', 'opacity', P.eyeOpen < .06 ? 0 : 1);
    sc.setA('m-sleepArcs', 'opacity', f(clamp((P.sleep - .82) / .15)));
    sc.setA('m-happyArcs', 'opacity', f(clamp((P.happy - .5) / .3)));
    sc.setA('m-mouth', 'opacity', f(P.happy));
    sc.setA('m-blushL', 'opacity', f(.42 + P.happy * .35)); sc.setA('m-blushR', 'opacity', f(.42 + P.happy * .35));
    sc.setA('m-tail', 'd', smooth(chain([84, -34], -.12, [30, 30, 28, 26, 22, 18], [-.05, -.35, -.45, -.45, -.5, -.62], P.tail, P.tailAmp)));
    const sx = P.star[0] - P.x, sy = P.star[1] - P.y;
    sc.setT('m-star', T(sx, sy, P.starRot, 1 + P.starPop));
    // 害羞捂眼：手臂终点从抱星的位置移到眼睛上（眼睛在头部坐标里，换算回身体坐标）
    const shy = P.shy || 0;
    const eyeY = neckY + P.drop - 96 + P.ly * 6;
    const handL = [lerp(sx - 31, -46 + P.lx * 10, shy), lerp(sy + 10, eyeY + 4, shy)];
    const handR = [lerp(sx + 31, 46 + P.lx * 10, shy), lerp(sy + 10, eyeY + 4, shy)];
    sc.setA('m-armL', 'd', quad([-70, -124], handL, lerp(14, 26, shy)));
    sc.setA('m-armR', 'd', quad([70, -124], handR, lerp(-14, -26, shy)));
    // 捂眼的爪子：粉色肉垫朝外，黑爪子盖在黑脸上也认得出来
    sc.setT('m-handL', T(handL[0], handL[1], -12, 1.3));
    sc.setT('m-handR', T(handR[0], handR[1], 12, 1.3));
    sc.setA('m-handL', 'opacity', f(clamp((shy - .35) / .5)));
    sc.setA('m-handR', 'opacity', f(clamp((shy - .35) / .5)));
    // 发光
    sc.setT('gm-root', T(P.x, P.y));
    const eyeGlow = P.eyeOpen * (.28 + .72 * night);
    sc.setT('g-eyeL', `translate(-46 -96) scale(1 ${f(Math.max(.2, P.eyeOpen))})`); sc.setA('g-eyeL', 'opacity', f(eyeGlow));
    sc.setT('g-eyeR', `translate(46 -96) scale(1 ${f(Math.max(.2, P.eyeOpen))})`); sc.setA('g-eyeR', 'opacity', f(eyeGlow));
    sc.setT('g-star', T(sx, sy, 0, .6 + P.starGlow * .35 + P.starPop * 1.2));
    sc.setA('g-star', 'opacity', f(clamp(P.starGlow * (.3 + .55 * night) + P.starPop)));
    const pool = opt.poolScale || 1;
    sc.setT('g-pool', T(P.star[0] + 90 * pool, P.star[1] + 10 * pool, 0, 1.25 * pool, .8 * pool));
    sc.setA('g-pool', 'opacity', f(night * clamp(P.starGlow) * (opt.poolAlpha == null ? 1 : opt.poolAlpha)));
  }
  /**
   * 波比姿态参数：x,y；ground 地面 y；sy 纵向伸缩；lean（度）；sleep/yawn/happy/amaze；eyeOpen；lx,ly；
   * tilt；drop；earL/earR；flap 围巾角；tailPhase/tailAmp；pawL/pawR 前爪局部坐标
   */
  function applyBobi(sc, P, t) {
    sc.setT('b-root', T(P.x, P.y, P.lean));
    sc.boil('b-stk', t, 2);
    const lift = P.ground - P.y;
    sc.setA('b-contact', 'rx', f(92 - lift * .25));
    sc.setA('b-contact', 'opacity', f(.18 * clamp(1 - lift / 200)));
    sc.setT('b-contact', `translate(0 ${f(lift)})`);
    const breath = Math.sin(TAU * t / (2.8 + P.sleep * 1.4));
    const sy = P.sy * (1 + .014 * breath), sx = 1 / Math.sqrt(P.sy) * (1 - .006 * breath);
    sc.setT('b-body', `scale(${f(sx)} ${f(sy)})`);
    sc.setT('b-scarf', `translate(0 ${f(-128 * (sy - 1))})`);
    sc.setT('b-flap', `translate(-32 -110) rotate(${f(P.flap)})`);
    const neckY = -122 * sy;
    const head = `translate(${f(P.lx * 3)} ${f(neckY + P.drop)}) rotate(${f(P.tilt)})`;
    sc.setT('b-headG', head); sc.setT('b-overHead', head);
    sc.setT('b-earL', `translate(-62 -142) rotate(${f(P.earL)})`);
    sc.setT('b-earR', `translate(62 -142) rotate(${f(P.earR)})`);
    sc.setT('b-face', `translate(${f(P.lx * 7)} ${f(P.ly * 5)})`);
    const es = 1 + P.amaze * .14;
    sc.setT('b-eyeL', `translate(-38 -84) scale(${f(es)} ${f(es * Math.max(.05, P.eyeOpen))})`);
    sc.setT('b-eyeR', `translate(38 -84) scale(${f(es)} ${f(es * Math.max(.05, P.eyeOpen))})`);
    const closed = P.eyeOpen < .08;
    sc.setA('b-eyeL', 'opacity', closed ? 0 : 1); sc.setA('b-eyeR', 'opacity', closed ? 0 : 1);
    sc.setA('b-happyArcs', 'opacity', f(clamp(clamp((P.happy - .5) / .3) + clamp(P.yawn - .4))));
    sc.setA('b-sleepArcs', 'opacity', f(clamp((P.sleep - .7) / .2)));
    const open = clamp(P.happy * .75 + P.yawn * .9 + P.amaze * .5 + (P.talk || 0), 0, 1.3);
    sc.setT('b-mouthOpen', `translate(0 -46) scale(${f(1 + P.yawn * .25)} ${f(open)}) translate(0 46)`);
    sc.setA('b-mouthOpen', 'opacity', open > .05 ? 1 : 0);
    sc.setA('b-mouth', 'opacity', open > .3 ? 0 : 1);
    sc.setA('b-blushL', 'opacity', f(.45 + P.happy * .3)); sc.setA('b-blushR', 'opacity', f(.45 + P.happy * .3));
    const tailD = smooth(chain([62, -22], -.05, [26, 26, 24, 22, 20, 17], [-.08, -.3, -.42, -.42, -.35, -.22], P.tailPhase, P.tailAmp));
    sc.setA('b-tail', 'd', tailD); sc.setA('b-tailRing', 'd', tailD);
    const shoulder = s => [s * 25, -104 * sy];
    const pl = [P.pawL[0], P.pawL[1] * (P.pawL[1] < -60 ? 1 : sy)], pr = [P.pawR[0], P.pawR[1] * (P.pawR[1] < -60 ? 1 : sy)];
    sc.setA('b-legL', 'd', quad(shoulder(1), pl, -10)); sc.setA('b-legR', 'd', quad(shoulder(-1), pr, 10));
    sc.setT('b-pawL', `translate(${f(pl[0])} ${f(pl[1])})`); sc.setT('b-pawR', `translate(${f(pr[0])} ${f(pr[1])})`);
    return { pl, pr, sy };
  }

  /* ═══════════════════════════ 画布尺寸 ═══════════════════════════ */
  function makeCanvas(container) {
    const cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none';
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    container.appendChild(cv);
    return cv;
  }
  const dprOf = () => Math.min(2, root.devicePixelRatio || 1);   // 手机上 3x 没必要，2x 足够清晰
  function watchSize(container, cb) {
    let w = 0, h = 0;
    const check = () => { const r = container.getBoundingClientRect(); if (r.width !== w || r.height !== h) { w = r.width; h = r.height; if (w > 0 && h > 0) cb(w, h); } };
    let ro = null;
    if (root.ResizeObserver) { ro = new ResizeObserver(check); ro.observe(container); }
    else root.addEventListener('resize', check);
    check();
    return () => { if (ro) ro.disconnect(); else root.removeEventListener('resize', check); };
  }

  /* ═══════════════════════════ 单只桌宠 ═══════════════════════════ */
  const MOODS = ['idle', 'listening', 'thinking', 'speaking', 'happy', 'sleep', 'shy'];
  // 取景框（角色局部坐标）：左右留出尾巴和胡须，上方留出蹦跳的余量
  const FRAME = { miro: [-185, -425, 385, 450], bobi: [-175, -445, 365, 470] };

  function mountPet(container, opts = {}) {
    const kind = opts.pet === 'bobi' ? 'bobi' : 'miro';
    const sc = createScene(kind === 'miro' ? miroMarkup() : bobiMarkup(), `<g id="gcam">${kind === 'miro' ? miroGlowMarkup() : ''}</g>`);
    const cv = makeCanvas(container), ctx = cv.getContext('2d');
    const off = document.createElement('canvas');
    const st = {
      mood: MOODS.includes(opts.mood) ? opts.mood : 'idle',
      night: !!opts.night, level: 0, reduce: !!opts.reduceMotion, paused: false,
      // 外部指定的视线 [x,y]（-1..1，x 向右、y 向下为正），null 表示自己看
      look: null,
    };
    let W = 0, H = 0, raf = 0, t0 = 0, lastNow = 0, T0 = 0;
    // 每只桌宠各自的随机节律：同一页面上多只时，眨眼与转头不会同步得像机器人
    const rand = rng((opts.seed | 0) || ((Math.random() * 2147483647) | 0));
    // 平滑量：当前值 → 目标值，指数逼近（与帧率无关）
    const cur = { sleep: st.mood === 'sleep' ? 1 : 0, happy: 0, perk: 0, think: 0, talk: 0, hear: 0, shy: 0, lx: 0, ly: 0, glow: .62 };
    const ev = { blink: -9, nextBlink: 1.2, twitch: -9, twitchSide: 1, nextTwitch: 5, glanceUntil: 0, glance: [0, 0], nextGlance: 3.5,
      poke: -9, hop: -9, hopH: 0, nextHop: 7, yawn: -9, sleepSince: -9, talkPhase: 0 };
    if (st.mood === 'sleep') ev.sleepSince = -99;

    function schedule(now) {
      if (now > ev.nextBlink) { ev.blink = now; ev.nextBlink = now + (rand() < .16 ? .28 : 2.2 + rand() * 4); }
      if (now > ev.nextTwitch) { ev.twitch = now; ev.twitchSide = rand() < .5 ? -1 : 1; ev.nextTwitch = now + 6 + rand() * 9; }
      if (now > ev.nextGlance) {
        ev.glance = [(rand() - .5) * 1.6, -.35 + rand() * .7];
        ev.glanceUntil = now + 1.1 + rand() * 1.4; ev.nextGlance = ev.glanceUntil + 3 + rand() * 6;
      }
      if (kind === 'bobi' && now > ev.nextHop) {
        if (st.mood === 'idle' || st.mood === 'happy') { ev.hop = now; ev.hopH = 22 + rand() * 12; }
        ev.nextHop = now + 9 + rand() * 8;
      }
    }
    function approach(key, target, rate, dt) { cur[key] += (target - cur[key]) * (1 - Math.exp(-rate * dt)); }

    function hopAt(now) {
      const d = now - ev.hop, dur = .46;
      if (d < -.14 || d > dur + .6) return { y: 0, sy: 1, vy: 0 };
      if (d < 0) return { y: 0, sy: 1 - .1 * Math.sin(Math.PI * (d + .14) / .14 * .5), vy: 0 };
      if (d < dur) { const p = d / dur; return { y: -ev.hopH * 4 * p * (1 - p), sy: 1 + .09 * Math.sin(Math.PI * p), vy: -ev.hopH * 4 * (1 - 2 * p) / dur }; }
      const e = d - dur;
      return { y: 0, sy: 1 - (ev.hopH / 46) * .15 * Math.exp(-7 * e) * Math.cos(15 * e), vy: 0 };
    }

    function frame(now, dt) {
      const m = st.mood, animate = !st.reduce;
      if (animate) schedule(now);
      const poked = now - ev.poke < 1.3;
      const sleepTarget = m === 'sleep' ? 1 : 0;
      approach('sleep', sleepTarget, sleepTarget ? .9 : 3.2, dt);
      approach('happy', (m === 'happy' || poked) ? 1 : 0, 7, dt);
      approach('perk', m === 'listening' ? 1 : 0, 6, dt);
      approach('think', m === 'thinking' ? 1 : 0, 4, dt);
      approach('shy', m === 'shy' ? 1 : 0, 9, dt);
      // 说话：拿不到 TTS 音量时自己合成一条说话包络；倾听：跟着用户的音量
      const syn = clamp(.45 + .35 * Math.sin(now * 9) * Math.sin(now * 2.3) + .15 * Math.sin(now * 23));
      approach('talk', m === 'speaking' ? clamp(Math.max(st.level * 1.4, animate ? syn : .5)) : 0, 14, dt);
      approach('hear', m === 'listening' ? clamp(st.level * 1.6) : 0, 10, dt);
      // 视线
      let gx = 0, gy = 0;
      if (st.look && m !== 'shy') { gx = st.look[0]; gy = st.look[1]; }
      else if (m === 'thinking') { gx = .55; gy = -.7; }
      else if (m === 'listening') { gx = 0; gy = .08; }
      else if (m === 'speaking') { gx = .12 * Math.sin(now * .7); gy = .05; }
      else if (now < ev.glanceUntil) { gx = ev.glance[0]; gy = ev.glance[1]; }
      approach('lx', gx * (1 - cur.sleep), 5, dt); approach('ly', gy * (1 - cur.sleep), 5, dt);
      const blink = cur.sleep < .5 && animate ? blinkShape(now - ev.blink) : 0;
      const twist = animate ? wobble(now, ev.twitch, 16, 30, 8) : 0;
      const pokeW = wobble(now, ev.poke, 1, 12, 4);
      if (kind === 'miro') {
        const talk = cur.talk;
        const glowBase = lerp(.62, .42 + .08 * Math.sin(now * 1.6), cur.sleep);
        approach('glow', glowBase + cur.think * .18 * Math.sin(now * 3) + talk * .55 + cur.hear * .3 + cur.happy * .25, 8, dt);
        const breath = Math.sin(TAU * now / (3.4 + cur.sleep * .9));
        const P = {
          x: 0, y: 0, breath, sleep: cur.sleep, happy: cur.happy,
          eyeOpen: clamp((1 - cur.sleep) * (1 - blink) * (1 - cur.happy) * (1 - cur.shy)),
          lx: cur.lx, ly: cur.ly, shy: cur.shy,
          tilt: cur.sleep * 7 + cur.lx * .5 + cur.think * 6 - cur.happy * 4 + pokeW * 5 + cur.shy * 4,
          drop: cur.sleep * 9 - cur.happy * 4 - cur.perk * 5 + cur.shy * 6,
          earL: -18 - cur.sleep * 14 - cur.happy * 6 + cur.perk * 9 + cur.hear * 5 + (ev.twitchSide < 0 ? twist : 0),
          earR: 18 + cur.sleep * 14 + cur.happy * 6 - cur.perk * 9 - cur.hear * 5 + (ev.twitchSide > 0 ? twist : 0),
          tuft: 7 * Math.sin(now * 1.7) + pokeW * 24,
          tail: now * (1.1 - cur.sleep * .5 - cur.think * .3), tailAmp: .1 - cur.sleep * .05 + cur.perk * .03,
          // 捂眼时星星被松开，悬在胸前轻轻浮动
          star: [0, -92 + 1.2 * Math.sin(TAU * now / 3.4) - talk * 5 - cur.happy * 4 - cur.shy * (10 + 4 * Math.sin(now * 2.2))],
          starGlow: cur.glow, starPop: talk * .1 + Math.max(0, pokeW) * .25,
          starRot: 4 * Math.sin(now * .8) + (now - ev.poke < 2 ? 72 * Ease.expoOut(clamp((now - ev.poke) / .9)) : 0),
        };
        applyMiro(sc, P, now, st.night ? 1 : 0, { poolScale: .45, poolAlpha: .8 });
      } else {
        // 入睡前先打个哈欠
        if (m === 'sleep' && ev.sleepSince === -9) { ev.sleepSince = now; ev.yawn = now; }
        if (m !== 'sleep') ev.sleepSince = -9;
        const yawn = animate ? track([[0, 0], [.5, 1.2, 'out'], [1.2, 1.2], [1.6, 0]])(now - ev.yawn) : 0;
        const h = animate ? hopAt(now) : { y: 0, sy: 1, vy: 0 };
        const talk = cur.talk;
        const P = {
          x: 0, y: h.y, ground: 0, sy: h.sy * (1 - cur.sleep * .07) * (1 + yawn * .05), vy: h.vy,
          lean: cur.sleep * -1.5 + cur.perk * 1.5,
          sleep: cur.sleep, yawn, happy: cur.happy, amaze: cur.perk * .45, talk,
          eyeOpen: clamp((1 - blink) * (1 - cur.happy) * (1 - cur.sleep) * (1 - clamp(yawn)) * (1 - cur.shy)),
          lx: cur.lx, ly: cur.ly,
          tilt: cur.lx * 6 - cur.sleep * 8 + cur.happy * 4 + cur.think * 8 + pokeW * 6,
          drop: cur.sleep * 12 - yawn * 6 - cur.perk * 4 + cur.hear * 3 * Math.sin(now * 5) + cur.shy * 8,
          earL: -14 - h.vy * .012 - cur.sleep * 16 + cur.perk * 8 + (ev.twitchSide < 0 ? twist : 0),
          earR: 14 + h.vy * .012 + cur.sleep * 16 - cur.perk * 8 - (ev.twitchSide > 0 ? twist : 0),
          flap: 10 * Math.sin(now * 2.1) - h.vy * .03,
          tailPhase: now * (1.8 - cur.sleep * 1.3), tailAmp: .16 - cur.sleep * .1 + cur.happy * .06,
          // 思考时右爪托下巴；害羞时两只前爪捂住眼睛
          pawR: [lerp(lerp(-26, -30, cur.think), -38 + cur.lx * 10, cur.shy), lerp(lerp(-10, -104, cur.think), -122 + cur.shy * 8 - 84, cur.shy)],
          pawL: [lerp(26, 38 + cur.lx * 10, cur.shy), lerp(-10, -122 + cur.shy * 8 - 84, cur.shy)],
        };
        applyBobi(sc, P, now);
      }
      paint();
    }

    function paint() {
      if (!W) return;
      const [fx, fy, fw, fh] = FRAME[kind];
      const k = Math.min(W / fw, H / fh) * dprOf();
      // 脚底贴近容器底部，水平居中
      const base = [k, 0, 0, k, cv.width / 2 - (fx + fw / 2) * k, cv.height - (fy + fh) * k];
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height);
      drawTree(sc, ctx, off, base, sc.svgMain, true);
      if (kind === 'miro') {
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        drawTree(sc, ctx, off, base, sc.svgGlow, false);
        ctx.restore();
      }
    }

    function loop(ts) {
      raf = 0;
      if (st.paused) return;
      const now = (ts - T0) / 1000;
      const dt = Math.min(.1, Math.max(0, now - lastNow)); lastNow = now;
      frame(now, dt);
      if (!st.reduce) raf = root.requestAnimationFrame(loop);
    }
    function kick() { if (!raf && !st.paused) raf = root.requestAnimationFrame(loop); }
    const stopSize = watchSize(container, (w, h) => {
      W = w; H = h;
      const d = dprOf();
      cv.width = Math.round(w * d); cv.height = Math.round(h * d);
      off.width = Math.max(1, cv.width >> 1); off.height = Math.max(1, cv.height >> 1);
      if (st.reduce || st.paused) frame(lastNow, 0); else kick();
    });
    T0 = root.performance.now(); t0 = 0;
    // 减弱动态：定格在一个安静的姿势，状态变化时重画一次
    if (st.reduce) { for (let i = 0; i < 40; i++) frame(i * .05, .05); } else kick();

    return {
      set(p) {
        if (!p) return;
        if (p.mood && MOODS.includes(p.mood)) st.mood = p.mood;
        if (typeof p.night === 'boolean') st.night = p.night;
        if (typeof p.level === 'number') st.level = clamp(p.level);
        if (p.look === null) st.look = null;
        else if (Array.isArray(p.look)) st.look = [clamp(p.look[0], -1, 1), clamp(p.look[1], -1, 1)];
        if (typeof p.reduceMotion === 'boolean' && p.reduceMotion !== st.reduce) { st.reduce = p.reduceMotion; if (!st.reduce) kick(); }
        if (st.reduce) { for (let i = 0; i < 30; i++) frame(lastNow + i * .05, .05); }
        else kick();
      },
      poke() { const now = (root.performance.now() - T0) / 1000; ev.poke = now; if (kind === 'bobi') { ev.hop = now + .05; ev.hopH = 40; } if (st.reduce) frame(now, .05); },
      pause() { st.paused = true; if (raf) { root.cancelAnimationFrame(raf); raf = 0; } },
      resume() { if (!st.paused) return; st.paused = false; lastNow = (root.performance.now() - T0) / 1000; kick(); },
      destroy() { this.pause(); stopSize(); cv.remove(); },
      get mood() { return st.mood; },
    };
  }

  /* ═══════════════════════════ 短片（官网首屏） ═══════════════════════════ */
  const FILM_DUR = 40;
  function mountFilm(container, opts = {}) {
    const GROUND = 800, MIRO_X = 840, BOBI_X = 1130;
    const fit = opts.fit === 'contain' ? 'contain' : 'cover';
    const loop = opts.loop !== false;
    const SKIES = [['dawn', '#F3D3C0', '#FBE7CF'], ['day', '#E4ECE2', '#F8EFDC'], ['gold', '#F1C39B', '#FADDB0'], ['dusk', '#9C88B4', '#F2B48C']];
    const WARM = [0xF4, 0xBE, 0x86].map(v => v / 255), NIGHT = [0x21, 0x1E, 0x44].map(v => v / 255);
    const FONT = "'LXGW WenKai Screen', 'KaiTi', 'STKaiti', serif";
    const caption = opts.caption == null ? '把明天的事，还给明天。' : opts.caption;

    /* ── 数据 ── */
    const NOTES = [
      { id: 'heavy', text: '那句话，是不是说错了', seed: 11, t0: 9.4, t1: 15.2, p: [[-240, 580], [200, 660], [400, 420], [548, 470]] },
      { id: 'tmr', text: '明天要交的东西…', seed: 12, t0: 10.0, t1: 21.5, p: [[-200, 290], [600, 210], [1300, 310], [2100, 240]] },
      { id: 'later', text: '先记下来，晚点再想', seed: 13, t0: 10.4, t1: 19.2, p: [[-220, 370], [500, 310], [1300, 390], [2100, 320]] },
      { id: 'hotpot', text: '想吃火锅', seed: 14, t0: 10.9, t1: 12.47, p: [[-200, 380], [420, 300], [900, 520], [0, 0]] },
    ];
    const MOTES = (() => { const r = rng(77); return Array.from({ length: 46 }, (_, i) => ({
      ts: 16.75 + i / 46 * .85 + r() * .18, dur: 1.0 + r() * .55,
      ox: (r() - .5) * 300, oy: (r() - .5) * 44,
      c1: [(r() - .5) * 160, -60 - r() * 120], c2: [(r() - .5) * 180, -70 - r() * 110],
      size: 3.6 + r() * 4, big: r() < .26, spin: (r() - .5) * 400,
    })); })();
    const STARS = (() => { const r = rng(5); return Array.from({ length: 46 }, () => ({
      x: r() * 1920, y: 30 + Math.pow(r(), 1.4) * 430, size: 1.2 + r() * 2.2, big: r() < .16, ph: r() * TAU, sp: .6 + r() * 1.6,
    })).map(s => (s.big && (s.size = 7 + s.size * 2), s)); })();
    const FLIES = (() => { const r = rng(9); return Array.from({ length: 9 }, () => ({
      x: 560 + r() * 820, y: 560 + r() * 200, ax: 30 + r() * 60, ay: 20 + r() * 40, sp: .2 + r() * .35, ph: r() * TAU,
    })); })();
    const BURST_A = Array.from({ length: 8 }, (_, i) => i / 8 * TAU + .3);

    /* ── 时间线 ── */
    const skyK = [track([[0, 1], [5, 1], [8, 0]]), track([[5, 0], [8, 1], [13, 1], [17, 0]]), track([[13, 0], [17, 1], [21, 1], [24, 0]]), track([[21, 0], [24, 1]])];
    const warmK = track([[12, 0], [17, .32], [20.5, .4], [23.5, .12], [27, 0]]);
    const nightK = track([[20.5, 0], [28, .92, 'inOut']]);
    const sunX = track([[0, 1480], [13, 1540], [25, 1720]]);
    const sunY = track([[0, 880], [7, 420, 'out'], [13, 400], [25, 920, 'in']]);
    const moonY = track([[24, 380], [29.5, 190, 'out']]);
    const exposure = t => Math.max(1 - ramp(t, 0, 1.6, 'out'), loop ? ramp(t, 39.2, 40) : 0);
    const CAM_Z0 = 1.25, CAM_DY = 110;
    const camZ = track([[0, .97], [6, 1.04], [9.5, 1.0], [15.4, 1.02], [18.3, 1.26, 'inOut'], [19.3, 1.26], [22.6, 1.0, 'inOut'], [26, 1.02], [29, 1.04], [38.5, 1.15]]);
    const camX = track([[0, 960], [6, 990], [9.5, 900], [15.4, 880], [18.3, 790, 'inOut'], [19.3, 790], [22.6, 960, 'inOut'], [38.5, 985]]);
    const camY = track([[0, 560], [6, 600], [9.5, 560], [15.4, 590], [18.3, 610, 'inOut'], [19.3, 610], [22.6, 560, 'inOut'], [25, 500], [28, 470], [31, 610, 'inOut'], [38.5, 645]]);
    const mSleep = track([[0, 1], [7.1, 1], [7.6, .5], [7.95, .5], [8.25, 0, 'expoOut'], [31.8, 0], [32.7, .5], [33.5, .5], [34.6, 1]]);
    const mStarGlow = track([[0, .22], [7.4, .22], [8.4, .7], [16.8, .7], [18.4, 1], [19, 1], [20.5, .8], [31, .85], [34.6, .55]]);
    const mStarDX = track([[15.4, 0], [16.5, -24], [18.6, -24], [19.7, 0]]);
    const mStarDY = track([[15.4, 0], [16.5, -20], [18.6, -20], [19.7, 0]]);
    const mHappy = track([[18.45, 0], [18.7, 1, 'out'], [19.8, 1], [20.3, 0]]);
    const M_BLINKS = [8.95, 11.5, 14.2, 20.9, 22.05, 22.3, 24.9, 27.4, 30.2];
    const M_TWITCH = [[6.55, 1, 'L'], [6.9, .8, 'L'], [13.1, .9, 'R'], [29.4, 1, 'R']];
    const HOPS = [
      [3.0, 3.5, 2150, 1890, 62], [3.62, 4.12, 1890, 1630, 58], [4.24, 4.74, 1630, 1380, 54], [4.86, 5.42, 1380, BOBI_X, 46],
      [8.5, 8.9, BOBI_X, BOBI_X, 30], [12.08, 12.86, BOBI_X, BOBI_X + 12, 150],
    ];
    const bSleep = track([[26.4, 0], [27.6, 1]]);
    const bYawn = track([[23.3, 0], [23.8, 1.25, 'out'], [24.5, 1.25], [24.9, 0]]);
    const bHappyTracks = [track([[8.45, 0], [8.6, 1], [9.4, 1], [9.7, 0]]), track([[12.5, 0], [12.65, 1], [13.7, 1], [14.1, 0]]), track([[18.9, 0], [19.1, 1], [20, 1], [20.4, 0]])];
    const bHappy = t => Math.max(...bHappyTracks.map(k => k(t)));
    const bAmaze = track([[18.35, 0], [18.55, 1, 'out'], [18.95, 0]]);
    const B_BLINKS = [6.1, 7.4, 10.3, 14.6, 15.9, 17.2, 21.1, 22.6, 25.8];
    const CUP_DOWN = 6.3;

    /* ── 纯函数姿态 ── */
    function bobiHop(t) {
      let x = HOPS[0][2], y = 0, sy = 1, vx = 0;
      for (const [a, b, x0, x1, h] of HOPS) {
        if (t >= b) { x = x1; continue; }
        if (t >= a) { const p = (t - a) / (b - a); x = lerp(x0, x1, Ease.sine(p)); y = -h * 4 * p * (1 - p); sy = 1 + .09 * Math.sin(Math.PI * p); vx = (x1 - x0) / (b - a); }
        else if (t > a - .14) { sy = 1 - .11 * Math.sin(Math.PI * (t - (a - .14)) / .14 * .5); }
        break;
      }
      for (const [, b, , , h] of HOPS) if (t >= b && t < b + .6) sy -= (h / 46) * .15 * Math.exp(-7 * (t - b)) * Math.cos(15 * (t - b));
      return { x, y, sy, vx };
    }
    const starWorld = t => [MIRO_X + mStarDX(t), GROUND - 92 + mStarDY(t) + 1.2 * Math.sin(TAU * t / 3.4)];
    const moteArrival = t => { let n = 0; for (const m of MOTES) if (t >= m.ts + m.dur) n++; return n / MOTES.length; };
    function starPop(t) {
      const d = t - 18.45;
      if (d < -.3) return .05 * moteArrival(t);
      if (d < 0) return .05 - .1 * Ease.sine((d + .3) / .3);
      return .34 * Math.exp(-4.2 * d) * Math.cos(10 * d) + .05 * Math.exp(-d);
    }
    function miroGaze(t) {
      const head = [MIRO_X, GROUND - 250];
      const dir = p => { const dx = p[0] - head[0], dy = p[1] - head[1], L = Math.hypot(dx, dy) || 1; return [dx / L * Math.min(1, L / 160), dy / L * Math.min(1, L / 160)]; };
      if (t < 8.3) return [0, 0];
      if (t < 9.7) return [1, .15];
      if (t < 16.9) return dir(noteState(NOTES[0], t).pos);
      if (t < 18.45) return [-.25, .9];
      if (t < 20.2) return [0, -.15];
      return [1, .45];
    }
    function bobiGaze(t, bx) {
      const head = [bx, GROUND - 210];
      const dir = p => { const dx = p[0] - head[0], dy = p[1] - head[1], L = Math.hypot(dx, dy) || 1; return [dx / L * Math.min(1, L / 140), dy / L * Math.min(1, L / 140)]; };
      if (t < 5.4) return [-1, .1];
      if (t < 9.6) return [-1, .35];
      // 纸条被抓住（t1=12.47）之后它的位置由波比的爪子决定，不能再反过来问纸条在哪，
      // 否则 bobiPose → bobiGaze → noteState → bobiPose 在同一时刻无限递归
      if (t < NOTES[3].t1) return dir(noteState(NOTES[3], t).pos);
      if (t < 12.5) return [.6, -.5];
      if (t < 14.2) return [.5, .8];
      if (t < 18.4) return dir(t < 16.9 ? noteState(NOTES[0], t).pos : starWorld(t));
      if (t < 20.4) return [-.7, .1];
      if (t < 23.2) return [-.2, 0];
      return [-.6, .5];
    }
    function miroPose(t) {
      const sleep = mSleep(t), awake = 1 - sleep;
      const breath = Math.sin(TAU * t / (3.4 + sleep * .9));
      const blink = awake > .9 ? blinkAt(t, M_BLINKS) : 0;
      const happy = mHappy(t);
      let lx = 0, ly = 0;
      for (let k = 0; k < 7; k++) { const g = miroGaze(t - k * .05); lx += g[0] / 7; ly += g[1] / 7; }
      lx *= awake; ly *= awake;
      let twL = 0, twR = 0;
      for (const [te, a, side] of M_TWITCH) { const w = wobble(t, te, 16 * a, 30, 8); if (side === 'L') twL += w; else twR += w; }
      return {
        x: MIRO_X, y: GROUND, breath, sleep, happy, eyeOpen: clamp(awake * (1 - blink) * (1 - happy)), lx, ly,
        tilt: sleep * 7 + lx * .5 + wobble(t, 8.25, 3, 9, 4) + happy * -4,
        drop: sleep * 9 - happy * 4,
        earL: -18 - sleep * 14 + twL - happy * 6, earR: 18 + sleep * 14 + twR + happy * 6,
        tuft: 7 * Math.sin(t * 1.7) + wobble(t, 8.25, 22, 13, 4) + wobble(t, 18.45, 28, 12, 3.5),
        tail: t * (1.1 - sleep * .5), tailAmp: .1 - sleep * .05 + (t > 18.45 && t < 20 ? .08 * Math.exp(-2 * (t - 18.45)) : 0),
        star: starWorld(t), starGlow: mStarGlow(t) + .25 * moteArrival(t),
        starPop: starPop(t), starRot: 4 * Math.sin(t * .8) + 72 * Ease.expoOut(clamp((t - 18.45) / .9)),
      };
    }
    function bobiPose(t) {
      const hop = bobiHop(t);
      const vy = (hop.y - bobiHop(t - .04).y) / .04;
      const sleep = bSleep(t), yawn = bYawn(t), happy = bHappy(t), amaze = bAmaze(t);
      const blink = sleep < .1 ? blinkAt(t, B_BLINKS) : 0;
      let lx = 0, ly = 0;
      for (let k = 0; k < 6; k++) { const g = bobiGaze(t - k * .05, hop.x); lx += g[0] / 6; ly += g[1] / 6; }
      lx *= 1 - sleep; ly *= 1 - sleep;
      const holdCup = 1 - ramp(t, 5.6, 6.3);
      const place = ramp(t, 5.6, 6.3) * (1 - ramp(t, 6.5, 7.1));
      const pawR = [lerp(lerp(-26, -38, holdCup), -118, place), lerp(lerp(-10, -78, holdCup), -8, place)];
      const reach = ramp(t, 11.9, 12.4, 'out') * (1 - ramp(t, 12.55, 13.0));
      const hold = ramp(t, 12.55, 13.0) * (1 - ramp(t, 24.5, 25.2));
      const set = ramp(t, 24.5, 25.2) * (1 - ramp(t, 25.4, 26));
      let pawL = [26, -10];
      pawL = [lerp(pawL[0], 118, reach), lerp(pawL[1], -168, reach)];
      pawL = [lerp(pawL[0], 36, hold), lerp(pawL[1], -86, hold)];
      pawL = [lerp(pawL[0], 96, set), lerp(pawL[1], -10, set)];
      return {
        x: hop.x, y: GROUND + hop.y, ground: GROUND, sy: hop.sy * (1 - sleep * .07) * (1 + yawn * .05), vx: hop.vx, vy,
        lean: clamp(hop.vx * -.004, -9, 9) * -1 + place * -12 + sleep * -1.5,
        sleep, yawn, happy, amaze, eyeOpen: clamp((1 - blink) * (1 - happy) * (1 - sleep) * (1 - clamp(yawn))), lx, ly,
        tilt: lx * 6 + sleep * -8 + happy * 4 + wobble(t, 5.42, 4, 10, 4),
        drop: sleep * 12 + yawn * -6,
        earL: -14 - vy * .012 + sleep * -16 + amaze * 8 + wobble(t, 5.42, 10, 16, 5) + wobble(t, 12.86, 12, 16, 5),
        earR: 14 + vy * .012 + sleep * 16 - amaze * 8 - wobble(t, 5.42, 10, 16, 5) - wobble(t, 12.86, 12, 16, 5),
        flap: 10 * Math.sin(t * 2.1) - vy * .03 + wobble(t, 5.42, 16, 12, 4),
        tailPhase: t * (1.8 - sleep * 1.3), tailAmp: .16 - sleep * .1 + clamp(Math.abs(vy) * .0006, 0, .12),
        pawL, pawR, holdCup,
      };
    }
    function noteState(n, t) {
      const p = clamp((t - n.t0) / (n.t1 - n.t0));
      let pts = n.p;
      if (n.id === 'hotpot') { const h = bobiHop(12.47); pts = [n.p[0], n.p[1], n.p[2], [h.x + 114, GROUND + h.y - 198]]; }
      let pos = bez(pts[0], pts[1], pts[2], pts[3], Ease.sine(p));
      pos = [pos[0], pos[1] + 12 * Math.sin(t * 2.2 + n.seed) * (p < 1 ? 1 : .4)];
      let rot = 7 * Math.sin(t * 1.5 + n.seed * 2), sx = .84 + .16 * Math.cos(t * 2.7 + n.seed), op = t < n.t0 ? 0 : 1, scl = 1;
      if (n.id === 'heavy' && t >= n.t1) {
        const k = ramp(t, 15.2, 16.8);
        pos[0] += Math.sin(t * 43) * 2.4 * k; pos[1] += Math.cos(t * 37) * 1.6 * k;
        rot = rot * (1 - k * .6);
        const dis = ramp(t, 16.75, 17.7, 'in');
        op = 1 - dis; scl = 1 - .1 * dis; pos[1] -= 18 * dis;
      }
      if (n.id === 'hotpot' && t >= n.t1) {
        const b = bobiPose(Math.min(t, 25.4));   // 25.4 秒松爪，纸条留在原地
        const lying = ramp(t, 25.2, 25.6);
        pos = [b.x + b.pawL[0] - 4, b.y + b.pawL[1] * b.sy - 30 + lying * 18];
        rot = lerp(-8 + 4 * Math.sin(t * 1.3), 14, lying); sx = 1; scl = .82;
      }
      if (n.id !== 'hotpot' && n.id !== 'heavy' && t >= n.t1) op = 0;
      return { pos, rot, sx, op, scl };
    }
    function cupPose(t) {
      const P = bobiPose(t);
      const pr = [P.pawR[0], P.pawR[1] * (P.pawR[1] < -60 ? 1 : P.sy)];
      const a = P.lean * Math.PI / 180, lx = pr[0] + 2, ly = pr[1] + 8;
      return [P.x + lx * Math.cos(a) - ly * Math.sin(a), P.y + lx * Math.sin(a) + ly * Math.cos(a), P.lean * .6];
    }
    const CUP_REST = cupPose(CUP_DOWN);

    /* ── 场景图 ── */
    const noteSvg = NOTES.map(n => {
      const r = rng(n.seed), w = n.text.length * 30 + 44, h = 64, pts = [];
      for (let x = 0; x <= w; x += 10) pts.push([x - w / 2, -h / 2 + (r() - .5) * 4]);
      pts.push([w / 2 + (r() - .5) * 3, 0]);
      for (let x = w; x >= 0; x -= 9) pts.push([x - w / 2, h / 2 + (r() - .5) * 7]);
      n.w = w; n.h = h; n.d = `M${pts.map(q => f(q[0]) + ',' + f(q[1])).join(' L')} Z`;
      return `<g id="note-${n.id}" opacity="0"><g id="noteIn-${n.id}"><image x="${-w / 2 - 20}" y="${-h / 2 - 20}" width="${w + 40}" height="${h + 40}"/></g></g>`;
    }).join('');
    const motes = MOTES.map((m, i) => m.big ? `<path id="mote-${i}" d="${sparkle(m.size * 1.8)}" fill="#FFE08A" opacity="0"/>` : `<circle id="mote-${i}" r="${m.size}" fill="#FFD66E" opacity="0"/>`).join('');
    const burst = BURST_A.map((_, i) => `<path id="burst-${i}" d="${sparkle(i % 2 ? 12 : 18)}" fill="#FFD467" opacity="0"/>`).join('');
    const sc = createScene(
      `${cupMarkup()}${miroMarkup()}${bobiMarkup()}<g id="notes">${noteSvg}</g>
       <circle id="ring" r="10" fill="none" stroke="#FFE6A0" stroke-width="6" opacity="0"/><g id="motes">${motes}</g><g id="burst">${burst}</g>`,
      `<g id="gsky">
         <g id="moonG" opacity="0"><circle r="190" fill="url(#gl-moon)"/><image id="moonImg" x="-70" y="-70" width="140" height="140"/></g>
         ${STARS.map((s, i) => s.big
    ? `<path id="star-${i}" d="${sparkle(s.size)}" fill="#FFF0C8" transform="translate(${s.x} ${s.y})" opacity="0"/>`
    : `<circle id="star-${i}" cx="${s.x}" cy="${s.y}" r="${s.size}" fill="#FFF3D6" opacity="0"/>`).join('')}
       </g>
       <g id="gcam">${miroGlowMarkup()}
         <circle id="g-flash" r="260" fill="url(#gl-star)" opacity="0"/>
         ${MOTES.map((m, i) => `<circle id="gmote-${i}" r="${m.size * 5}" fill="url(#gl-dot)" opacity="0"/>`).join('')}
         ${FLIES.map((_, i) => `<circle id="fly-${i}" r="9" fill="url(#gl-dot)" opacity="0"/>`).join('')}
       </g>`);
    const { el, setT, setA, put } = sc;

    /* ── 背景：生成一次，画进位图 ── */
    function stickerFilter(id, { edge = 4, shadow = .12, dx = 3, dy = 6 } = {}) {
      return `<filter id="${id}" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
        <feGaussianBlur in="SourceAlpha" stdDeviation="${edge}" result="b"/>
        <feComponentTransfer in="b" result="dil"><feFuncA type="linear" slope="12" intercept="-0.5"/></feComponentTransfer>
        <feFlood flood-color="${C.stickerEdge}"/><feComposite in2="dil" operator="in" result="edge"/>
        <feGaussianBlur in="dil" stdDeviation="7" result="sb"/><feOffset in="sb" dx="${dx}" dy="${dy}" result="so"/>
        <feFlood flood-color="${C.shadow}" flood-opacity="${shadow}"/><feComposite in2="so" operator="in" result="shade"/>
        <feMerge><feMergeNode in="shade"/><feMergeNode in="edge"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
    }
    async function raster(inner, [x, y, w, h], res) {
      const svg = `<svg xmlns="${NS}" width="${Math.round(w * res)}" height="${Math.round(h * res)}" viewBox="${x} ${y} ${w} ${h}">${inner}</svg>`;
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      await img.decode();
      const c = document.createElement('canvas');
      c.width = Math.round(w * res); c.height = Math.round(h * res);
      c.getContext('2d').drawImage(img, 0, 0);
      c._r = [x, y, w, h];
      return c;
    }
    const BG = { sun: [], clouds: [], far: [], mid: [], near: [] };
    let paperCv = null;
    async function buildBackground() {
      const sun = (disc, inner) => `<defs>${stickerFilter('s', { shadow: .12 })}
        <radialGradient id="h"><stop offset="0" stop-color="#FFE7B5" stop-opacity=".75"/><stop offset="1" stop-color="#FFE7B5" stop-opacity="0"/></radialGradient></defs>
        <circle r="230" fill="url(#h)"/><g filter="url(#s)"><circle r="78" fill="${disc}"/><circle r="54" cx="-10" cy="-10" fill="${inner}"/></g>`;
      const cloud = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})"><path d="M-120,20 C-128,-6 -100,-26 -74,-18 C-66,-50 -20,-62 4,-38 C22,-66 78,-58 84,-22 C112,-26 132,0 120,20 Z" fill="#FFF8EC"/><path d="M-110,20 C-80,10 60,12 116,20 Z" fill="#F1E4CF"/></g>`;
      const tuft = (x, y, s = 1, c = '#A9BB8E') => `<path transform="translate(${x} ${y}) scale(${s})" d="M-14,0 C-14,-10 -18,-20 -22,-26 C-12,-20 -8,-12 -6,-4 C-6,-16 -2,-28 2,-34 C4,-24 4,-14 3,-4 C6,-12 12,-20 20,-24 C16,-14 14,-6 14,0 Z" fill="${c}"/>`;
      const flower = (x, y, c) => `<g transform="translate(${x} ${y})"><path d="M0,0 L0,-26" stroke="#9DB083" stroke-width="3" stroke-linecap="round"/>${[0, 72, 144, 216, 288].map(a => `<ellipse cx="0" cy="-7" rx="4.5" ry="7" fill="${c}" transform="translate(0 -30) rotate(${a})"/>`).join('')}<circle cy="-30" r="4" fill="#F4C65E"/></g>`;
      const [s1, s2, cl, far, mid, near, paper] = await Promise.all([
        raster(sun('#F7C66C', '#FADA96'), [-240, -240, 480, 480], 1.2),
        raster(sun('#EE8A4E', '#F6AE6E'), [-240, -240, 480, 480], 1.2),
        raster(`<defs>${stickerFilter('c', { shadow: .14 })}</defs><g filter="url(#c)">${cloud(330, 250, 1.0)}${cloud(1380, 170, .8)}${cloud(1760, 330, .62)}${cloud(820, 120, .55)}</g>`, [120, 40, 1860, 330], 1),
        raster(`<defs>${stickerFilter('f', { shadow: .1, dx: 2, dy: 5 })}</defs><g filter="url(#f)"><path d="M-300,1200 L-300,640 C-60,560 180,600 420,640 C640,560 900,520 1160,610 C1420,560 1700,540 2220,620 L2220,1200 Z" fill="${C.far}"/></g>`, [-320, 480, 2560, 740], .75),
        raster(`<defs>${stickerFilter('m', { shadow: .14 })}</defs><g filter="url(#m)"><path d="M-300,1200 L-300,730 C-40,690 240,660 520,720 C700,690 820,700 900,720 C1150,660 1500,650 1760,700 C1960,680 2100,690 2220,700 L2220,1200 Z" fill="${C.mid}"/><path d="M1500,700 C1560,690 1640,688 1700,694 C1640,702 1570,708 1500,700 Z" fill="#C3D1B3"/></g>`, [-320, 620, 2560, 600], .9),
        raster(`<defs>${stickerFilter('n', { dx: 2, dy: -3 })}<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.ground}"/><stop offset="1" stop-color="${C.groundD}"/></linearGradient></defs>
          <g filter="url(#n)"><path d="M-300,1300 L-300,860 C200,812 560,798 900,800 C1260,802 1640,812 2220,780 L2220,1300 Z" fill="url(#g)"/></g>
          <g>${tuft(470, 812, 1.1)}${tuft(560, 806, .8, '#B7C79B')}${tuft(1330, 806, 1)}${tuft(1420, 808, .75, '#B7C79B')}${tuft(1690, 806, 1.2)}${tuft(230, 826, .9)}
          ${flower(610, 806, '#FFF4E4')}${flower(1480, 806, '#F6C3C3')}${flower(1520, 812, '#FFF4E4')}${flower(300, 822, '#F6C3C3')}
          <path d="M600,900 C760,890 980,888 1180,896" stroke="#C6CFA0" stroke-width="5" stroke-linecap="round" fill="none" opacity=".7"/>
          <path d="M300,960 C420,952 560,952 640,958" stroke="#C6CFA0" stroke-width="5" stroke-linecap="round" fill="none" opacity=".6"/></g>`, [-320, 740, 2560, 580], 1.35),
        raster(`<rect x="-10" y="-10" width="1940" height="1100" fill="#fff"/>
          <filter id="m"><feTurbulence type="fractalNoise" baseFrequency=".006 .009" numOctaves="4" seed="8"/><feColorMatrix values="0 0 0 0 .96  0 0 0 0 .92  0 0 0 0 .84  0 0 0 -1.3 1.05"/></filter>
          <rect width="1920" height="1080" filter="url(#m)" opacity=".55"/>
          <filter id="fb"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="1" seed="2"/><feColorMatrix values="0 0 0 0 .55  0 0 0 0 .47  0 0 0 0 .38  0 0 0 -2.2 1.1"/></filter>
          <rect width="1920" height="1080" filter="url(#fb)" opacity=".19"/>
          <radialGradient id="v" cx=".5" cy=".46" r=".75"><stop offset=".62" stop-color="#fff"/><stop offset="1" stop-color="#C9BDB1"/></radialGradient>
          <rect width="1920" height="1080" fill="url(#v)" style="mix-blend-mode:multiply"/>`, [0, 0, 1920, 1080], 1),
      ]);
      s2._sunset = true;
      BG.sun = [s1, s2]; BG.clouds = [cl]; BG.far = [far]; BG.mid = [mid]; BG.near = [near];
      // 颗粒：只取暗噪点（multiply 下亮点无效），烘焙进纸纹
      const x = paper.getContext('2d'), img = x.getImageData(0, 0, paper.width, paper.height), r = rng(3);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = r(); if (v < .5) continue;
        const k = 1 - Math.pow((v - .5) * 2, 3) * .11;
        img.data[i] *= k; img.data[i + 1] *= k; img.data[i + 2] *= k;
      }
      x.putImageData(img, 0, 0);
      paperCv = paper;
    }
    /** 纸条与月牙烘焙成位图（纸条要等字体） */
    function bakeNotes() {
      const R = 2;
      NOTES.forEach(n => {
        const W2 = n.w + 40, H2 = n.h + 40, c = document.createElement('canvas');
        c.width = W2 * R; c.height = H2 * R;
        const x = c.getContext('2d');
        x.scale(R, R); x.translate(W2 / 2, H2 / 2);
        const path = new Path2D(n.d);
        x.save(); x.translate(4, 7); x.fillStyle = 'rgba(91,70,51,.2)'; x.fill(path); x.restore();
        x.fillStyle = C.note; x.fill(path);
        x.strokeStyle = '#EBDDC4'; x.lineWidth = 2; x.lineCap = 'round'; x.setLineDash([2, 6]);
        x.beginPath(); x.moveTo(-n.w / 2 + 14, n.h / 2 - 12); x.lineTo(n.w / 2 - 14, n.h / 2 - 12); x.stroke();
        x.fillStyle = C.noteInk; x.font = `27px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'alphabetic';
        x.fillText(n.text, 0, 9);
        el[`noteIn-${n.id}`].firstElementChild._img = c;
      });
      const m = document.createElement('canvas'); m.width = m.height = 280;
      const x = m.getContext('2d'); x.scale(2, 2); x.translate(70, 70);
      x.fillStyle = '#FFF0C6'; x.beginPath(); x.arc(0, 0, 62, 0, TAU); x.fill();
      x.globalCompositeOperation = 'destination-out'; x.beginPath(); x.arc(30, -18, 54, 0, TAU); x.fill();
      el.moonImg._img = m;
    }

    /* ── 逐帧：姿态 → 场景图 ── */
    const CAM = {};
    function update(t) {
      const hx = 3 * Math.sin(t * .7) + 1.6 * Math.sin(t * 1.9 + 1), hy = 2.2 * Math.sin(t * .9 + 2) + 1.2 * Math.sin(t * 2.3);
      CAM.z = CAM_Z0 * camZ(t); CAM.fx = camX(t) + hx; CAM.fy = camY(t) + CAM_DY + hy; CAM.t = t;
      const svgT = d => { const zd = 1 + (CAM.z - 1) * d, cx = 960 + (CAM.fx - 960) * d, cy = 540 + (CAM.fy - 540) * d; return `translate(960 540) scale(${zd.toFixed(4)}) translate(${f(-cx)} ${f(-cy)})`; };
      put(el.gsky, 'transform', svgT(.1));
      const g = svgT(1); put(el.cam, 'transform', g); put(el.gcam, 'transform', g);
      const night = nightK(t), warm = warmK(t);
      CAM.night = night; CAM.warm = warm;
      setT('moonG', `translate(330 ${f(moonY(t))})`); setA('moonG', 'opacity', f(ramp(t, 24.5, 29)));
      if (t > 24.5) STARS.forEach((s, i) => {
        const tw = .55 + .45 * Math.sin(t * s.sp + s.ph), vis = ramp(t, 25 + (i % 9) * .35, 27 + (i % 9) * .35);
        setA(`star-${i}`, 'opacity', f(vis * tw));
        if (s.big) setT(`star-${i}`, `translate(${f(s.x)} ${f(s.y)}) scale(${f(.8 + .25 * tw)})`);
      });
      applyMiro(sc, miroPose(t), t, night);
      const B = bobiPose(t);
      const { pr } = applyBobi(sc, B, t);
      // 水杯：端在右爪 → 放在两只猫之间
      let cup;
      if (t < CUP_DOWN) { const a = B.lean * Math.PI / 180, lx = pr[0] + 2, ly = pr[1] + 8; cup = [B.x + lx * Math.cos(a) - ly * Math.sin(a), B.y + lx * Math.sin(a) + ly * Math.cos(a), B.lean * .6]; }
      else cup = [CUP_REST[0], GROUND, 0];
      setT('cupG', t < 3 ? 'translate(-9999 0)' : T(cup[0], cup[1], cup[2]));
      setA('cupWater', 'd', `M-16.4,-28 Q0,${f(-24 + 3 * Math.sin(t * 6) * Math.exp(-Math.max(0, t - 6.3) * 2))} 16.4,-28 L14,0 L-14,0 Z`);
      sc.boil('cupStk', t, 3);
      NOTES.forEach(n => {
        const s = noteState(n, t);
        setT(`note-${n.id}`, T(s.pos[0], s.pos[1], s.rot, s.scl));
        setT(`noteIn-${n.id}`, `scale(${f(s.sx)} 1)`);
        setA(`note-${n.id}`, 'opacity', f(s.op));
      });
      const src = noteState(NOTES[0], 16.9).pos;
      MOTES.forEach((m, i) => {
        const p = (t - m.ts) / m.dur;
        if (!(p > 0 && p < 1)) { setA(`mote-${i}`, 'opacity', 0); setA(`gmote-${i}`, 'opacity', 0); return; }
        const end = starWorld(t), p0 = [src[0] + m.ox, src[1] + m.oy];
        const pos = bez(p0, [p0[0] + m.c1[0], p0[1] + m.c1[1]], [end[0] + m.c2[0], end[1] + m.c2[1]], end, Ease.inOut(p));
        const a = Math.min(1, p * 6) * (1 - Math.pow(p, 6));
        if (m.big) setT(`mote-${i}`, T(pos[0], pos[1], m.spin * p, 1 - .4 * p));
        else { setA(`mote-${i}`, 'cx', f(pos[0])); setA(`mote-${i}`, 'cy', f(pos[1])); }
        setA(`mote-${i}`, 'opacity', f(a));
        setA(`gmote-${i}`, 'cx', f(pos[0])); setA(`gmote-${i}`, 'cy', f(pos[1])); setA(`gmote-${i}`, 'opacity', f(a * (.45 + .55 * night)));
      });
      const d = t - 18.45, star = starWorld(t);
      if (d >= 0 && d < 1.4) {
        const p = d / 1.2;
        setA('ring', 'r', f(40 + 280 * Ease.expoOut(clamp(p)))); setA('ring', 'stroke-width', f(7 * (1 - clamp(p))));
        setA('ring', 'cx', f(star[0])); setA('ring', 'cy', f(star[1])); setA('ring', 'opacity', f(clamp(1 - p)));
        BURST_A.forEach((ang, i) => {
          const q = clamp(d / 1.1), r = 50 + 150 * Ease.expoOut(q) * (i % 2 ? .75 : 1);
          setT(`burst-${i}`, T(star[0] + Math.cos(ang) * r, star[1] + Math.sin(ang) * r, q * 120, (1 - q) * 1.1));
          setA(`burst-${i}`, 'opacity', f(1 - Ease.in(q)));
        });
      } else { setA('ring', 'opacity', 0); BURST_A.forEach((_, i) => setA(`burst-${i}`, 'opacity', 0)); }
      setT('g-flash', `translate(${f(star[0])} ${f(star[1])}) scale(${f(.6 + 1.2 * Ease.expoOut(clamp(d / .9)))})`);
      setA('g-flash', 'opacity', f(d >= 0 ? .9 * Math.exp(-3.2 * d) : 0));
      FLIES.forEach((fl, i) => {
        const vis = ramp(t, 27 + i * .4, 29 + i * .4) * night;
        setA(`fly-${i}`, 'cx', f(fl.x + fl.ax * Math.sin(t * fl.sp + fl.ph)));
        setA(`fly-${i}`, 'cy', f(fl.y + fl.ay * Math.sin(t * fl.sp * 1.3 + fl.ph * 2)));
        setA(`fly-${i}`, 'opacity', f(vis * (.5 + .5 * Math.sin(t * 1.7 + fl.ph))));
      });
    }

    /* ── 合成：一张 canvas 完成全部混合，页面上没有任何 CSS 混合层 ── */
    const cv = makeCanvas(container), ctx = cv.getContext('2d', { alpha: false });
    const glow = document.createElement('canvas'), off = document.createElement('canvas');
    let W = 0, H = 0, S = 1, OX = 0, OY = 0, ready = false;
    const PAR = [['sun', .08], ['clouds', .18], ['far', .32], ['mid', .6], ['near', 1]];
    function paint() {
      if (!W || !ready) return;
      const t = CAM.t, dpr = dprOf(), k = S * dpr, ox = OX * dpr, oy = OY * dpr;
      const base = [k, 0, 0, k, ox, oy];
      ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#1B1714'; ctx.fillRect(0, 0, cv.width, cv.height);
      ctx.setTransform(...base);
      ctx.fillStyle = C.paper; ctx.fillRect(0, 0, 1920, 1080);
      SKIES.forEach(([, a, b], i) => {
        const v = skyK[i](t); if (v < .002) return;
        const g = ctx.createLinearGradient(0, -114, 0, 746); g.addColorStop(0, a); g.addColorStop(1, b);
        ctx.globalAlpha = v; ctx.fillStyle = g; ctx.fillRect(0, 0, 1920, 1080);
      });
      for (const [id, dep] of PAR) {
        const zd = 1 + (CAM.z - 1) * dep, cx = 960 + (CAM.fx - 960) * dep, cy = 540 + (CAM.fy - 540) * dep;
        ctx.setTransform(k * zd, 0, 0, k * zd, ox + k * (960 - cx * zd), oy + k * (540 - cy * zd));
        if (id === 'sun') ctx.translate(sunX(t), sunY(t));
        if (id === 'clouds') ctx.translate(-6 * t, 0);
        for (const c of BG[id]) {
          const a = c._sunset ? ramp(t, 15, 24) : 1;
          if (a < .002) continue;
          ctx.globalAlpha = a; ctx.drawImage(c, ...c._r);
        }
      }
      ctx.globalAlpha = 1;
      drawTree(sc, ctx, off, base, sc.svgMain, true);
      // 纸纹 × 暖光 × 夜色（画布此时完全不透明，multiply 没有透明度问题）
      ctx.setTransform(...base);
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(paperCv, 0, 0, 1920, 1080);
      const tint = [0, 1, 2].map(i => (1 - CAM.warm + CAM.warm * WARM[i]) * (1 - CAM.night + CAM.night * NIGHT[i]));
      if (tint.some(v => v < .999)) { ctx.fillStyle = `rgb(${tint.map(v => Math.round(v * 255)).join(',')})`; ctx.fillRect(0, 0, 1920, 1080); }
      // 发光：半分辨率画好，screen 叠上来
      const gx = glow.getContext('2d');
      gx.setTransform(1, 0, 0, 1, 0, 0); gx.clearRect(0, 0, glow.width, glow.height);
      drawTree(sc, gx, off, base.map(v => v / 2), sc.svgGlow, false);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(glow, 0, 0, cv.width, cv.height);
      ctx.globalCompositeOperation = 'source-over';
      // 字幕与曝光
      ctx.setTransform(...base);
      const ca = ramp(t, 36.2, 37.6, 'out');
      if (caption && ca > .002) {
        ctx.globalAlpha = ca; ctx.font = `44px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        if ('letterSpacing' in ctx) ctx.letterSpacing = '6px';
        ctx.shadowColor = 'rgba(255,214,140,.45)'; ctx.shadowBlur = 18;
        ctx.fillStyle = '#F6EAD2'; ctx.fillText(caption, 960, 930 + 14 * (1 - ramp(t, 36.2, 37.8, 'expoOut')));
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }
      const ex = exposure(t);
      if (ex > .002) { ctx.globalAlpha = ex; ctx.fillStyle = C.paper; ctx.fillRect(-10, -10, 1940, 1100); ctx.globalAlpha = 1; }
    }

    /* ── 时钟 ── */
    let time = clamp(+opts.start || 0, 0, FILM_DUR - .001), playing = opts.autoplay !== false, raf = 0, lastTs = null, visible = true;
    const reduce = !!opts.reduceMotion;
    function render(t) { update(t); paint(); if (opts.onTime) opts.onTime(t); }
    function tick(ts) {
      raf = 0;
      if (lastTs === null) lastTs = ts;
      const dt = Math.min(.1, (ts - lastTs) / 1000); lastTs = ts;
      if (playing && visible) {
        let t = time + dt;
        if (t >= FILM_DUR) { if (loop) t = 0; else { t = FILM_DUR - .001; playing = false; } }
        time = t; render(time);
      }
      if (playing && visible) raf = root.requestAnimationFrame(tick);
    }
    function start() { if (!raf && playing && visible && ready && !reduce) { lastTs = null; raf = root.requestAnimationFrame(tick); } }
    const stopSize = watchSize(container, (w, h) => {
      W = w; H = h;
      S = fit === 'cover' ? Math.max(w / 1920, h / 1080) : Math.min(w / 1920, h / 1080);
      OX = (w - 1920 * S) / 2; OY = (h - 1080 * S) / 2;
      // cover 裁切时让角色保持在画面里：竖屏向左右裁，焦点放在两只猫之间
      if (fit === 'cover' && w / h < 16 / 9) OX = Math.min(0, Math.max(w - 1920 * S, w / 2 - 985 * S));
      const d = dprOf();
      cv.width = Math.round(w * d); cv.height = Math.round(h * d);
      glow.width = Math.max(1, cv.width >> 1); glow.height = Math.max(1, cv.height >> 1);
      off.width = glow.width; off.height = glow.height;
      if (ready) render(time);
    });
    let io = null;
    if (opts.autoPause !== false && root.IntersectionObserver) {
      io = new IntersectionObserver(es => { visible = es[0].isIntersecting; if (visible) start(); }, { threshold: .05 });
      io.observe(container);
    }
    const onVis = () => { visible = !document.hidden; if (visible) start(); };
    document.addEventListener('visibilitychange', onVis);

    const readyP = (async () => {
      await buildBackground();
      if (document.fonts && document.fonts.load) {
        await Promise.race([document.fonts.load(`27px ${FONT}`, NOTES.map(n => n.text).join('') + caption).catch(() => {}), new Promise(r => setTimeout(r, 2500))]);
      }
      bakeNotes();
      ready = true;
      if (reduce) time = opts.posterTime == null ? 19.2 : opts.posterTime;
      render(time);
      start();
    })();

    return {
      ready: readyP,
      play() { playing = true; start(); },
      pause() { playing = false; if (raf) { root.cancelAnimationFrame(raf); raf = 0; } },
      seek(t) { time = clamp(t, 0, FILM_DUR - .001); if (ready) render(time); },
      get time() { return time; },
      get playing() { return playing; },
      duration: FILM_DUR,
      destroy() { this.pause(); stopSize(); if (io) io.disconnect(); document.removeEventListener('visibilitychange', onVis); cv.remove(); },
    };
  }

  root.PetRig = { mountPet, mountFilm, version: VERSION, moods: MOODS.slice() };
})(typeof window !== 'undefined' ? window : globalThis);
