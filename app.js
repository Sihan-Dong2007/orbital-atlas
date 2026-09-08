(function(){
  "use strict";
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------------- renderer / scene / camera ----------------
  var glCanvas = document.getElementById('gl');
  var fx = document.getElementById('fx');
  var fctx = fx.getContext('2d');
  var renderer = new THREE.WebGLRenderer({ canvas:glCanvas, antialias:true, powerPreference:'high-performance' });
  renderer.setClearColor(0x03040a, 1);
  var clearColorCurrent = new THREE.Color(0x03040a);
  var clearColorTarget = new THREE.Color(0x03040a);
  var scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x03040a, 0.00075);
  var SEASON_TINT = { Winter:0x1c3350, Spring:0x123324, Summer:0x3a2214, Autumn:0x2e1c33 };
  var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
  var W=0,H=0;

  // gravitational-lensing composite pass: render scene to a target, then
  // sample it through a radial-warp shader centered on the black hole.
  var lensRT = new THREE.WebGLRenderTarget(2,2, { minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter, format:THREE.RGBAFormat });
  var lensScene = new THREE.Scene();
  var lensCam = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
  var lensUniforms = { tDiffuse:{value:lensRT.texture}, lensCenter:{value:new THREE.Vector2(0.5,0.5)}, lensStrength:{value:0} };
  var _lensProj = new THREE.Vector3();
  var lensMat = new THREE.ShaderMaterial({
    uniforms: lensUniforms,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position,1.0); }',
    fragmentShader: [
      'uniform sampler2D tDiffuse; uniform vec2 lensCenter; uniform float lensStrength; varying vec2 vUv;',
      'void main(){',
      '  vec2 diff = vUv - lensCenter;',
      '  float dist = length(diff);',
      '  vec2 dir = dist > 0.00001 ? diff/dist : vec2(0.0,0.0);',
      '  float bend = lensStrength / (dist*dist*3.2 + 0.006);',
      '  bend = min(bend, 0.46);',
      '  vec2 uv = clamp(vUv + dir*bend, 0.0, 1.0);',
      '  vec4 col = texture2D(tDiffuse, uv);',
      '  float ringGlow = smoothstep(0.09,0.02,dist) * lensStrength * 1.4;',
      '  col.rgb += vec3(1.0,0.75,0.4) * ringGlow * (1.0-smoothstep(0.0,0.02,dist));',
      '  gl_FragColor = col;',
      '}'
    ].join('\n'),
    depthTest:false, depthWrite:false
  });
  lensScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2), lensMat));

  function resize(){
    W = window.innerWidth; H = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio||1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(W,H);
    lensRT.setSize(W*dpr, H*dpr);
    fx.width = W*dpr; fx.height = H*dpr;
    fx.style.width=W+'px'; fx.style.height=H+'px';
    fctx.setTransform(dpr,0,0,dpr,0,0);
    camera.aspect = W/H; camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  var ambient = new THREE.AmbientLight(0x33344a, 0.9);
  scene.add(ambient);
  var sunLight = new THREE.PointLight(0xfff2d8, 2.6, 0, 0.6);
  scene.add(sunLight);

  // ---------------- utils ----------------
  function lerp(a,b,t){ return a+(b-a)*t; }
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
  function easeOutCubic(t){ return 1-Math.pow(1-t,3); }
  function easeInOutCubic(t){ return t<0.5 ? 4*t*t*t : 1-Math.pow(-2*t+2,3)/2; }
  function rand(a,b){ return a+Math.random()*(b-a); }
  function damp(cur, target, lambda, dt){ return lerp(cur, target, 1-Math.exp(-lambda*dt)); }
  function sumWeights(w){ var s=0; for(var i=0;i<w.length;i++) s+=w[i]; return s; }
  function beatLookup(baseDur, weights, tMs){
    var t = Math.max(0, tMs/1000);
    var acc = 0;
    for(var i=0;i<weights.length;i++){
      var dur = baseDur*weights[i];
      if(t < acc+dur || i===weights.length-1){ return { idx:i, beatT:t-acc, beatDur:dur }; }
      acc += dur;
    }
    return { idx:0, beatT:0, beatDur:baseDur*weights[0] };
  }

  function makeGlowTexture(hex){
    var c = document.createElement('canvas'); c.width=128; c.height=128;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(64,64,0,64,64,64);
    var col = new THREE.Color(hex);
    var r=Math.round(col.r*255), gg=Math.round(col.g*255), b=Math.round(col.b*255);
    grad.addColorStop(0,'rgba('+r+','+gg+','+b+',1)');
    grad.addColorStop(0.4,'rgba('+r+','+gg+','+b+',0.55)');
    grad.addColorStop(1,'rgba('+r+','+gg+','+b+',0)');
    g.fillStyle=grad; g.fillRect(0,0,128,128);
    var tex = new THREE.CanvasTexture(c);
    return tex;
  }
  var glowWarm = makeGlowTexture(0xffd9a0);
  var glowCyan = makeGlowTexture(0x8ff5f7);
  var glowWhite = makeGlowTexture(0xffffff);

  function hexRgba(hex, a){
    var col = new THREE.Color(hex);
    return 'rgba('+Math.round(col.r*255)+','+Math.round(col.g*255)+','+Math.round(col.b*255)+','+a+')';
  }
  function softBlob(g, cx, cy, rx, ry, hex, alpha){
    if(rx<=0 || ry<=0) return;
    g.save();
    g.translate(cx, cy);
    g.scale(rx, ry);
    var grad = g.createRadialGradient(0,0,0, 0,0,1);
    grad.addColorStop(0, hexRgba(hex, alpha));
    grad.addColorStop(0.65, hexRgba(hex, alpha*0.5));
    grad.addColorStop(1, hexRgba(hex, 0));
    g.fillStyle = grad;
    g.beginPath(); g.arc(0,0,1,0,Math.PI*2); g.fill();
    g.restore();
  }
  function makePlanetTexture(spec){
    var w = 256, h = 128, sc = 3, W = w*sc, H = h*sc;
    var big = document.createElement('canvas'); big.width=W; big.height=H;
    var g = big.getContext('2d');
    g.fillStyle = spec.base; g.fillRect(0,0,W,H);

    if(spec.bands){
      spec.bands.forEach(function(b){
        var cy = (b.y0+b.y1)/2*H, ry = Math.max(6,(b.y1-b.y0)/2*H*1.2);
        softBlob(g, W/2, cy, W*0.7, ry, b.color, b.alpha!==undefined?b.alpha:0.5);
      });
    }
    for(var i=0;i<(spec.turbulence||0);i++){
      var y = rand(0,H);
      g.strokeStyle = 'rgba(255,255,255,'+rand(0.02,0.05)+')';
      g.lineWidth = rand(3*sc*0.5,6*sc*0.5);
      g.beginPath(); g.moveTo(0,y);
      for(var x=16;x<=W;x+=22){ y += rand(-3,3); g.lineTo(x,y); }
      g.stroke();
    }
    if(spec.spot){
      softBlob(g, spec.spot.x*W, spec.spot.y*H, spec.spot.rx*W, spec.spot.ry*H, spec.spot.colorHex, spec.spot.alpha!==undefined?spec.spot.alpha:0.75);
    }
    if(spec.craters){
      for(var k=0;k<spec.craters;k++){
        var rr = rand(3,9)*sc*0.55;
        softBlob(g, rand(0,W), rand(0,H), rr, rr, '#000000', rand(0.1,0.22));
      }
    }
    if(spec.blotches){
      for(var m=0;m<spec.blotches;m++){
        softBlob(g, rand(0,W), rand(h*0.14,h*0.86)*sc, rand(9,24)*sc*0.6, rand(5,13)*sc*0.6, spec.blotchColor, rand(0.35,0.6));
      }
    }
    if(spec.clouds){
      for(var n=0;n<spec.clouds;n++){
        softBlob(g, rand(0,W), rand(0,H), rand(13,32)*sc*0.55, rand(4,9)*sc*0.55, '#ffffff', rand(0.2,0.4));
      }
    }
    if(spec.polarCaps){
      softBlob(g, W/2, 0, W*0.48, H*0.2, '#f4f0e6', 0.8);
      softBlob(g, W/2, H, W*0.48, H*0.18, '#f4f0e6', 0.75);
    }
    var c = document.createElement('canvas'); c.width=w; c.height=h;
    var cg = c.getContext('2d');
    cg.imageSmoothingEnabled = true;
    cg.drawImage(big, 0, 0, w, h);
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    return tex;
  }

  function makeGlowSprite(tex, size, color, opacity){
    var mat = new THREE.SpriteMaterial({ map:tex, color:color!==undefined?color:0xffffff, transparent:true, opacity:opacity!==undefined?opacity:1, depthWrite:false, blending:THREE.AdditiveBlending });
    var s = new THREE.Sprite(mat);
    s.scale.set(size,size,1);
    return s;
  }

  function makeStarField(count, rMin, rMax, colorHex, size){
    var pos = new Float32Array(count*3);
    for(var i=0;i<count;i++){
      var r = rand(rMin,rMax);
      var th = Math.random()*Math.PI*2;
      var ph = Math.acos(rand(-1,1));
      pos[i*3] = r*Math.sin(ph)*Math.cos(th);
      pos[i*3+1] = r*Math.cos(ph)*0.6;
      pos[i*3+2] = r*Math.sin(ph)*Math.sin(th);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos,3));
    var mat = new THREE.PointsMaterial({ color:colorHex, size:size, map:glowWhite, transparent:true, opacity:0.85, depthWrite:false, blending:THREE.AdditiveBlending, sizeAttenuation:true });
    return new THREE.Points(geo, mat);
  }

  // shared holographic grid (used by solar system floor, black hole well, LIGO ripple, scale transitions)
  function buildGrid(cols, rows, spacing, colorHex, opacity){
    var segs = [];
    for(var j=0;j<=rows;j++){ for(var i=0;i<cols;i++){ segs.push([i,j,i+1,j]); } }
    for(var i2=0;i2<=cols;i2++){ for(var j2=0;j2<rows;j2++){ segs.push([i2,j2,i2,j2+1]); } }
    var positions = new Float32Array(segs.length*2*3);
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions,3));
    var mat = new THREE.LineBasicMaterial({ color:colorHex, transparent:true, opacity:opacity, blending:THREE.AdditiveBlending, depthWrite:false });
    var mesh = new THREE.LineSegments(geo, mat);
    function update(dipFn, t){
      var arr = geo.attributes.position.array;
      var k=0;
      for(var s=0;s<segs.length;s++){
        var seg = segs[s];
        for(var e=0;e<2;e++){
          var gi = seg[e*2], gj = seg[e*2+1];
          var x = (gi-cols/2)*spacing, z=(gj-rows/2)*spacing;
          var y = dipFn(x,z,t);
          arr[k++]=x; arr[k++]=y; arr[k++]=z;
        }
      }
      geo.attributes.position.needsUpdate = true;
    }
    return { mesh:mesh, update:update };
  }
  function wellDip(mx,mz,mass,soften){ return function(x,z){ var d=Math.sqrt((x-mx)*(x-mx)+(z-mz)*(z-mz)); return -mass/(d+soften); }; }
  function rippleDip(mass){ return function(x,z,t){ var d=Math.sqrt(x*x+z*z); return Math.sin(d*0.22 - t*3.5)*mass*Math.exp(-d*0.0045); }; }

  function ellipseLoop(rx, rz, colorHex, opacity, segments){
    segments = segments||96;
    var pts=[];
    for(var i=0;i<=segments;i++){ var a=i/segments*Math.PI*2; pts.push(new THREE.Vector3(Math.cos(a)*rx,0,Math.sin(a)*rz)); }
    var geo = new THREE.BufferGeometry().setFromPoints(pts);
    var mat = new THREE.LineBasicMaterial({ color:colorHex, transparent:true, opacity:opacity, blending:THREE.AdditiveBlending, depthWrite:false });
    return new THREE.LineLoop(geo, mat);
  }

  // ---------------- camera director ----------------
  var camPos = new THREE.Vector3(0,40,260);
  var camLook = new THREE.Vector3(0,0,0);
  var targetPos = camPos.clone();
  var targetLook = camLook.clone();
  camera.position.copy(camPos);
  function setCameraTarget(pos, look){ targetPos.copy(pos); targetLook.copy(look); }
  function updateCamera(dt){
    var lam = reduced ? 6 : 1.6;
    camPos.x = damp(camPos.x, targetPos.x, lam, dt); camPos.y = damp(camPos.y, targetPos.y, lam, dt); camPos.z = damp(camPos.z, targetPos.z, lam, dt);
    camLook.x = damp(camLook.x, targetLook.x, lam*1.1, dt); camLook.y = damp(camLook.y, targetLook.y, lam*1.1, dt); camLook.z = damp(camLook.z, targetLook.z, lam*1.1, dt);
    camera.position.copy(camPos);
    camera.lookAt(camLook);
  }

  // ================= ACT 1 : NIGHT SKY =================
  var CONSTELLATIONS = [
    { name:'Orion', myth:'The Hunter — anchored by red supergiant Betelgeuse and blue-giant Rigel, Orion is visible from nearly everywhere on Earth.', meta:[['BRIGHTEST','Rigel · 860 ly'],['SEASON','Winter']],
      pts:[[-0.40,0.60],[0.35,0.55],[-0.12,0.05],[0,0],[0.12,-0.05],[-0.35,-0.60],[0.30,-0.65]], lines:[[0,2],[1,4],[2,3],[3,4],[2,5],[4,6]] },
    { name:'Ursa Major', myth:'Home to the Big Dipper — the two outer bowl stars, Dubhe and Merak, point straight to Polaris, the North Star.', meta:[['BRIGHTEST','Alioth · 83 ly'],['SEASON','Spring']],
      pts:[[-0.55,0.45],[-0.55,0.05],[-0.22,-0.05],[-0.12,0.30],[0.18,0.35],[0.45,0.40],[0.68,0.55]], lines:[[0,1],[1,2],[2,3],[3,0],[3,4],[4,5],[5,6]] },
    { name:'Cassiopeia', myth:'The vain queen of Greek myth, forever circling the celestial pole on her throne, traced by a glowing W.', meta:[['BRIGHTEST','Schedar · 228 ly'],['SEASON','Autumn']],
      pts:[[-0.60,0.0],[-0.30,0.40],[0,0.05],[0.30,0.40],[0.60,0.0]], lines:[[0,1],[1,2],[2,3],[3,4]] },
    { name:'Cygnus', myth:'The Swan glides along the Milky Way; its tail star Deneb, one of the most luminous known, sits roughly 2,600 light-years away.', meta:[['BRIGHTEST','Deneb · 2,600 ly'],['SEASON','Summer']],
      pts:[[0,0.62],[0,-0.62],[-0.45,0.10],[0.45,-0.10],[0,0]], lines:[[0,4],[4,1],[2,4],[4,3]] },
    { name:'Leo', myth:'A backwards question mark traces the lion\'s mane; its heart, Regulus, is a blue star spinning so fast it bulges at the equator.', meta:[['BRIGHTEST','Regulus · 79 ly'],['SEASON','Spring']],
      pts:[[-0.50,-0.30],[-0.58,0.10],[-0.38,0.42],[-0.10,0.46],[0.06,0.30],[0.25,0.15],[0.55,-0.15]], lines:[[0,1],[1,2],[2,3],[3,4],[4,0],[0,5],[5,6]] },
    { name:'Scorpius', myth:'A curling tail guarded by Antares, a red supergiant so vast it could swallow the orbit of Mars.', meta:[['BRIGHTEST','Antares · 550 ly'],['SEASON','Summer']],
      pts:[[-0.55,0.50],[-0.38,0.30],[-0.26,0.05],[-0.10,-0.15],[0.10,-0.35],[0.35,-0.45],[0.55,-0.28],[0.60,-0.02]], lines:[[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[6,7]], special:2 }
  ];
  var BEAT1 = reduced ? 5.6 : 4.8;
  var WEIGHTS1 = [1.8, 1, 1, 1, 1, 1.1];
  var SCENE1_DUR = sumWeights(WEIGHTS1)*BEAT1;
  var DOME_R = 520;

  var act1 = new THREE.Group(); scene.add(act1);
  var act1BgStars = makeStarField(2600, 480, 900, 0xf4f0e6, 2.4);
  act1.add(act1BgStars);
  var act1Con = CONSTELLATIONS.map(function(c, idx){
    var az = idx*(Math.PI*2/CONSTELLATIONS.length);
    var el = Math.sin(idx*1.7)*0.35;
    var dir = new THREE.Vector3(Math.sin(az)*Math.cos(el), Math.sin(el), Math.cos(az)*Math.cos(el));
    var right = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), dir).normalize();
    var up = new THREE.Vector3().crossVectors(dir, right).normalize();
    var center = dir.clone().multiplyScalar(DOME_R);
    var scaleAmt = 130;
    var world = c.pts.map(function(p){ return center.clone().add(right.clone().multiplyScalar(p[0]*scaleAmt)).add(up.clone().multiplyScalar(p[1]*scaleAmt)); });

    var group = new THREE.Group();
    var lineSegs = [];
    c.lines.forEach(function(seg){ lineSegs.push(world[seg[0]], world[seg[1]]); });
    var lineGeo = new THREE.BufferGeometry().setFromPoints(lineSegs);
    var lineMat = new THREE.LineBasicMaterial({ color:0xffb454, transparent:true, opacity:0, blending:THREE.AdditiveBlending, depthWrite:false });
    var lineObj = new THREE.LineSegments(lineGeo, lineMat);
    group.add(lineObj);

    var starSprites = world.map(function(p,j){
      var isSpecial = c.special===j;
      var spr = makeGlowSprite(isSpecial?glowWarm:glowWhite, isSpecial?34:20, isSpecial?0xff8a7a:0xfdf8ee, 0);
      spr.position.copy(p);
      group.add(spr);
      return spr;
    });
    var nebula = null;
    var nebulaSpec = idx===0 ? {off:[0,-0.24], size:60, color:0xffa3c4}
      : idx===3 ? {off:[0.14,0.72], size:52, color:0xc9b8ff}
      : idx===5 ? {off:[0.64,-0.16], size:48, color:0xff9a7a}
      : null;
    if(nebulaSpec){
      var nebulaPos = center.clone().add(right.clone().multiplyScalar(nebulaSpec.off[0]*scaleAmt)).add(up.clone().multiplyScalar(nebulaSpec.off[1]*scaleAmt));
      nebula = makeGlowSprite(glowWarm, nebulaSpec.size, nebulaSpec.color, 0);
      nebula.position.copy(nebulaPos);
      group.add(nebula);
    }
    act1.add(group);
    return { group:group, lineObj:lineObj, starSprites:starSprites, nebula:nebula, dir:dir, center:center, right:right, up:up };
  });
  var act1MilkyWay = (function(){
    var n = 1400;
    var pos = new Float32Array(n*3);
    var axis = new THREE.Vector3(0.4,0.15,-0.3).normalize();
    var ref = new THREE.Vector3(0,1,0);
    var bandRight = new THREE.Vector3().crossVectors(ref, axis).normalize();
    var bandUp = new THREE.Vector3().crossVectors(axis, bandRight).normalize();
    for(var i=0;i<n;i++){
      var along = rand(-1,1)*Math.PI;
      var wobble = (Math.random()+Math.random()+Math.random()-1.5)*0.16;
      var r = rand(560,760);
      var dir3 = axis.clone().multiplyScalar(Math.cos(along)).add(bandRight.clone().multiplyScalar(Math.sin(along))).add(bandUp.clone().multiplyScalar(wobble)).normalize();
      pos[i*3]=dir3.x*r; pos[i*3+1]=dir3.y*r; pos[i*3+2]=dir3.z*r;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos,3));
    var mat = new THREE.PointsMaterial({ color:0xd8d6ff, size:1.5, map:glowWhite, transparent:true, opacity:0.4, depthWrite:false, blending:THREE.AdditiveBlending, sizeAttenuation:true });
    var pts = new THREE.Points(geo, mat);
    act1.add(pts);
    return pts;
  })();

  function sceneAct1(t, tGlobal){
    var bl = beatLookup(BEAT1, WEIGHTS1, t);
    var idx = bl.idx, beatT = bl.beatT;
    var seasonHex = SEASON_TINT[CONSTELLATIONS[idx].meta[1][1]] || 0x03040a;
    clearColorTarget.setHex(seasonHex);
    act1MilkyWay.rotation.y = tGlobal*0.00006;
    act1MilkyWay.rotation.x = Math.sin(tGlobal*0.00004)*0.05;
    var drawT = clamp(beatT/1.5, 0, 1);
    act1Con.forEach(function(rec, i){
      var active = i===idx;
      rec.lineObj.material.opacity = damp(rec.lineObj.material.opacity, active?easeOutCubic(drawT)*0.9:0.05, 3, 0.016);
      rec.starSprites.forEach(function(s,j){
        var appear = active ? clamp(drawT*4-j*0.3,0,1) : 0.12;
        s.material.opacity = damp(s.material.opacity, appear, 3, 0.016);
      });
      if(rec.nebula){
        var nebAppear = active ? clamp((beatT-0.9)/1.4,0,1)*0.55 : 0.08;
        rec.nebula.material.opacity = damp(rec.nebula.material.opacity, nebAppear, 2, 0.016);
      }
    });
    var cur = act1Con[idx];
    var pushAmt = lerp(0, 90, easeOutCubic(clamp(beatT/2.2,0,1)));
    var scanT = clamp((beatT-2.2)/6, 0, 1);
    var scanX = Math.sin(beatT*0.32)*scanT*46;
    var scanY = Math.cos(beatT*0.23)*scanT*30;
    var lookTarget = cur.center.clone().add(cur.right.clone().multiplyScalar(scanX)).add(cur.up.clone().multiplyScalar(scanY));
    setCameraTarget(cur.dir.clone().multiplyScalar(pushAmt), lookTarget);
    var c = CONSTELLATIONS[idx];
    return { eyebrow:'NIGHT SKY · '+(idx+1)+'/'+CONSTELLATIONS.length, title:c.name, fact:c.myth, meta:c.meta, accent:'var(--nova)', beatKey:'c'+idx };
  }

  // ================= ACT 2 : SOLAR SYSTEM =================
  var PLANETS = [
    { name:'Mercury', color:0xb7ada0, r:60, size:3.4, speed:4.15, inc:0.12, cam:'flyby', spin:0.5,
      tex:{ base:'#a99b8c', craters:34 },
      fact:'The smallest planet swings around the Sun in just 88 days, baking at 430°C by day and freezing at -180°C by night.', meta:[['DIAMETER','4,879 km'],['DISTANCE','0.39 AU']] },
    { name:'Venus', color:0xe8c07d, r:84, size:5.4, speed:1.62, inc:-0.06, cam:'flyby', spin:-0.25,
      tex:{ base:'#e3bd7a', bands:[{y0:0.06,y1:0.28,color:'#f3d8a0',alpha:0.4},{y0:0.4,y1:0.58,color:'#caa055',alpha:0.35},{y0:0.7,y1:0.92,color:'#f3d8a0',alpha:0.35}], turbulence:7 },
      fact:'Wrapped in thick clouds of sulfuric acid, Venus is the hottest planet — its runaway greenhouse effect traps heat at 465°C.', meta:[['DIAMETER','12,104 km'],['DISTANCE','0.72 AU']] },
    { name:'Earth', color:0x5fb0e6, r:108, size:5.7, speed:1.0, inc:0, cam:'distant', spin:2.2,
      tex:{ base:'#2f6fbd', blotches:12, blotchColor:'#4c8a44', clouds:11, cloudColor:'rgba(255,255,255,0.55)' },
      fact:'The only known world with liquid water on its surface, plate tectonics, and life — home.', meta:[['DIAMETER','12,742 km'],['DISTANCE','1.00 AU']] },
    { name:'Mars', color:0xc1603f, r:134, size:4.2, speed:0.53, inc:0.09, cam:'flyby', spin:2.1,
      tex:{ base:'#af5535', blotches:9, blotchColor:'#7a3620', polarCaps:true },
      fact:'The Red Planet hosts Olympus Mons, the largest volcano in the solar system — nearly three times the height of Everest.', meta:[['DIAMETER','6,779 km'],['DISTANCE','1.52 AU']] },
    { name:'Jupiter', color:0xd8ab7e, r:176, size:15.5, speed:0.084, inc:-0.04, cam:'orbit', spin:5.2,
      tex:{ base:'#d9ac80', bands:[{y0:0.08,y1:0.2,color:'#c28658',alpha:0.55},{y0:0.28,y1:0.4,color:'#f2d7ac',alpha:0.4},{y0:0.48,y1:0.6,color:'#ac6438',alpha:0.5},{y0:0.68,y1:0.8,color:'#f2d7ac',alpha:0.4}], turbulence:11, spot:{x:0.32,y:0.56,rx:0.1,ry:0.05,colorHex:'#b04830',alpha:0.85} },
      fact:'A gas giant so massive it could hold over 1,300 Earths; its Great Red Spot is a storm wider than our entire planet.', meta:[['DIAMETER','139,820 km'],['MOONS','95 known']] },
    { name:'Saturn', color:0xe3cb95, r:222, size:13.2, speed:0.034, inc:0.07, ring:true, cam:'orbit', spin:4.7,
      tex:{ base:'#e6cd98', bands:[{y0:0.14,y1:0.26,color:'#d6b56f',alpha:0.4},{y0:0.38,y1:0.48,color:'#f2e2b8',alpha:0.35},{y0:0.6,y1:0.72,color:'#d6b56f',alpha:0.35}], turbulence:6 },
      fact:'Famous for its dazzling rings of ice and rock, Saturn is so light it would float in a bathtub large enough to hold it.', meta:[['DIAMETER','116,460 km'],['MOONS','146 known']] },
    { name:'Uranus', color:0x9fdce0, r:266, size:9.0, speed:0.012, inc:-0.1, cam:'distant', spin:3.3,
      tex:{ base:'#9edbdf', bands:[{y0:0.32,y1:0.46,color:'#b7e7ea',alpha:0.22},{y0:0.56,y1:0.7,color:'#89ccd0',alpha:0.22}], turbulence:2 },
      fact:'This ice giant spins almost on its side, likely knocked over by an ancient collision, giving it extreme seasons.', meta:[['DIAMETER','50,724 km'],['DISTANCE','19.2 AU']] },
    { name:'Neptune', color:0x5f79e0, r:306, size:8.7, speed:0.006, inc:0.05, cam:'distant', spin:3.1,
      tex:{ base:'#4665cc', bands:[{y0:0.2,y1:0.34,color:'#5c78dd',alpha:0.35},{y0:0.56,y1:0.7,color:'#37509e',alpha:0.35}], turbulence:8, spot:{x:0.62,y:0.4,rx:0.08,ry:0.055,colorHex:'#1c264e',alpha:0.7} },
      fact:'The windiest world known — supersonic storms race across Neptune at speeds up to 2,100 km/h.', meta:[['DIAMETER','49,244 km'],['DISTANCE','30.1 AU']] }
  ];
  function planetCamera(p, featuredPos, beatT){
    var outward = featuredPos.clone().normalize();
    var tangent = new THREE.Vector3().crossVectors(new THREE.Vector3(0,1,0), outward).normalize();
    var base = p.size*6+26;
    if(p.cam==='orbit'){
      var ang = beatT*0.3;
      var dist = base*0.7;
      var wave = p.name==='Saturn' ? Math.sin(beatT*0.55)*p.size*1.6 : 0;
      var off = tangent.clone().multiplyScalar(Math.cos(ang)*dist).add(outward.clone().multiplyScalar(Math.sin(ang)*dist*0.55));
      return { pos: featuredPos.clone().add(off).add(new THREE.Vector3(0, p.size*1.6+6+wave, 0)), look: featuredPos };
    } else if(p.cam==='flyby'){
      var dist2 = base*0.6;
      var off2 = tangent.clone().multiplyScalar(dist2).add(outward.clone().multiplyScalar(dist2*0.15));
      return { pos: featuredPos.clone().add(off2).add(new THREE.Vector3(0, p.size*0.9+4, 0)), look: featuredPos };
    }
    var dist3 = base*0.98;
    var off3 = tangent.clone().multiplyScalar(dist3*0.85).add(outward.clone().multiplyScalar(dist3*0.4));
    return { pos: featuredPos.clone().add(off3).add(new THREE.Vector3(0, p.size*2.4+11, 0)), look: featuredPos };
  }
  var BEAT2 = reduced ? 4.8 : 4.2;
  var WEIGHTS2 = [0.75, 0.85, 1, 0.85, 1.6, 1.6, 0.8, 0.8];
  var SCENE2_DUR = sumWeights(WEIGHTS2)*BEAT2;

  var act2 = new THREE.Group(); scene.add(act2); act2.visible=false;
  var sunGeo = new THREE.SphereGeometry(15, 32, 32);
  var sunMat = new THREE.MeshBasicMaterial({ color:0xffd88a });
  var sunMesh = new THREE.Mesh(sunGeo, sunMat);
  act2.add(sunMesh);
  act2.add(makeGlowSprite(glowWarm, 220, 0xffcf8a, 0.9));
  var act2Grid = buildGrid(40,40,20, 0x4be8ec, 0.16);
  act2Grid.mesh.position.y = -70;
  act2.add(act2Grid.mesh);
  var act2Planets = PLANETS.map(function(p, i){
    var g = new THREE.Group();
    g.rotation.x = 0; g.rotation.z = p.inc;
    var mesh = new THREE.Mesh(new THREE.SphereGeometry(p.size, 32, 32), new THREE.MeshStandardMaterial({ map:makePlanetTexture(p.tex), roughness:0.85, metalness:0.05 }));
    g.add(mesh);
    if(p.ring){
      var ring = new THREE.Mesh(new THREE.RingGeometry(p.size*1.4, p.size*2.2, 48), new THREE.MeshBasicMaterial({ color:0xe3cb95, side:THREE.DoubleSide, transparent:true, opacity:0.75 }));
      ring.rotation.x = Math.PI/2 - 0.35;
      g.add(ring);
    }
    var haloSpr = makeGlowSprite(glowWhite, p.size*4.5, 0xffffff, 0);
    g.add(haloSpr);
    var moons = null;
    if(i===4){
      moons = [0.55, 0.85, 1.2].map(function(mr,mi){
        var mm = new THREE.Mesh(new THREE.SphereGeometry(0.9,10,10), new THREE.MeshStandardMaterial({ color:0xcfcbc0, roughness:0.9 }));
        g.add(mm);
        return { mesh:mm, r:p.size*2.4+mr*10, speed:2.4-mi*0.5, phase:mi*2.1 };
      });
    }
    act2.add(g);
    act2.add(ellipseLoop(p.r, p.r*0.96, 0x4be8ec, 0.10));
    return { g:g, mesh:mesh, halo:haloSpr, moons:moons, def:p, index:i };
  });

  function sceneAct2(t, tGlobal){
    var bl2 = beatLookup(BEAT2, WEIGHTS2, t);
    var featured = bl2.idx, beatT2 = bl2.beatT;
    clearColorTarget.setHex(0x03040a);
    sunMesh.rotation.y += 0.0015;
    var featuredPos = null;
    act2Planets.forEach(function(rec){
      var ang = tGlobal*0.00035*rec.def.speed + rec.index*1.7;
      var lx = Math.cos(ang)*rec.def.r, lz = Math.sin(ang)*rec.def.r*0.96;
      var local = new THREE.Vector3(lx,0,lz);
      rec.g.position.set(0,0,0);
      var world = local.clone().applyEuler(new THREE.Euler(0,0,rec.def.inc));
      rec.mesh.position.copy(world);
      rec.mesh.rotation.y = tGlobal*0.0004*rec.def.spin;
      rec.halo.position.copy(world);
      if(rec.moons){
        rec.moons.forEach(function(m){
          var ma = tGlobal*0.0016*m.speed + m.phase;
          m.mesh.position.set(world.x+Math.cos(ma)*m.r, world.y+Math.sin(ma*0.6)*2, world.z+Math.sin(ma)*m.r);
        });
      }
      var isFeatured = rec.index===featured;
      rec.halo.material.opacity = damp(rec.halo.material.opacity, isFeatured?0.7:0, 4, 0.016);
      if(isFeatured) featuredPos = world;
      sunLight.position.set(0,0,0);
    });
    var p = PLANETS[featured];
    if(featuredPos){
      act2Grid.update(function(x,z,t2){
        return wellDip(0,0,900,26)(x,z,t2) + wellDip(featuredPos.x,featuredPos.z,p.size*22,14)(x,z,t2);
      }, 0);
      var cam = planetCamera(p, featuredPos, beatT2);
      setCameraTarget(cam.pos, cam.look);
    } else {
      act2Grid.update(wellDip(0,0,900,26), 0);
    }
    return { eyebrow:'SOLAR SYSTEM · '+(featured+1)+'/'+PLANETS.length, title:p.name, fact:p.fact, meta:p.meta, accent:'var(--nova)', beatKey:'p'+featured };
  }

  // ================= ACT 3 : SCALE OF THE UNIVERSE =================
  var SCALES = [
    { label:'Earth', num:'12,742', unit:'KM ACROSS', title:'A Pale Blue Marble', grid:0.15,
      fact:'Our home world spans 12,742 kilometers — light circles it seven times in a single second.', meta:[['MASS','5.97 × 10²⁴ kg'],['AGE','4.5 billion yrs']] },
    { label:'Solar System', num:'9.1', unit:'BILLION KM (NEPTUNE)', title:'The Sun\'s Domain', grid:0.5,
      fact:'Shrink the Sun to a grapefruit and Earth becomes a grain of sand nine meters away — Neptune would sit half a kilometer out.', meta:[['DIAMETER','~9.1 billion km'],['LIGHT TIME','8.4 hours']] },
    { label:'Nearby Stars', num:'4.25', unit:'LIGHT-YEARS TO PROXIMA', title:'The Neighborhood', grid:0.65,
      fact:'Proxima Centauri, the nearest star beyond the Sun, is 4.25 light-years away — a signal sent today would arrive in 2030.', meta:[['NEAREST STAR','Proxima Cen'],['TRAVEL TIME','~73,000 yrs by probe']] },
    { label:'Milky Way', num:'100,000', unit:'LIGHT-YEARS ACROSS', title:'Our Galaxy', grid:0.8,
      fact:'Some 100–400 billion stars spiral through the Milky Way — our Sun takes 230 million years to complete one orbit.', meta:[['STARS','100–400 billion'],['SUN\'S ORBIT','230 million yrs']] },
    { label:'Local Group', num:'10', unit:'MILLION LIGHT-YEARS WIDE', title:'A Cluster of Galaxies', grid:0.92,
      fact:'The Milky Way is one of 80+ galaxies in the Local Group — and it\'s on a slow collision course with Andromeda.', meta:[['MEMBER GALAXIES','80+'],['ANDROMEDA ETA','~4.5 billion yrs']] },
    { label:'Observable Universe', num:'93', unit:'BILLION LIGHT-YEARS WIDE', title:'The Edge of the Knowable', grid:1.0,
      fact:'Beyond roughly 93 billion light-years, light simply hasn\'t had time to reach us — the true universe may be far larger, or infinite.', meta:[['GALAXIES','~2 trillion'],['AGE OF LIGHT','13.8 billion yrs']] }
  ];
  var BEAT3 = reduced ? 5.6 : 4.9;
  var WEIGHTS3 = [0.85, 0.9, 0.9, 1.3, 1, 1.8];
  var SCENE3_DUR = sumWeights(WEIGHTS3)*BEAT3;

  var act3 = new THREE.Group(); scene.add(act3); act3.visible=false;
  var act3Grid = buildGrid(46,46,18, 0x4be8ec, 0.22);
  act3Grid.mesh.position.y = -60;
  act3.add(act3Grid.mesh);
  var act3Bg = makeStarField(1800, 300, 1400, 0xd8d6ff, 2.0);
  act3.add(act3Bg);
  var act3WebMarkers = [];
  var act3Stages = SCALES.map(function(sc, idx){
    var g = new THREE.Group(); g.visible=false; act3.add(g);
    if(idx===0){
      var m = new THREE.Mesh(new THREE.SphereGeometry(20,32,32), new THREE.MeshStandardMaterial({color:0x5fb0e6, roughness:0.7}));
      g.add(m); g.add(makeGlowSprite(glowCyan,70,0x8ff5f7,0.4));
    } else if(idx===1){
      for(var i=0;i<5;i++){ g.add(ellipseLoop(30+i*22,28+i*20,0x4be8ec,0.3)); }
      var s = new THREE.Mesh(new THREE.SphereGeometry(10,16,16), new THREE.MeshBasicMaterial({color:0xffd88a})); g.add(s);
      g.add(makeGlowSprite(glowWarm,90,0xffcf8a,0.8));
    } else if(idx===2){
      for(var k=0;k<60;k++){
        var sp = makeGlowSprite(glowWhite, rand(3,9), 0xfdf8ee, rand(0.4,0.9));
        sp.position.set(rand(-160,160), rand(-40,40), rand(-160,160));
        g.add(sp);
      }
    } else if(idx===3){
      var galGeo = new THREE.BufferGeometry();
      var pos3=[]; var col3=[];
      for(var gI=0; gI<900; gI++){
        var arm = gI%3; var tt=Math.pow(Math.random(),0.6);
        var ang = tt*5.2+arm*(Math.PI*2/3)+rand(-0.25,0.25);
        var rr = tt*220;
        pos3.push(Math.cos(ang)*rr, rand(-6,6), Math.sin(ang)*rr);
        var warm = gI%5===0;
        col3.push(warm?1:0.82, warm?0.86:0.83, warm?0.66:1);
      }
      galGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos3,3));
      galGeo.setAttribute('color', new THREE.Float32BufferAttribute(col3,3));
      var galMat = new THREE.PointsMaterial({ size:2.6, map:glowWhite, vertexColors:true, transparent:true, opacity:0.85, depthWrite:false, blending:THREE.AdditiveBlending });
      g.add(new THREE.Points(galGeo, galMat));
    } else if(idx===4){
      var lg = [[0,0,26,0xf4f0e6],[70,-16,20,0xcfd0ff],[-52,36,9,0xcfd0ff],[26,44,4,0xcfd0ff],[-20,-48,3,0xcfd0ff],[60,30,3,0xcfd0ff],[-68,-10,4,0xcfd0ff]];
      lg.forEach(function(l){
        var sp = makeGlowSprite(glowCyan, l[2]*3, l[3], 0.85);
        sp.position.set(l[0],rand(-8,8),l[1]);
        g.add(sp);
      });
    } else if(idx===5){
      var webGeo = new THREE.BufferGeometry(); var pos5=[]; var col5=[];
      for(var w=0;w<300;w++){
        pos5.push(rand(-260,260), rand(-100,100), rand(-260,260));
        var sig = w%9===0;
        col5.push(sig?0.29:0.9, sig?0.9:0.9, sig?0.9:1);
      }
      webGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos5,3));
      webGeo.setAttribute('color', new THREE.Float32BufferAttribute(col5,3));
      var webMat = new THREE.PointsMaterial({ size:2.2, map:glowWhite, vertexColors:true, transparent:true, opacity:0.8, depthWrite:false, blending:THREE.AdditiveBlending });
      g.add(new THREE.Points(webGeo, webMat));
      for(var mk=0; mk<5; mk++){
        var mx=rand(-220,220), my=rand(-70,70), mz=rand(-220,220);
        var marker = makeGlowSprite(glowCyan, 34, 0x8ff5f7, 0.5);
        marker.position.set(mx,my,mz);
        g.add(marker);
        act3WebMarkers.push({ spr:marker, phase:mk*1.3 });
      }
    }
    g.traverse(function(o){ if(o.material){ o.userData.baseOpacity = (o.material.opacity!==undefined?o.material.opacity:1); o.material.transparent = true; } });
    return g;
  });
  function setStageFade(g, opacity, scaleAmt){
    g.visible = opacity > 0.01;
    g.scale.setScalar(scaleAmt);
    g.traverse(function(o){ if(o.material){ o.material.opacity = o.userData.baseOpacity*opacity; } });
  }

  function sceneAct3(t, tGlobal){
    clearColorTarget.setHex(0x03040a);
    var bl = beatLookup(BEAT3, WEIGHTS3, t);
    var idx = bl.idx, beatT = bl.beatT, beatDur = bl.beatDur;
    var sc = SCALES[idx];
    var hasNext = idx < SCALES.length-1;
    var TRANS = 1.3;
    var transK = hasNext ? clamp(1-(beatDur-beatT)/TRANS, 0, 1) : 0;
    act3Stages.forEach(function(g,i){
      if(i===idx) setStageFade(g, 1-transK, lerp(1,1.55,transK));
      else if(hasNext && i===idx+1) setStageFade(g, transK, lerp(0.35,1,transK));
      else setStageFade(g, 0, 1);
    });
    var localFrac = beatT/beatDur;
    var gridNow = lerp(sc.grid, SCALES[hasNext?idx+1:idx].grid, localFrac);
    var dip = lerp(340, 6, gridNow);
    act3Grid.update(wellDip(0,0,dip,22), tGlobal*0.001);
    var actProgress = clamp(t/1000/SCENE3_DUR, 0, 1);
    var dist = lerp(220, 480, easeInOutCubic(actProgress));
    var wob = Math.sin(tGlobal*0.0004)*8;
    if(idx===5){
      act3WebMarkers.forEach(function(m){
        m.spr.material.opacity = 0.35 + Math.sin(tGlobal*0.0012 + m.phase)*0.3;
      });
      var driftAng = beatT*0.12;
      var cx3 = wob + Math.sin(driftAng)*dist*0.4;
      var cz3 = Math.cos(driftAng)*dist;
      setCameraTarget(new THREE.Vector3(cx3, dist*0.32, cz3), new THREE.Vector3(0,0,0));
    } else {
      setCameraTarget(new THREE.Vector3(wob, dist*0.32, dist), new THREE.Vector3(0,0,0));
    }
    document.getElementById('scaleNum').textContent = sc.num;
    document.getElementById('scaleUnit').textContent = sc.unit;
    return { eyebrow:'SCALE OF THE UNIVERSE · '+sc.label.toUpperCase(), title:sc.title, fact:sc.fact, meta:sc.meta, accent:'var(--signal)', beatKey:'s'+idx, showScale:true };
  }

  // ================= ACT 4 : FRONTIER DISCOVERIES =================
  var apodState = { tried:false, ok:false, title:null, fact:null };
  function tryFetchAPOD(){
    if(apodState.tried) return; apodState.tried = true;
    if(!navigator.onLine) return;
    var ctrl = (typeof AbortController!=='undefined') ? new AbortController() : null;
    var timer = setTimeout(function(){ if(ctrl) ctrl.abort(); }, 4500);
    fetch('https://api.nasa.gov/planetary/apod?api_key=DEMO_KEY', ctrl?{signal:ctrl.signal}:{})
      .then(function(r){ return r.ok?r.json():Promise.reject(); })
      .then(function(data){
        clearTimeout(timer);
        if(data && data.title){
          apodState.ok = true;
          apodState.title = data.title;
          apodState.fact = (data.explanation||'').split('. ').slice(0,2).join('. ');
          if(apodState.fact && !/[.!?]$/.test(apodState.fact)) apodState.fact += '.';
          apodState.date = data.date;
        }
      }).catch(function(){ clearTimeout(timer); });
  }

  var BEAT4 = reduced ? 5.4 : 4.7;
  var FRONTIER = [
    { key:'blackhole', name:'Sagittarius A*', fact:'Our galaxy\'s supermassive black hole — 4 million times the Sun\'s mass — was finally imaged in 2022.', meta:[['MASS','4.3 million M☉'],['DISTANCE','26,000 ly']] },
    { key:'trappist', name:'TRAPPIST-1', fact:'Seven Earth-sized worlds circle this cool dwarf star; three orbit in the zone where liquid water could survive.', meta:[['PLANETS','7 confirmed'],['DISTANCE','40 ly']] },
    { key:'ligo', name:'Gravitational Waves', fact:'In 2015, LIGO detected ripples in spacetime from two black holes that collided 1.3 billion years ago.', meta:[['FIRST DETECTION','Sept 14, 2015'],['SIGNAL','GW150914']] },
    { key:'jwst', name:'James Webb Space Telescope', fact:'Webb\'s gold-coated mirror spans 6.5 meters across 18 hexagonal segments, seeing farther back in time than any telescope before it.', meta:[['MIRROR','6.5 m, 18 segments'],['ORBIT','1.5M km from Earth']] },
    { key:'apod', name:'Deep Field', fact:'Point a telescope at a patch of sky the size of a grain of sand held at arm\'s length — Hubble found over 10,000 galaxies there.', meta:[['GALAXIES IN FIELD','10,000+'],['SOURCE','NASA APOD']] }
  ];
  var WEIGHTS4 = [2.2, 1, 1.3, 1, 1];
  var SCENE4_DUR = sumWeights(WEIGHTS4)*BEAT4;
  var act4 = new THREE.Group(); scene.add(act4); act4.visible=false;

  var bhStars = makeStarField(1100, 90, 420, 0xf4f0e6, 2.6); act4.add(bhStars);
  var bhGrid = buildGrid(30,30,10, 0xff8a5c, 0.4); bhGrid.mesh.position.y=-10; act4.add(bhGrid.mesh);
  var bhDiskGroup = new THREE.Group();
  var bhDiskBright = new THREE.Mesh(new THREE.TorusGeometry(38,7,16,48,Math.PI), new THREE.MeshBasicMaterial({ color:0xffe3b0, transparent:true, opacity:0.95 }));
  var bhDiskDim = new THREE.Mesh(new THREE.TorusGeometry(38,7,16,48,Math.PI), new THREE.MeshBasicMaterial({ color:0xb5642e, transparent:true, opacity:0.4 }));
  bhDiskDim.rotation.z = Math.PI;
  bhDiskGroup.add(bhDiskBright, bhDiskDim);
  bhDiskGroup.rotation.x = Math.PI/2 - 0.3;
  act4.add(bhDiskGroup);
  var bhCore = new THREE.Mesh(new THREE.SphereGeometry(16,24,24), new THREE.MeshBasicMaterial({ color:0x000000 })); act4.add(bhCore);

  var trapStar = new THREE.Mesh(new THREE.SphereGeometry(9,20,20), new THREE.MeshBasicMaterial({color:0xff8a5c})); act4.add(trapStar);
  act4.add(makeGlowSprite(glowWarm,80,0xff8a5c,0));
  var trapPlanets = [];
  for(var tp=0; tp<7; tp++){
    var rr = 26+tp*13;
    act4.add(ellipseLoop(rr,rr,0xffffff,0.08));
    var inHZ = tp>=2 && tp<=4;
    var pm = new THREE.Mesh(new THREE.SphereGeometry(2.6,12,12), new THREE.MeshBasicMaterial({color: inHZ?0x4be8ec:0xc7c9e8}));
    act4.add(pm);
    trapPlanets.push({mesh:pm, r:rr, speed:(7-tp)*0.4});
  }

  var ligoGrid = buildGrid(50,50,9, 0x4be8ec, 0.5); act4.add(ligoGrid.mesh);
  var ligoA = new THREE.Mesh(new THREE.SphereGeometry(4,16,16), new THREE.MeshBasicMaterial({color:0xf4f0e6})); act4.add(ligoA);
  var ligoB = new THREE.Mesh(new THREE.SphereGeometry(4,16,16), new THREE.MeshBasicMaterial({color:0xf4f0e6})); act4.add(ligoB);

  var jwstGroup = new THREE.Group(); act4.add(jwstGroup);
  var hexCoords = [[0,0],[1,0],[-1,0],[0.5,0.87],[-0.5,0.87],[0.5,-0.87],[-0.5,-0.87]];
  var hexMeshes = hexCoords.map(function(hc){
    var shape = new THREE.Shape();
    var hexR = 12;
    for(var v=0; v<6; v++){ var a=v*Math.PI/3; var x=Math.cos(a)*hexR, y=Math.sin(a)*hexR; if(v===0) shape.moveTo(x,y); else shape.lineTo(x,y); }
    shape.closePath();
    var geo = new THREE.ExtrudeGeometry(shape, { depth:2.4, bevelEnabled:false });
    var mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color:0xe3cb95, metalness:0.35, roughness:0.4, emissive:0x4a3110, emissiveIntensity:0.9 }));
    mesh.position.set(hc[0]*22, hc[1]*22, 0);
    jwstGroup.add(mesh);
    return mesh;
  });

  var apodPlane = new THREE.Mesh(new THREE.PlaneGeometry(140,90), new THREE.MeshBasicMaterial({ color:0x0b0e1f, transparent:true, opacity:0.95 }));
  act4.add(apodPlane);
  var apodSparkGeo = new THREE.BufferGeometry();
  var apodSparkPos = new Float32Array(210*3);
  for(var asp=0; asp<210; asp++){ apodSparkPos[asp*3]=rand(-90,90); apodSparkPos[asp*3+1]=rand(-55,55); apodSparkPos[asp*3+2]=rand(-4,4); }
  apodSparkGeo.setAttribute('position', new THREE.BufferAttribute(apodSparkPos,3));
  var apodSparks = new THREE.Points(apodSparkGeo, new THREE.PointsMaterial({ size:2.4, map:glowWhite, color:0xcfd0ff, transparent:true, opacity:0.8, depthWrite:false, blending:THREE.AdditiveBlending }));
  act4.add(apodSparks);

  var FRONTIER_GROUPS = [
    [bhGrid.mesh, bhDiskGroup, bhCore, bhStars],
    [trapStar, apodSparks].concat(trapPlanets.map(function(p){return p.mesh;})),
    [ligoGrid.mesh, ligoA, ligoB],
    [jwstGroup],
    [apodPlane, apodSparks]
  ];
  function setFrontierVisible(idx){
    FRONTIER_GROUPS.forEach(function(grp,i){ grp.forEach(function(o){ o.visible = i===idx; }); });
  }

  function sceneAct4(t, tGlobal){
    clearColorTarget.setHex(0x03040a);
    var bl4 = beatLookup(BEAT4, WEIGHTS4, t);
    var idx = bl4.idx, beatT = bl4.beatT, beatDur = bl4.beatDur;
    var appear = easeOutCubic(clamp(beatT/1.2,0,1));
    setFrontierVisible(idx);
    var item = FRONTIER[idx];

    if(idx===0){
      bhDiskGroup.rotation.z = tGlobal*0.0009;
      bhGrid.update(wellDip(0,0,340,7), 0);
      var s = appear; bhCore.scale.setScalar(s); bhDiskGroup.scale.setScalar(s);
      var revealK = easeOutCubic(clamp(beatT/2.0, 0, 1));
      var closeK = easeOutCubic(clamp((beatT-6.5)/Math.max(1,beatDur-6.5), 0, 1));
      var dist = lerp(lerp(210, 92, revealK), 68, closeK);
      var height = lerp(lerp(95, 26, revealK), 17, closeK);
      var angle = beatT*0.11;
      setCameraTarget(new THREE.Vector3(Math.sin(angle)*dist, height, Math.cos(angle)*dist), new THREE.Vector3(0,0,0));
      lensUniforms.lensStrength.value = (0.16 + closeK*0.62) * appear;
    } else if(idx===1){
      trapPlanets.forEach(function(p,i){ var ang=tGlobal*0.0006*p.speed+i; p.mesh.position.set(Math.cos(ang)*p.r*appear, 0, Math.sin(ang)*p.r*appear); });
      var revealK1 = easeOutCubic(clamp(beatT/1.6,0,1));
      var orbitAngle1 = beatT*0.16;
      var dist1 = lerp(190, 96, revealK1);
      var height1 = lerp(112, 44, revealK1);
      setCameraTarget(new THREE.Vector3(Math.sin(orbitAngle1)*dist1, height1, Math.cos(orbitAngle1)*dist1), new THREE.Vector3(0,0,0));
    } else if(idx===2){
      var orbAng = tGlobal*0.004;
      var sep = Math.max(2, 26-beatT*3.2);
      ligoA.position.set(Math.cos(orbAng)*sep,0,Math.sin(orbAng)*sep);
      ligoB.position.set(-Math.cos(orbAng)*sep,0,-Math.sin(orbAng)*sep);
      ligoGrid.update(rippleDip(16*appear), tGlobal*0.001);
      var mergeK = clamp(1-sep/26, 0, 1);
      var dist2 = lerp(190, 95, mergeK);
      var height2 = lerp(110, 55, mergeK);
      var angle2 = beatT*0.09;
      setCameraTarget(new THREE.Vector3(Math.sin(angle2)*dist2, height2, Math.cos(angle2)*dist2), new THREE.Vector3(0,0,0));
    } else if(idx===3){
      jwstGroup.rotation.y = tGlobal*0.0004;
      hexMeshes.forEach(function(m,i){ var a2=clamp(appear*7-i,0,1); m.scale.setScalar(a2); });
      var revealK3 = easeOutCubic(clamp(beatT/1.8,0,1));
      var orbitAngle3 = beatT*0.14;
      var dist3b = lerp(150, 58, revealK3);
      var height3 = lerp(58, 16, revealK3) + Math.sin(beatT*0.5)*6;
      setCameraTarget(new THREE.Vector3(Math.sin(orbitAngle3)*dist3b, height3, Math.cos(orbitAngle3)*dist3b), new THREE.Vector3(0,0,0));
    } else if(idx===4){
      tryFetchAPOD();
      apodPlane.material.opacity = 0.95*appear;
      apodSparks.material.opacity = 0.75*appear;
      apodSparks.rotation.y = tGlobal*0.00012;
      var revealK4 = easeOutCubic(clamp(beatT/1.6,0,1));
      var dist4 = lerp(240, 140, revealK4);
      var drift4 = Math.sin(beatT*0.2)*22;
      setCameraTarget(new THREE.Vector3(drift4, lerp(60,18,revealK4), dist4), new THREE.Vector3(0,0,0));
    }
    var live = idx===4 && apodState.ok;
    document.getElementById('liveBadge').classList.toggle('show', !!live);
    return { eyebrow:'FRONTIER DISCOVERIES · '+(idx+1)+'/'+FRONTIER.length,
      title: live?apodState.title:item.name,
      fact: live?apodState.fact:item.fact,
      meta: live?[['SOURCE','NASA APOD'],['DATE',apodState.date||'']]:item.meta,
      accent:'var(--nebula)', beatKey:'f'+idx+(live?'L':'') };
  }

  // ================= SCENE MANAGER =================
  var SCENES = [
    { run:function(t,g){ act1.visible=true; act2.visible=false; act3.visible=false; act4.visible=false; return sceneAct1(t,g); }, dur:SCENE1_DUR },
    { run:function(t,g){ act1.visible=false; act2.visible=true; act3.visible=false; act4.visible=false; return sceneAct2(t,g); }, dur:SCENE2_DUR },
    { run:function(t,g){ act1.visible=false; act2.visible=false; act3.visible=true; act4.visible=false; return sceneAct3(t,g); }, dur:SCENE3_DUR },
    { run:function(t,g){ act1.visible=false; act2.visible=false; act3.visible=false; act4.visible=true; return sceneAct4(t,g); }, dur:SCENE4_DUR }
  ];
  var TOTAL = SCENES.reduce(function(a,s){return a+s.dur*1000;},0);

  var dotsWrap = document.getElementById('dots');
  SCENES.forEach(function(){ var d=document.createElement('div'); d.className='dot'; var i=document.createElement('i'); d.appendChild(i); dotsWrap.appendChild(d); });
  var dotEls = dotsWrap.children;

  var eyebrowEl=document.getElementById('eyebrow'), titleEl=document.getElementById('title'), factEl=document.getElementById('fact'), metaEl=document.getElementById('meta'), dockInner=document.getElementById('dockInner');
  var scaleReadout=document.getElementById('scaleReadout'), liveBadge=document.getElementById('liveBadge'), clockEl=document.getElementById('clock');
  var lastBeatKey=null;
  function applyCaption(info){
    scaleReadout.classList.toggle('show', !!info.showScale);
    if(info.beatKey===lastBeatKey) return;
    lastBeatKey = info.beatKey;
    dockInner.classList.remove('show');
    setTimeout(function(){
      eyebrowEl.textContent=info.eyebrow; eyebrowEl.style.color=info.accent;
      titleEl.textContent=info.title; factEl.textContent=info.fact;
      metaEl.innerHTML='';
      (info.meta||[]).forEach(function(m){ var span=document.createElement('span'); span.innerHTML=m[0]+' — <b style="color:'+info.accent+'">'+m[1]+'</b>'; metaEl.appendChild(span); });
      dockInner.classList.add('show');
    }, reduced?10:180);
  }

  var warping=false, warpStart=0, warpLines=[];
  function beginWarp(){
    if(reduced) return;
    warping=true; warpStart=performance.now(); warpLines=[];
    for(var i=0;i<90;i++){ warpLines.push({ang:Math.random()*Math.PI*2, speed:rand(0.6,1.4), len:rand(0.05,0.2)}); }
  }
  function drawWarp(now){
    fctx.clearRect(0,0,W,H);
    if(!warping) return;
    var t = clamp((now-warpStart)/900,0,1);
    if(t>=1){ warping=false; return; }
    var intensity = t<0.5? easeOutCubic(t/0.5) : 1-easeOutCubic((t-0.5)/0.5);
    var ox=W/2, oy=H*0.44;
    fctx.strokeStyle='rgba(255,238,210,'+(intensity*0.8)+')'; fctx.lineWidth=1.4;
    for(var i=0;i<warpLines.length;i++){
      var l=warpLines[i];
      var dist=30+intensity*Math.max(W,H)*0.7*l.speed;
      var len=intensity*l.len*Math.max(W,H);
      var x1=ox+Math.cos(l.ang)*dist, y1=oy+Math.sin(l.ang)*dist;
      var x2=ox+Math.cos(l.ang)*(dist+len), y2=oy+Math.sin(l.ang)*(dist+len);
      fctx.beginPath(); fctx.moveTo(x1,y1); fctx.lineTo(x2,y2); fctx.stroke();
    }
    fctx.fillStyle='rgba(3,4,10,'+(intensity*0.35)+')'; fctx.fillRect(0,0,W,H);
  }

  var startTime = performance.now() - parseFloat(new URLSearchParams(location.search).get('t')||0);
  var lastSceneIdx = -1;
  var lastFrameTime = startTime;
  var simDays = 0;
  var DAYS_PER_SEC = 46;

  function frame(now){
    var dt = Math.max(0, Math.min((now-lastFrameTime)/1000, 0.1));
    lastFrameTime = now;
    var elapsed = Math.max(0, now-startTime);
    var loopT = ((elapsed % TOTAL) + TOTAL) % TOTAL;

    var acc=0, sceneIdx=0, sceneLocalMs=0;
    for(var i=0;i<SCENES.length;i++){
      var durMs = SCENES[i].dur*1000;
      if(loopT < acc+durMs){ sceneIdx=i; sceneLocalMs=loopT-acc; break; }
      acc += durMs;
    }
    if(sceneIdx!==lastSceneIdx){ if(lastSceneIdx!==-1) beginWarp(); lastSceneIdx=sceneIdx; }

    for(var d=0; d<dotEls.length; d++){
      var el=dotEls[d]; var innerI=el.querySelector('i');
      if(d<sceneIdx){ el.className='dot done'; }
      else if(d===sceneIdx){ el.className='dot active'; var frac=clamp(sceneLocalMs/(SCENES[d].dur*1000),0,1); innerI.style.transform='scaleX('+frac+')'; }
      else { el.className='dot'; innerI.style.transform='scaleX(0)'; }
    }
    if(sceneIdx!==2) scaleReadout.classList.remove('show');
    if(sceneIdx!==3) liveBadge.classList.remove('show');

    if(sceneIdx>0) simDays += dt*DAYS_PER_SEC;
    var yrs = Math.floor(simDays/365), dys = Math.floor(simDays%365);
    clockEl.textContent = sceneIdx===0 ? 'STANDING BY' : ('YEAR '+String(yrs).padStart(2,'0')+' · DAY '+String(dys).padStart(3,'0'));

    lensUniforms.lensStrength.value = 0;
    var info = SCENES[sceneIdx].run(sceneLocalMs, elapsed);
    applyCaption(info);
    updateCamera(dt);
    _lensProj.set(0,0,0).project(camera);
    lensUniforms.lensCenter.value.set(_lensProj.x*0.5+0.5, _lensProj.y*0.5+0.5);
    drawWarp(now);
    clearColorCurrent.lerp(clearColorTarget, 0.025);
    renderer.setClearColor(clearColorCurrent, 1);
    renderer.setRenderTarget(lensRT);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(lensScene, lensCam);
    requestAnimationFrame(frame);
  }
  resize();
  requestAnimationFrame(frame);
})();
