import {
  AdditiveBlending, BackSide, Box3, BoxGeometry, BufferGeometry, CanvasTexture,
  Color, CylinderGeometry, DirectionalLight, EquirectangularReflectionMapping, Float32BufferAttribute, FogExp2,
  Group, HemisphereLight, InstancedMesh, MathUtils, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, PlaneGeometry, Points, PointsMaterial, RepeatWrapping,
  Scene, ShaderMaterial, SphereGeometry, Sprite, SpriteMaterial, SRGBColorSpace, TorusGeometry, Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { SUN_POSITION, SUN_RADIUS } from './config';
import { segmentBoxFraction } from './world-math';
import { buildingBoxGeometry } from './building-geometry';

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
  private buildingDetails: { group: Group; position: Vector3 }[] = [];
  private facadeMaterials: MeshStandardMaterial[] = [];
  private detailTimer = 0;

  constructor(scene: Scene) {
    this.scene = scene;
    this.city.name = 'Metropolis';
    scene.add(this.city);
    scene.background = new Color(0x8db6cf);
    scene.fog = this.fog;
    scene.environment = this.environmentTexture();
    scene.environmentIntensity = 0.55;
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
    const mesh = new Mesh(buildingBoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  /** A static sky/street panorama supplies glass reflections without extra render passes. */
  private environmentTexture() {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 512;
    const ctx = canvas.getContext('2d')!;
    const sky = ctx.createLinearGradient(0, 0, 0, 512);
    sky.addColorStop(0, '#6095c9'); sky.addColorStop(0.38, '#a7c9df');
    sky.addColorStop(0.51, '#f4e6ce'); sky.addColorStop(0.54, '#64717b'); sky.addColorStop(1, '#253842');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, 1024, 512);
    const sun = ctx.createRadialGradient(165, 170, 1, 165, 170, 95);
    sun.addColorStop(0, 'rgba(255,247,214,1)'); sun.addColorStop(0.16, 'rgba(255,234,194,0.7)'); sun.addColorStop(1, 'rgba(255,234,194,0)');
    ctx.fillStyle = sun; ctx.fillRect(0, 50, 330, 240);
    for (let i = 0; i < 42; i++) {
      const x = i * 25; const height = 12 + ((i * 31) % 63);
      ctx.fillStyle = i % 3 ? '#435a6c' : '#607782'; ctx.fillRect(x, 280 - height, 17 + i % 8, height + 45);
    }
    const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace;
    texture.mapping = EquirectangularReflectionMapping;
    return texture;
  }

  private facadeMaterial(style: number) {
    const palette = [
      { wall: '#6e899b', pane: '#42738b', trim: '#b6c7cc', stone: false },
      { wall: '#263a46', pane: '#294958', trim: '#677e89', stone: false },
      { wall: '#c7bda6', pane: '#374f5b', trim: '#e0d4bd', stone: true },
      { wall: '#8c8170', pane: '#466773', trim: '#c5ac82', stone: true },
      { wall: '#a0bbc6', pane: '#729aaf', trim: '#d2dcdf', stone: false },
    ][style];
    const canvases = Array.from({ length: 3 }, () => { const c = document.createElement('canvas'); c.width = c.height = 512; return c; });
    const [color, roughness, emissive] = canvases.map(canvas => canvas.getContext('2d')!);
    color.fillStyle = palette.wall; color.fillRect(0, 0, 512, 512);
    roughness.fillStyle = palette.stone ? '#dedede' : '#b8b8b8'; roughness.fillRect(0, 0, 512, 512);
    emissive.fillStyle = '#000000'; emissive.fillRect(0, 0, 512, 512);
    // A 64m tile contains sixteen 4m storeys and bays. Geometry UVs keep this scale.
    for (let row = 0; row < 16; row++) {
      for (let col = 0; col < 16; col++) {
        const x = col * 32; const y = row * 32;
        const insetX = palette.stone ? 9 : 2; const insetY = palette.stone ? 5 : 2;
        const width = 32 - insetX * 2; const height = palette.stone ? 20 : 27;
        color.fillStyle = '#1d3544'; color.fillRect(x + insetX - 1, y + insetY - 1, width + 2, height + 3);
        const pane = color.createLinearGradient(x, y, x + 22, y + 31);
        pane.addColorStop(0, palette.pane); pane.addColorStop(0.44, palette.trim); pane.addColorStop(1, palette.pane);
        color.fillStyle = pane; color.fillRect(x + insetX, y + insetY, width, height);
        color.fillStyle = `rgba(8,27,44,${0.06 + this.random() * 0.16})`; color.fillRect(x + insetX, y + insetY, width, height);
        roughness.fillStyle = palette.stone ? '#6a6a6a' : '#3b3b3b'; roughness.fillRect(x + insetX, y + insetY, width, height);
        if (this.random() > 0.85) {
          color.fillStyle = this.random() > 0.4 ? 'rgba(242,215,160,0.78)' : 'rgba(191,211,211,0.5)';
          color.fillRect(x + insetX + 1, y + insetY + 1, width - 2, height - 2);
          emissive.fillStyle = '#d8a85b'; emissive.fillRect(x + insetX + 1, y + insetY + 1, width - 2, height - 2);
          color.fillStyle = '#4b534f'; color.fillRect(x + insetX + width * 0.53, y + insetY, 1, height);
        }
        color.fillStyle = palette.trim;
        color.fillRect(x, y + 30, 32, palette.stone ? 2 : 1);
        if (palette.stone) { color.fillStyle = '#aa9d86'; color.fillRect(x, y, 1, 32); }
      }
    }
    const [map, roughnessMap, emissiveMap] = canvases.map((canvas, i) => {
      const texture = new CanvasTexture(canvas); texture.wrapS = texture.wrapT = RepeatWrapping;
      texture.anisotropy = 4; if (i !== 1) texture.colorSpace = SRGBColorSpace; return texture;
    });
    const mat = new MeshStandardMaterial({ map, roughnessMap, emissiveMap, bumpMap: roughnessMap,
      bumpScale: palette.stone ? 0.32 : 0.12, roughness: 1, metalness: palette.stone ? 0.04 : 0.42,
      color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.18, envMapIntensity: palette.stone ? 0.3 : 0.85 });
    mat.userData.fullBumpMap = roughnessMap;
    this.cityMaterials.add(mat); this.facadeMaterials.push(mat);
    return mat;
  }

  /** Merge architecture by material so richer silhouettes stay cheap to draw. */
  private bakeArchitecture(group: Group) {
    const batches = new Map<MeshStandardMaterial | MeshBasicMaterial, BufferGeometry[]>();
    const originals: Mesh[] = [];
    for (const object of group.children) {
      if (!(object instanceof Mesh) || Array.isArray(object.material)) continue;
      object.updateMatrix();
      const material = object.material as MeshStandardMaterial | MeshBasicMaterial;
      if (!batches.has(material)) batches.set(material, []);
      batches.get(material)!.push(object.geometry.clone().applyMatrix4(object.matrix));
      originals.push(object);
    }
    for (const mesh of originals) { group.remove(mesh); mesh.geometry.dispose(); }
    for (const [material, geometries] of batches) {
      const geometry = mergeGeometries(geometries, false);
      for (const part of geometries) part.dispose();
      if (geometry) group.add(new Mesh(geometry, material));
    }
  }

  private makeCity() {
    const ground = this.material(0x748b7e);
    const asphalt = this.material(0x263a46);
    const pavement = this.material(0xa4a8a1);
    const roof = this.material(0x596a73);
    const stone = this.material(0xbab9a8);
    const trim = this.material(0x9aaab0, 0.42); trim.metalness = 0.45;
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

    const facades = Array.from({ length: 5 }, (_, i) => this.facadeMaterial(i));
    const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 64;
    const shadowContext = shadowCanvas.getContext('2d')!;
    const shadowGradient = shadowContext.createRadialGradient(32, 32, 12, 32, 32, 32);
    shadowGradient.addColorStop(0, 'rgba(0,0,0,0.5)'); shadowGradient.addColorStop(1, 'rgba(0,0,0,0)');
    shadowContext.fillStyle = shadowGradient; shadowContext.fillRect(0, 0, 64, 64);
    const contactMaterial = new MeshBasicMaterial({ map: new CanvasTexture(shadowCanvas), transparent: true, depthWrite: false, opacity: 0.5, color: 0x16232d });
    this.cityMaterials.add(contactMaterial);
    const contacts: { x: number; z: number; width: number; depth: number }[] = [];
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
        const style = Math.floor(this.random() * facades.length);
        this.makeTower(group, width, height, depth, style, facades[style], stone, roof, trim);
        const rubble = this.box(this.city, x, 5, z, width * 0.9, 10, depth * 0.9, roof);
        rubble.visible = false;
        this.city.add(group);
        this.buildings.push({ group, rubble, destroyed: false, bounds: new Box3().setFromObject(group) });
        contacts.push({ x, z, width: width + 85, depth: depth + 85 });
      }
    }
    const contactShadows = new InstancedMesh(new PlaneGeometry(1, 1), contactMaterial, contacts.length);
    contacts.forEach((contact, i) => {
      this.dummy.position.set(contact.x, 2.1, contact.z); this.dummy.rotation.set(-Math.PI / 2, 0, 0);
      this.dummy.scale.set(contact.width, contact.depth, 1); this.dummy.updateMatrix(); contactShadows.setMatrixAt(i, this.dummy.matrix);
    });
    this.city.add(contactShadows);
    this.dummy.rotation.set(0, 0, 0);
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

  private makeTower(group: Group, width: number, height: number, depth: number, style: number,
    facade: MeshStandardMaterial, stone: MeshStandardMaterial, roof: MeshStandardMaterial, trim: MeshStandardMaterial) {
    const deco = style === 2 || style === 3;
    const podiumHeight = deco ? 28 : 16;
    this.box(group, 0, podiumHeight / 2, 0, width + 18, podiumHeight, depth + 18, stone);
    // Real setbacks and offset volumes produce a varied skyline even from orbit.
    if (style === 1) {
      this.box(group, -width * 0.16, height / 2, 0, width * 0.68, height, depth, facade);
      this.box(group, width * 0.34, height * 0.4, depth * 0.06, width * 0.32, height * 0.8, depth * 0.87, facade);
      this.box(group, -width * 0.16, height + 2, 0, width * 0.7, 4, depth + 3, trim);
      this.box(group, width * 0.34, height * 0.8 + 2, depth * 0.06, width * 0.33, 4, depth * 0.89, trim);
    } else if (deco && height > 160) {
      const tiers = [0.72, 0.89, 1];
      let bottom = podiumHeight;
      tiers.forEach((top, i) => {
        const topY = height * top; const factor = 1 - i * 0.18;
        this.box(group, 0, (bottom + topY) / 2, 0, width * factor, topY - bottom, depth * factor, facade);
        this.box(group, 0, topY + 2, 0, width * factor + 7, 4, depth * factor + 7, stone);
        bottom = topY + 4;
      });
    } else {
      this.box(group, 0, height / 2, 0, width, height, depth, facade);
      this.box(group, 0, height + 2, 0, width + 4, 4, depth + 4, trim);
      if (height > 210) {
        this.box(group, 0, height + 16, 0, width * 0.68, 28, depth * 0.68, facade);
        this.box(group, 0, height + 32, 0, width * 0.7, 4, depth * 0.7, trim);
      }
    }
    // Corner piers create genuine facade depth. All piers share one baked draw call.
    const shaftHeight = deco && height > 160 ? height * 0.72 : height;
    const pierMaterial = deco ? stone : trim;
    const pierWidth = style === 1 ? width * 0.68 : width;
    const pierOffset = style === 1 ? -width * 0.16 : 0;
    for (const side of [-1, 1]) {
      for (const corner of [-1, 1]) {
        this.box(group, pierOffset + side * (pierWidth / 2 - 1), shaftHeight / 2, corner * (depth / 2 - 1), deco ? 5 : 2.5, shaftHeight, deco ? 5 : 2.5, pierMaterial);
      }
    }
    if (deco) {
      for (const offset of [-0.27, 0, 0.27]) {
        for (const face of [-1, 1]) this.box(group, width * offset, shaftHeight / 2, face * (depth / 2 + 1), 3.5, shaftHeight, 3, stone);
      }
    }
    if (height > 300 && style !== 1) {
      const spireHeight = deco ? 52 : 35;
      const spire = new Mesh(new CylinderGeometry(0.7, 2, spireHeight, 6), trim);
      const spireBase = height + (deco ? 4 : 34);
      spire.position.set(0, spireBase + spireHeight / 2, 0); group.add(spire);
    }
    this.bakeArchitecture(group);
    const detail = new Group(); detail.name = 'Nearby rooftop detail';
    if (style === 1) detail.position.x = -width * 0.16;
    const rooftop = height + (height > 210 && !deco && style !== 1 ? 35 : 5);
    for (let i = 0; i < 3; i++) {
      this.box(detail, -width * 0.18 + i * width * 0.17, rooftop + 4, 0, width * 0.11, 8, depth * 0.2, roof);
      this.box(detail, -width * 0.18 + i * width * 0.17, rooftop + 8.5, 0, width * 0.1, 1, depth * 0.19, trim);
    }
    this.bakeArchitecture(detail);
    group.add(detail);
    this.buildingDetails.push({ group: detail, position: group.position.clone().setY(height) });
  }

  private makeDailyPlanet(facade: MeshStandardMaterial, stone: MeshStandardMaterial, roof: MeshStandardMaterial) {
    const existing = this.buildings.find(b => b.group.position.x === -180 && b.group.position.z === -180);
    if (!existing) return;
    existing.group.traverse(object => { if (object instanceof Mesh) object.geometry.dispose(); });
    this.buildingDetails = this.buildingDetails.filter(detail => detail.group.parent !== existing.group);
    existing.group.clear();
    const group = existing.group;
    const faces = facade;
    this.box(group, 0, 24, 0, 245, 48, 245, stone);
    this.box(group, 0, 210, 0, 192, 360, 192, faces);
    this.box(group, 0, 385, 0, 145, 85, 145, faces);
    this.box(group, 0, 440, 0, 100, 35, 100, stone);
    this.box(group, 0, 471, 0, 16, 40, 16, stone);
    const gold = this.material(0xc6a767, 0.3);
    gold.metalness = 0.72;
    for (const level of [{ y: 49, w: 250 }, { y: 391, w: 200 }, { y: 428, w: 151 }, { y: 459, w: 106 }]) {
      this.box(group, 0, level.y, 0, level.w, 4, level.w, gold);
    }
    for (const offset of [-0.4, -0.2, 0, 0.2, 0.4]) {
      for (const face of [-1, 1]) {
        this.box(group, offset * 192, 209, face * 97, 4, 354, 3, stone);
        this.box(group, face * 97, 209, offset * 192, 3, 354, 4, stone);
      }
    }
    this.box(group, 0, 34, 124, 42, 28, 3, facade);
    this.box(group, 0, 20, 127, 66, 3, 8, gold);
    this.globe = new Group(); this.globe.position.set(0, 514, 0);
    const planet = new Mesh(new SphereGeometry(31, 20, 14), gold);
    this.globe.add(planet);
    for (let i = 0; i < 3; i++) {
      const ring = new Mesh(new TorusGeometry(40, 1.2, 5, 48), gold);
      ring.rotation.set(Math.PI / 2 + i * 0.18, 0.5 * i, 0.22 * i); this.globe.add(ring);
    }
    const engraving = this.material(0x655e43, 0.55);
    for (let i = 0; i < 4; i++) {
      const meridian = new Mesh(new TorusGeometry(31.1, 0.45, 4, 36), engraving);
      meridian.rotation.y = i * Math.PI / 4; this.globe.add(meridian);
    }
    this.bakeArchitecture(this.globe);
    group.add(this.globe);
    const label = document.createElement('canvas'); label.width = 1024; label.height = 128;
    const ctx = label.getContext('2d')!;
    ctx.fillStyle = '#e1c18b'; ctx.font = '700 75px Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('DAILY PLANET', 512, 68);
    const signTexture = new CanvasTexture(label); signTexture.colorSpace = SRGBColorSpace;
    const mat = new MeshBasicMaterial({ map: signTexture, transparent: true, color: 0xffffff, depthWrite: false }); this.cityMaterials.add(mat);
    for (let side = 0; side < 4; side++) {
      const angle = side * Math.PI / 2;
      const sign = new Mesh(new PlaneGeometry(174, 23), mat);
      sign.position.set(Math.sin(angle) * 98.5, 365, Math.cos(angle) * 98.5); sign.rotation.y = angle; group.add(sign);
    }
    this.bakeArchitecture(group);
    existing.bounds.setFromObject(group).expandByScalar(0.1);
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
    this.detailTimer -= dt;
    if (this.detailTimer <= 0) {
      this.detailTimer = 0.2;
      const detailDistanceSq = (this.lowQuality ? 500 : 1350) ** 2;
      for (const detail of this.buildingDetails) {
        const dx = position.x - detail.position.x; const dy = position.y - detail.position.y; const dz = position.z - detail.position.z;
        detail.group.visible = this.city.visible && dx * dx + dy * dy + dz * dz < detailDistanceSq;
      }
    }
    if (Math.abs(fade - this.lastFade) > 0.005) {
      this.lastFade = fade;
      for (const material of this.cityMaterials) {
        const baseOpacity = material.userData.baseOpacity ?? (material.userData.baseOpacity = material.opacity);
        const baseTransparent = material.userData.baseTransparent ?? (material.userData.baseTransparent = material.transparent);
        const baseDepthWrite = material.userData.baseDepthWrite ?? (material.userData.baseDepthWrite = material.depthWrite);
        const transparent = fade < 0.999 || baseTransparent;
        if (material.transparent !== transparent) { material.transparent = transparent; material.needsUpdate = true; }
        material.opacity = fade * baseOpacity;
        material.depthWrite = fade > 0.65 && baseDepthWrite;
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
    if (this.lowQuality !== low) {
      for (const material of this.facadeMaterials) {
        material.bumpMap = low ? null : material.userData.fullBumpMap;
        material.needsUpdate = true;
      }
    }
    this.lowQuality = low;
    this.detailTimer = 0;
    this.clouds.visible = !low;
    this.stars.geometry.setDrawRange(0, low ? 700 : 1600);
  }

  dispose() {
    this.scene.environment?.dispose();
    this.scene.environment = null;
    this.scene.traverse(object => {
      if (object instanceof Mesh || object instanceof Points) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
  }
}
