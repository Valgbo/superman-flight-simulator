import {
  AdditiveBlending, BackSide, Box3, BoxGeometry, BufferGeometry, CanvasTexture,
  Color, CylinderGeometry, DirectionalLight, Float32BufferAttribute, FogExp2,
  Group, HemisphereLight, InstancedMesh, MathUtils, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, PlaneGeometry, Points, PointsMaterial, RepeatWrapping,
  Scene, ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial, TorusGeometry, Vector3,
} from 'three';
import { SUN_POSITION, SUN_RADIUS } from './config';
import { segmentBoxFraction } from './world-math';

export interface Building {
  bounds: Box3;
  group: Group;
  destroyed: boolean;
  rubble: Mesh;
}
export interface CollisionResult { hit: boolean; destroyed: number; point: Vector3 | null }
interface Fragment { position: Vector3; velocity: Vector3; spin: Vector3; size: number; life: number; rotation: Vector3 }

const smoothstep = (min: number, max: number, x: number) => MathUtils.smoothstep(x, min, max);

// The city spans metres while the Sun is two million metres away. Every custom
// world shader must write the same logarithmic depth as Three's built-in materials.
function logDepthVertex(source: string) {
  return '#include <common>\n#include <logdepthbuf_pars_vertex>\n' +
    source.replace(/}\s*$/, '\n#include <logdepthbuf_vertex>\n}');
}
function logDepthFragment(source: string) {
  return '#include <logdepthbuf_pars_fragment>\n' +
    source.replace(/}\s*$/, '\n#include <logdepthbuf_fragment>\n}');
}


/** Deterministic procedural world. No remote art, models, or API calls are required. */
export class World {
  readonly city = new Group();
  readonly buildings: Building[] = [];
  private scene: Scene;
  private randomSeed = 1986;
  private cityMaterials = new Set<MeshStandardMaterial | MeshBasicMaterial | SpriteMaterial>();
  private sky: Mesh<SphereGeometry, ShaderMaterial>;
  private stars: Points<BufferGeometry, PointsMaterial>;
  private atmosphere: Mesh<SphereGeometry, ShaderMaterial>;
  private sunMaterial: ShaderMaterial;
  private sunGlow: Sprite;
  private sunFlares = new Group();
  private clouds = new Group();
  private debris: InstancedMesh;
  private fragments: Fragment[] = [];
  private nextFragment = 0;
  private dummy = new Object3D();
  private fog = new FogExp2(0xb8cbd6, 0.00013);
  private hemisphere: HemisphereLight;
  private sunlight: DirectionalLight;
  private lastFade = -1;
  private lowQuality = false;
  private globe: Group | null = null;

  constructor(scene: Scene) {
    this.scene = scene;
    this.city.name = 'Metropolis';
    scene.add(this.city);
    scene.background = new Color(0x8db6cf);
    scene.fog = this.fog;
    this.hemisphere = new HemisphereLight(0xc4e0ff, 0x4f4740, 2.35);
    this.sunlight = new DirectionalLight(0xffe3af, 3.0);
    this.sunlight.position.set(-1600, 2400, 1100);
    scene.add(this.hemisphere, this.sunlight);

    this.sky = new Mesh(new SphereGeometry(4000000, 24, 16), new ShaderMaterial({
      side: BackSide, depthWrite: false, depthTest: false, fog: false,
      uniforms: { space: { value: 0 } },
      vertexShader: 'varying vec3 vDirection; void main(){vDirection=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
      fragmentShader: `varying vec3 vDirection; uniform float space;
        void main(){float h=smoothstep(-0.12,0.85,vDirection.y);
        vec3 color=mix(vec3(0.73,0.81,0.84),vec3(0.16,0.40,0.65),h);
        float haze=pow(max(0.0,dot(vDirection,normalize(vec3(-0.1,0.16,-1.0)))),24.0);
        color+=vec3(0.25,0.13,0.02)*haze; color=mix(color,vec3(0.002,0.004,0.013),space);
        gl_FragColor=vec4(color,1.0);}`,
    }));
    this.sky.renderOrder = -1000;
    this.sky.frustumCulled = false;
    scene.add(this.sky);

    this.stars = this.makeStars();
    scene.add(this.stars);
    this.atmosphere = this.makeEarth();
    const sun = this.makeSun();
    this.sunMaterial = sun.material;
    scene.add(sun);
    this.sunGlow = new Sprite(new SpriteMaterial({
      map: this.glowTexture(), color: 0xffb347, transparent: true,
      opacity: 0.8, blending: AdditiveBlending, depthWrite: false, fog: false,
    }));
    this.sunGlow.position.copy(SUN_POSITION);
    this.sunGlow.scale.setScalar(SUN_RADIUS * 7.5);
    scene.add(this.sunGlow);
    this.sunFlares.position.copy(SUN_POSITION);
    const flareMaterial = new MeshBasicMaterial({ color: 0xffc24c, transparent: true, opacity: 0.25, blending: AdditiveBlending, depthWrite: false, fog: false });
    for (let i = 0; i < 5; i++) {
      const flare = new Mesh(new TorusGeometry(SUN_RADIUS * (1.04 + i * 0.045), SUN_RADIUS * 0.009, 5, 56, Math.PI * 1.2), flareMaterial);
      flare.rotation.set(i * 0.62, i * 0.82, i * 1.4);
      this.sunFlares.add(flare);
    }
    scene.add(this.sunFlares);

    this.makeCity();
    this.makeClouds();
    this.debris = new InstancedMesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x8d9da6, roughness: 0.95 }), 220);
    this.debris.frustumCulled = false;
    for (let i = 0; i < 220; i++) {
      this.fragments.push({ position: new Vector3(), velocity: new Vector3(), spin: new Vector3(), rotation: new Vector3(), size: 0, life: 0 });
      this.dummy.scale.setScalar(0);
      this.dummy.updateMatrix();
      this.debris.setMatrixAt(i, this.dummy.matrix);
    }
    this.city.add(this.debris);
  }

  private random() {
    this.randomSeed = (Math.imul(this.randomSeed, 1664525) + 1013904223) >>> 0;
    return this.randomSeed / 4294967296;
  }
  private material(color: number, roughness = 0.85) {
    const material = new MeshStandardMaterial({ color, roughness });
    this.cityMaterials.add(material);
    return material;
  }
  private box(parent: Group, x: number, y: number, z: number, w: number, h: number, d: number, material: MeshStandardMaterial | MeshBasicMaterial | MeshStandardMaterial[]) {
    const mesh = new Mesh(new BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  private facadeTexture(tone: string) {
    const canvas = document.createElement('canvas');
    canvas.width = 128; canvas.height = 256;
    const context = canvas.getContext('2d')!;
    context.fillStyle = tone; context.fillRect(0, 0, 128, 256);
    for (let row = 0; row < 32; row++) {
      for (let col = 0; col < 12; col++) {
        const lit = this.random() > 0.48;
        context.fillStyle = lit ? (this.random() > 0.4 ? '#adc3cb' : '#e7cc94') : '#142d3b';
        context.fillRect(col * 10.67 + 2, row * 8 + 2, 5, 4);
        context.fillStyle = '#617580';
        context.fillRect(col * 10.67 + 1, row * 8 + 7, 8, 1);
      }
    }
    const texture = new CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.anisotropy = 2;
    return texture;
  }

  private makeCity() {
    const ground = this.material(0x748b7e);
    const asphalt = this.material(0x263a46);
    const pavement = this.material(0xa4a8a1);
    const roof = this.material(0x65747b);
    const stone = this.material(0xbab9a8);
    const garden = this.material(0x496e50);
    const water = this.material(0x397d9d, 0.25);
    this.box(this.city, 0, -18, 0, 5900, 30, 5900, ground);
    this.box(this.city, 3200, -8, 0, 1600, 8, 6500, water);
    this.box(this.city, 2385, 0, 0, 32, 7, 5900, stone);

    // Broad avenues sit exactly on multiples of 360, keeping the starting avenue clear.
    for (let i = -7; i <= 7; i++) {
      this.box(this.city, i * 360, 0.1, 0, 78, 1, 5560, asphalt);
      this.box(this.city, 0, 0.15, i * 360, 5560, 1, 78, asphalt);
      for (const side of [-1, 1]) {
        this.box(this.city, i * 360 + side * 47, 1.5, 0, 14, 3, 5560, pavement);
        this.box(this.city, 0, 1.5, i * 360 + side * 47, 5560, 3, 14, pavement);
      }
    }
    const stripeMaterial = new MeshBasicMaterial({ color: 0xc0b484 });
    this.cityMaterials.add(stripeMaterial);
    const stripes = new InstancedMesh(new BoxGeometry(1, 0.3, 1), stripeMaterial, 1600);
    let stripe = 0;
    for (let road = -7; road <= 7; road++) {
      for (let v = -2700; v < 2700; v += 110) {
        this.dummy.position.set(road * 360, 0.9, v);
        this.dummy.scale.set(1.6, 1, 32);
        this.dummy.updateMatrix(); stripes.setMatrixAt(stripe++, this.dummy.matrix);
        this.dummy.position.set(v, 0.95, road * 360);
        this.dummy.scale.set(32, 1, 1.6);
        this.dummy.updateMatrix(); stripes.setMatrixAt(stripe++, this.dummy.matrix);
      }
    }
    stripes.count = stripe;
    this.city.add(stripes);

    const facades = ['#4e6573', '#76848a', '#829193', '#5b737c', '#a49d88'].map((tone, i) => {
      const mat = new MeshStandardMaterial({ map: this.facadeTexture(tone), roughness: 0.62, metalness: i % 2 ? 0.15 : 0.3, color: 0xffffff });
      this.cityMaterials.add(mat);
      return mat;
    });
    const treeTrunks: { x: number; y: number; z: number }[] = [];
    const treeCrowns: { x: number; y: number; z: number; size: number }[] = [];
    for (let gx = -7; gx < 7; gx++) {
      for (let gz = -7; gz < 7; gz++) {
        const x = (gx + 0.5) * 360;
        const z = (gz + 0.5) * 360;
        // Waterfront parks and a central garden break up the skyline.
        const park = (gx >= 4 && gz >= -1 && gz <= 2) || (gx === -3 && gz >= 0 && gz <= 2) || (gx === 1 && gz === 1);
        if (park) {
          this.box(this.city, x, 1, z, 256, 2, 256, garden);
          this.box(this.city, x, 2.5, z, 12, 1, 256, pavement);
          this.box(this.city, x, 2.6, z, 256, 1, 12, pavement);
          for (let t = 0; t < 12; t++) {
            const tx = x + (this.random() - 0.5) * 220;
            const tz = z + (this.random() - 0.5) * 220;
            const size = 8 + this.random() * 6;
            treeTrunks.push({ x: tx, y: 7, z: tz });
            treeCrowns.push({ x: tx, y: 12 + size * 0.4, z: tz, size });
          }
          continue;
        }
        const central = Math.exp(-(x * x + z * z) / 2100000);
        const height = 55 + this.random() * 165 + central * (80 + this.random() * 210);
        const width = 155 + this.random() * 80;
        const depth = 155 + this.random() * 80;
        const group = new Group(); group.position.set(x, 0, z);
        const facade = facades[Math.floor(this.random() * facades.length)];
        const faceMaterials = facade;
        const podiumHeight = 12 + this.random() * 20;
        this.box(group, 0, podiumHeight / 2, 0, width + 18, podiumHeight, depth + 18, stone);
        this.box(group, 0, height / 2, 0, width, height, depth, faceMaterials);
        this.box(group, 0, height + 2, 0, width + 3, 4, depth + 3, roof);
        if (height > 220) {
          const upperHeight = 20 + this.random() * 50;
          this.box(group, 0, height + upperHeight / 2, 0, width * 0.7, upperHeight, depth * 0.7, faceMaterials);
          this.box(group, 0, height + upperHeight + 2, 0, width * 0.72, 4, depth * 0.72, stone);
        }
        if (height > 290 && this.random() > 0.4) {
          const spire = new Mesh(new CylinderGeometry(0.6, 1.5, 55, 5), stone);
          spire.position.set(0, height + 65, 0); group.add(spire);
        }
        const rubble = this.box(this.city, x, 5, z, width * 0.9, 10, depth * 0.9, roof);
        rubble.visible = false;
        this.city.add(group);
        this.buildings.push({ group, rubble, destroyed: false, bounds: new Box3(new Vector3(x - (width + 18) / 2, 0, z - (depth + 18) / 2), new Vector3(x + (width + 18) / 2, height + (height > 220 ? 76 : 4), z + (depth + 18) / 2)) });
      }
    }
    const trunkMesh = new InstancedMesh(new CylinderGeometry(1.2, 1.6, 10, 5), this.material(0x665344), treeTrunks.length);
    const crownMesh = new InstancedMesh(new SphereGeometry(1, 6, 5), this.material(0x376447), treeCrowns.length);
    treeTrunks.forEach((t, i) => {
      this.dummy.position.set(t.x, t.y, t.z); this.dummy.scale.setScalar(1); this.dummy.updateMatrix(); trunkMesh.setMatrixAt(i, this.dummy.matrix);
      const c = treeCrowns[i]; this.dummy.position.set(c.x, c.y, c.z); this.dummy.scale.set(c.size, c.size * 1.2, c.size); this.dummy.updateMatrix(); crownMesh.setMatrixAt(i, this.dummy.matrix);
    });
    this.city.add(trunkMesh, crownMesh);
    this.makeDailyPlanet(facades[2], stone, roof);
    // A suspension bridge and waterfront promenade give the city a recognizable edge.
    this.box(this.city, 3100, 18, -1080, 1450, 10, 60, asphalt);
    for (const bx of [2700, 3400]) {
      for (const bz of [-1120, -1040]) this.box(this.city, bx, 70, bz, 14, 170, 14, stone);
      this.box(this.city, bx, 138, -1080, 18, 12, 105, stone);
    }
  }

  private makeDailyPlanet(facade: MeshStandardMaterial, stone: MeshStandardMaterial, roof: MeshStandardMaterial) {
    const existing = this.buildings.find(b => b.group.position.x === -180 && b.group.position.z === -180);
    if (!existing) return;
    existing.group.clear();
    const group = existing.group;
    const faces = facade;
    this.box(group, 0, 24, 0, 245, 48, 245, stone);
    this.box(group, 0, 210, 0, 192, 360, 192, faces);
    this.box(group, 0, 385, 0, 145, 85, 145, faces);
    this.box(group, 0, 440, 0, 100, 35, 100, stone);
    this.box(group, 0, 471, 0, 16, 40, 16, stone);
    const gold = this.material(0xc6a767, 0.3);
    this.globe = new Group(); this.globe.position.set(0, 514, 0);
    const planet = new Mesh(new SphereGeometry(31, 20, 14), gold);
    this.globe.add(planet);
    for (let i = 0; i < 3; i++) {
      const ring = new Mesh(new TorusGeometry(40, 1.2, 5, 48), gold);
      ring.rotation.set(Math.PI / 2 + i * 0.18, 0.5 * i, 0.22 * i); this.globe.add(ring);
    }
    group.add(this.globe);
    const label = document.createElement('canvas'); label.width = 1024; label.height = 128;
    const ctx = label.getContext('2d')!;
    ctx.fillStyle = '#e1c18b'; ctx.font = '700 75px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('DAILY PLANET', 512, 68);
    const mat = new MeshBasicMaterial({ map: new CanvasTexture(label), transparent: true, color: 0xffffff }); this.cityMaterials.add(mat);
    const sign = new Mesh(new PlaneGeometry(174, 23), mat); sign.position.set(0, 346, 97); group.add(sign);
    existing.bounds.set(new Vector3(-305, 0, -305), new Vector3(-55, 558, -55));
  }

  private makeEarth() {
    const earth = new Mesh(new SphereGeometry(7000, 80, 48), new MeshStandardMaterial({ map: this.earthTexture(), roughness: 0.9, metalness: 0.04, emissive: 0x06101f, emissiveIntensity: 0.3 }));
    earth.position.set(0, -7040, 0);
    earth.rotation.z = 0.21; earth.rotation.y = 1.8;
    this.scene.add(earth);
    const atmosphere = new Mesh(new SphereGeometry(7210, 48, 32), new ShaderMaterial({
      side: BackSide, transparent: true, depthWrite: false, blending: AdditiveBlending,
      uniforms: { strength: { value: 0.72 } },
      vertexShader: logDepthVertex('varying vec3 vNormal; varying vec3 vView; void main(){vec4 p=modelViewMatrix*vec4(position,1.);vNormal=normalize(normalMatrix*normal);vView=normalize(-p.xyz);gl_Position=projectionMatrix*p;}'),
      fragmentShader: logDepthFragment('varying vec3 vNormal;varying vec3 vView;uniform float strength;void main(){float a=pow(1.-abs(dot(vNormal,vView)),3.5);gl_FragColor=vec4(0.18,0.48,0.95,a*strength);}'),
    }));
    atmosphere.position.copy(earth.position); this.scene.add(atmosphere);
    return atmosphere;
  }

  private earthTexture() {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#16466d'; ctx.fillRect(0, 0, 1024, 512);
    const polygons = [
      [[-168,68],[-140,72],[-125,60],[-113,54],[-101,52],[-84,56],[-61,48],[-82,25],[-99,17],[-112,30],[-125,47],[-151,58]],
      [[-81,12],[-64,10],[-47,-5],[-35,-8],[-41,-23],[-56,-39],[-70,-55],[-76,-30],[-80,-5]],
      [[-17,35],[8,37],[31,31],[42,12],[51,8],[42,-12],[32,-33],[18,-35],[5,-20],[-9,4],[-17,16]],
      [[-12,36],[-9,58],[7,71],[31,70],[46,56],[67,58],[91,73],[127,64],[163,65],[178,52],[144,42],[131,31],[121,22],[107,1],[99,6],[82,8],[69,23],[51,27],[39,41],[23,39]],
      [[112,-12],[129,-10],[144,-16],[153,-27],[145,-39],[128,-35],[114,-25]],
      [[-54,60],[-22,63],[-18,78],[-43,83],[-60,72]],
      [[46,-13],[50,-16],[48,-25],[43,-26]],
      [[130,31],[140,41],[145,44],[141,34]],
      [[-180,-71],[-120,-76],[-65,-73],[0,-77],[60,-69],[118,-74],[180,-70],[180,-90],[-180,-90]],
    ];
    for (let i = 0; i < polygons.length; i++) {
      ctx.beginPath();
      polygons[i].forEach(([lng, lat], j) => { const x = (lng + 180) / 360 * 1024; const y = (90 - lat) / 180 * 512; if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.closePath(); ctx.fillStyle = i === 8 || i === 5 ? '#c8d6ce' : '#66816c'; ctx.fill();
      ctx.strokeStyle = '#78907b'; ctx.lineWidth = 2; ctx.stroke();
    }
    // Soft cloud belts are painted into the texture so they remain inexpensive at orbit scale.
    for (let i = 0; i < 160; i++) {
      const x = this.random() * 1024; const y = 40 + this.random() * 425;
      ctx.save(); ctx.translate(x, y); ctx.rotate(-0.4);
      ctx.fillStyle = `rgba(225,240,244,${0.04 + this.random() * 0.13})`;
      ctx.beginPath(); ctx.ellipse(0, 0, 12 + this.random() * 60, 2 + this.random() * 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    return new CanvasTexture(canvas);
  }

  private makeStars() {
    const data = new Float32Array(1600 * 3);
    for (let i = 0; i < 1600; i++) {
      const azimuth = this.random() * Math.PI * 2;
      const y = this.random() * 2 - 1;
      const r = Math.sqrt(1 - y * y);
      data[i * 3] = Math.cos(azimuth) * r * 3400000;
      data[i * 3 + 1] = y * 3400000;
      data[i * 3 + 2] = Math.sin(azimuth) * r * 3400000;
    }
    const geometry = new BufferGeometry(); geometry.setAttribute('position', new Float32BufferAttribute(data, 3));
    const stars = new Points(geometry, new PointsMaterial({ color: 0xd2e3ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    stars.renderOrder = -900; stars.frustumCulled = false;
    return stars;
  }

  private glowTexture() {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d')!; const gradient = ctx.createRadialGradient(128, 128, 8, 128, 128, 128);
    gradient.addColorStop(0, 'rgba(255,247,214,1)'); gradient.addColorStop(0.18, 'rgba(255,196,71,0.8)'); gradient.addColorStop(0.4, 'rgba(255,123,24,0.22)'); gradient.addColorStop(1, 'rgba(255,85,0,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 256, 256);
    return new CanvasTexture(canvas);
  }

  private makeSun() {
    const material = new ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: logDepthVertex('varying vec3 p;varying vec3 vNormal;void main(){p=position;vNormal=normal;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}'),
      fragmentShader: logDepthFragment(`varying vec3 p;varying vec3 vNormal;uniform float time;
        float n(vec3 v){return sin(v.x*13.0+sin(v.y*17.0))*sin(v.z*19.0+cos(v.x*11.0));}
        void main(){vec3 q=normalize(p);float cell=n(q*3.0+vec3(time*0.03,time*0.01,0.0));
        float flame=0.5+0.5*sin(q.y*60.0+q.x*24.0+cell*4.0+time*0.2);
        vec3 c=mix(vec3(1.0,0.24,0.015),vec3(1.0,0.83,0.28),flame*0.75+cell*0.2);
        gl_FragColor=vec4(c*1.8,1.0);}`),
    });
    const sun = new Mesh(new SphereGeometry(SUN_RADIUS, 64, 40), material);
    sun.position.copy(SUN_POSITION); return sun;
  }

  private makeClouds() {
    const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 128;
    const context = canvas.getContext('2d')!;
    for (let i = 0; i < 12; i++) {
      const x = 35 + this.random() * 186; const y = 42 + this.random() * 44;
      const gradient = context.createRadialGradient(x, y, 0, x, y, 38);
      gradient.addColorStop(0, 'rgba(255,255,255,0.32)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
      context.fillStyle = gradient; context.fillRect(0, 0, 256, 128);
    }
    const material = new SpriteMaterial({ map: new CanvasTexture(canvas), color: 0xe0e9ee, opacity: 0.65, transparent: true, depthWrite: false });
    this.cityMaterials.add(material);
    for (let i = 0; i < 20; i++) {
      const cloud = new Sprite(material);
      cloud.position.set((this.random() - 0.5) * 8500, 1200 + this.random() * 1800, (this.random() - 0.5) * 8500);
      cloud.scale.set(1300 + this.random() * 1400, 450 + this.random() * 450, 1);
      this.clouds.add(cloud);
    }
    this.city.add(this.clouds);
  }

  /** Swept collision avoids tunnelling even when one frame crosses a whole skyscraper. */
  sweep(from: Vector3, to: Vector3, turbo: boolean): CollisionResult {
    let firstFraction = Infinity;
    let destroyed = 0;
    for (const building of this.buildings) {
      if (building.destroyed) continue;
      const fraction = segmentBoxFraction(from, to, building.bounds.min, building.bounds.max, 2.5);
      if (fraction === null) continue;
      firstFraction = Math.min(firstFraction, fraction);
      if (turbo) { this.destroy(building, from, to); destroyed++; }
    }
    return { hit: Number.isFinite(firstFraction), destroyed, point: Number.isFinite(firstFraction) ? from.clone().lerp(to, Math.max(0, firstFraction - 0.002)) : null };
  }

  private destroy(building: Building, from: Vector3, to: Vector3) {
    building.destroyed = true; building.group.visible = false; building.rubble.visible = true;
    const center = building.bounds.getCenter(new Vector3());
    const impact = from.clone().lerp(to, segmentBoxFraction(from, to, building.bounds.min, building.bounds.max, 2.5) ?? 0);
    const direction = to.clone().sub(from).normalize();
    const count = this.lowQuality ? 12 : 28;
    for (let i = 0; i < count; i++) {
      const fragment = this.fragments[this.nextFragment++ % this.fragments.length];
      fragment.position.set(center.x + (this.random() - 0.5) * 100, Math.max(10, impact.y + (this.random() - 0.5) * 80), center.z + (this.random() - 0.5) * 100);
      fragment.velocity.copy(direction).multiplyScalar(35 + this.random() * 85);
      fragment.velocity.x += (this.random() - 0.5) * 90; fragment.velocity.y += 20 + this.random() * 80; fragment.velocity.z += (this.random() - 0.5) * 90;
      fragment.spin.set(this.random() * 3, this.random() * 3, this.random() * 3);
      fragment.rotation.set(0, 0, 0); fragment.size = 4 + this.random() * 14; fragment.life = 3.5 + this.random() * 2;
    }
  }

  update(dt: number, position: Vector3, time: number, reducedMotion: boolean) {
    const space = smoothstep(1800, 11000, position.y);
    this.sky.position.copy(position);
    this.sky.material.uniforms.space.value = space;
    this.stars.position.copy(position);
    this.stars.material.opacity = smoothstep(2200, 10500, position.y);
    this.fog.density = 0.00013 * (1 - space);
    this.scene.fog = space >= 0.999 ? null : this.fog;
    this.hemisphere.intensity = 2.35 - space * 1.45;
    this.sunlight.intensity = 3 - space * 0.2;
    this.atmosphere.material.uniforms.strength.value = 0.32 + space * 0.65;
    this.sunMaterial.uniforms.time.value = reducedMotion ? 0 : time;
    if (!reducedMotion) this.sunFlares.rotation.y = time * 0.012;
    if (this.globe && !reducedMotion) this.globe.rotation.y = time * 0.08;
    const fade = 1 - smoothstep(2800, 6500, position.y);
    this.city.visible = fade > 0.005;
    if (Math.abs(fade - this.lastFade) > 0.005) {
      this.lastFade = fade;
      for (const material of this.cityMaterials) {
        const transparent = fade < 0.999 || material instanceof SpriteMaterial || (!!material.map?.image && material instanceof MeshBasicMaterial);
        if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
        material.opacity = fade * (material instanceof SpriteMaterial ? 0.65 : 1);
        material.depthWrite = fade > 0.65 && !(material instanceof SpriteMaterial);
      }
    }
    let dirty = false;
    for (let i = 0; i < this.fragments.length; i++) {
      const fragment = this.fragments[i];
      if (fragment.life <= 0) continue;
      fragment.life -= dt;
      fragment.velocity.y -= 65 * dt;
      fragment.position.addScaledVector(fragment.velocity, dt);
      if (fragment.position.y < 4) { fragment.position.y = 4; fragment.velocity.y *= -0.15; fragment.velocity.x *= 0.9; fragment.velocity.z *= 0.9; }
      if (!reducedMotion) fragment.rotation.addScaledVector(fragment.spin, dt);
      this.dummy.position.copy(fragment.position);
      this.dummy.rotation.set(fragment.rotation.x, fragment.rotation.y, fragment.rotation.z);
      this.dummy.scale.setScalar(fragment.life <= 0 ? 0 : fragment.size * Math.min(1, fragment.life));
      this.dummy.updateMatrix(); this.debris.setMatrixAt(i, this.dummy.matrix); dirty = true;
    }
    if (dirty) this.debris.instanceMatrix.needsUpdate = true;
  }

  reset() {
    for (const building of this.buildings) { building.destroyed = false; building.group.visible = true; building.rubble.visible = false; }
    for (let i = 0; i < this.fragments.length; i++) {
      this.fragments[i].life = 0; this.dummy.scale.setScalar(0); this.dummy.updateMatrix(); this.debris.setMatrixAt(i, this.dummy.matrix);
    }
    this.debris.instanceMatrix.needsUpdate = true;
  }

  setQuality(low: boolean) {
    this.lowQuality = low;
    this.clouds.visible = !low;
    this.stars.geometry.setDrawRange(0, low ? 700 : 1600);
  }

  dispose() {
    this.scene.traverse(object => {
      if (object instanceof Mesh || object instanceof Points) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
  }
}
