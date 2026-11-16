import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Scene,
  Shape,
  ShapeGeometry,
  SphereGeometry,
} from 'three';

/** A small, entirely procedural hero. +Y is up and the character faces -Z. */
export class Hero {
  readonly group = new Group();
  private readonly body = new Group();
  private readonly rightArm = new Group();
  private readonly leftArm = new Group();
  private readonly rightLeg = new Group();
  private readonly leftLeg = new Group();
  private readonly capeGeometry: BufferGeometry;
  private readonly capePositions: Float32Array;
  private pose = 0;
  private previousTime = 0;
  private readonly capeColumns = 13;
  private readonly capeRows = 15;

  constructor(scene: Scene) {
    this.group.name = 'Superman';
    this.group.add(this.body);
    scene.add(this.group);

    const blue = new MeshStandardMaterial({ color: '#0757ac', roughness: 0.53, metalness: 0.22 });
    const blueLight = new MeshStandardMaterial({ color: '#0866c0', roughness: 0.5, metalness: 0.16 });
    const red = new MeshStandardMaterial({ color: '#cc172a', roughness: 0.65, metalness: 0.04 });
    const yellow = new MeshStandardMaterial({ color: '#f5c443', roughness: 0.38, metalness: 0.25 });
    const skin = new MeshStandardMaterial({ color: '#e4ae87', roughness: 0.82 });
    const hair = new MeshStandardMaterial({ color: '#151b26', roughness: 0.7 });
    const dark = new MeshStandardMaterial({ color: '#183b61', roughness: 0.75 });

    const add = (parent: Group, geometry: BufferGeometry, material: MeshStandardMaterial,
      x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) => {
      const mesh = new Mesh(geometry, material);
      mesh.position.set(x, y, z);
      mesh.scale.set(sx, sy, sz);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Broad shoulders, a tapered waist, and a slightly sculpted chest keep the silhouette clear.
    add(this.body, new CylinderGeometry(0.47, 0.31, 1.02, 10), blue, 0, 0.55, 0, 1, 1, 0.66);
    add(this.body, new SphereGeometry(0.35, 12, 8), blueLight, -0.21, 0.79, -0.1, 0.9, 0.8, 0.69);
    add(this.body, new SphereGeometry(0.35, 12, 8), blueLight, 0.21, 0.79, -0.1, 0.9, 0.8, 0.69);
    add(this.body, new CylinderGeometry(0.305, 0.34, 0.29, 10), red, 0, -0.08, 0, 1, 1, 0.8);
    add(this.body, new CylinderGeometry(0.325, 0.325, 0.09, 12), yellow, 0, 0.09, 0, 1, 1, 0.75);
    add(this.body, new BoxGeometry(0.16, 0.105, 0.04), yellow, 0, 0.085, -0.27);
    add(this.body, new CylinderGeometry(0.125, 0.15, 0.23, 10), skin, 0, 1.16, 0);
    const head = add(this.body, new SphereGeometry(0.235, 14, 12), skin, 0, 1.43, -0.015, 0.88, 1.16, 0.95);
    head.rotation.x = -0.06;
    add(this.body, new SphereGeometry(0.239, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.53), hair, 0, 1.49, 0.006, 0.89, 1.02, 1);
    // A forward curl and simplified jaw provide a readable face without a texture download.
    const curl = add(this.body, new CapsuleGeometry(0.035, 0.11, 3, 6), hair, -0.045, 1.59, -0.201);
    curl.rotation.z = -0.55;
    add(this.body, new BoxGeometry(0.027, 0.035, 0.06), skin, 0, 1.43, -0.233);
    add(this.body, new BoxGeometry(0.047, 0.012, 0.012), dark, -0.082, 1.487, -0.22);
    add(this.body, new BoxGeometry(0.047, 0.012, 0.012), dark, 0.082, 1.487, -0.22);

    const diamond = new Shape();
    diamond.moveTo(-0.265, 0.105);
    diamond.lineTo(-0.16, 0.205);
    diamond.lineTo(0.16, 0.205);
    diamond.lineTo(0.265, 0.105);
    diamond.lineTo(0, -0.2);
    diamond.closePath();
    const shield = add(this.body, new ShapeGeometry(diamond), red, 0, 0.79, -0.331);
    shield.rotation.y = Math.PI;
    const inset = new Shape();
    inset.moveTo(-0.208, 0.095);
    inset.lineTo(-0.131, 0.16);
    inset.lineTo(0.131, 0.16);
    inset.lineTo(0.208, 0.095);
    inset.lineTo(0, -0.142);
    inset.closePath();
    const gold = add(this.body, new ShapeGeometry(inset), yellow, 0, 0.79, -0.335);
    gold.rotation.y = Math.PI;
    // A sculpted red zigzag reads as the familiar chest mark at chase-camera distance.
    const zig = new Shape();
    zig.moveTo(-0.135, 0.117); zig.lineTo(0.135, 0.117);
    zig.lineTo(0.155, 0.069); zig.lineTo(-0.07, 0.069);
    zig.lineTo(-0.1, 0.025); zig.lineTo(0.108, -0.003);
    zig.lineTo(0.098, -0.054); zig.lineTo(-0.055, -0.103);
    zig.lineTo(-0.105, -0.063); zig.lineTo(0.04, -0.037);
    zig.lineTo(-0.138, -0.009); zig.lineTo(-0.162, 0.061);
    zig.closePath();
    const mark = add(this.body, new ShapeGeometry(zig), red, 0, 0.79, -0.34);
    mark.rotation.y = Math.PI;

    const armGeometry = new CapsuleGeometry(0.125, 0.33, 3, 8);
    const fistGeometry = new SphereGeometry(0.137, 10, 8);
    const makeArm = (pivot: Group, x: number) => {
      pivot.position.set(x, 0.94, 0);
      this.body.add(pivot);
      add(pivot, new SphereGeometry(0.19, 10, 8), blue, 0, 0, 0, 1, 0.9, 0.9);
      add(pivot, armGeometry, blue, 0, -0.32, 0);
      add(pivot, armGeometry, blueLight, 0, -0.67, -0.02, 0.84, 0.84, 0.84);
      add(pivot, fistGeometry, skin, 0, -0.96, -0.028, 0.86, 1.05, 0.95);
    };
    makeArm(this.rightArm, 0.47);
    makeArm(this.leftArm, -0.47);

    const legGeometry = new CapsuleGeometry(0.15, 0.43, 3, 8);
    const makeLeg = (pivot: Group, x: number) => {
      pivot.position.set(x, -0.13, 0);
      this.body.add(pivot);
      add(pivot, legGeometry, blue, 0, -0.35, 0);
      add(pivot, new CapsuleGeometry(0.13, 0.45, 3, 8), red, 0, -0.98, 0);
      add(pivot, new BoxGeometry(0.24, 0.15, 0.4), red, 0, -1.3, -0.095);
    };
    makeLeg(this.rightLeg, 0.18);
    makeLeg(this.leftLeg, -0.18);

    this.capePositions = new Float32Array(this.capeColumns * this.capeRows * 3);
    const indices: number[] = [];
    for (let y = 0; y < this.capeRows - 1; y++) {
      for (let x = 0; x < this.capeColumns - 1; x++) {
        const a = y * this.capeColumns + x;
        indices.push(a, a + this.capeColumns, a + 1, a + 1, a + this.capeColumns, a + this.capeColumns + 1);
      }
    }
    this.capeGeometry = new BufferGeometry();
    this.capeGeometry.setAttribute('position', new BufferAttribute(this.capePositions, 3));
    this.capeGeometry.setIndex(indices);
    const cape = new Mesh(this.capeGeometry, new MeshStandardMaterial({
      color: new Color('#bd1129'), roughness: 0.81, side: DoubleSide,
    }));
    cape.name = 'Flowing cape';
    cape.castShadow = true;
    cape.frustumCulled = false;
    this.body.add(cape);
    this.update(0, 0, false, true);
  }

  update(time: number, speed: number, turbo: boolean, reducedMotion: boolean): void {
    const dt = Math.min(Math.max(time - this.previousTime, 0), 0.1);
    this.previousTime = time;
    const targetPose = MathUtils.smoothstep(speed, 6, 85);
    this.pose = MathUtils.damp(this.pose, targetPose, 5, dt);
    const flutter = reducedMotion ? 0.12 : 1;
    this.body.rotation.x = -this.pose * Math.PI * 0.48;
    this.body.position.y = reducedMotion ? 0 : Math.sin(time * 1.7) * 0.045 * (1 - this.pose);
    this.rightArm.rotation.z = MathUtils.lerp(-0.1, -Math.PI + 0.05, this.pose);
    this.rightArm.rotation.x = MathUtils.lerp(-0.06, -0.08, this.pose);
    this.leftArm.rotation.z = MathUtils.lerp(0.12, 0.18, this.pose);
    this.leftArm.rotation.x = MathUtils.lerp(-0.03, -0.26, this.pose);
    this.rightLeg.rotation.x = MathUtils.lerp(0, 0.06, this.pose);
    this.leftLeg.rotation.x = MathUtils.lerp(0, -0.045, this.pose);
    this.rightLeg.rotation.z = -0.025;
    this.leftLeg.rotation.z = 0.025;

    const waveSpeed = turbo ? 14 : 4 + Math.min(speed / 30, 6);
    for (let row = 0; row < this.capeRows; row++) {
      const v = row / (this.capeRows - 1);
      const width = MathUtils.lerp(0.46, 0.89, v);
      for (let col = 0; col < this.capeColumns; col++) {
        const u = col / (this.capeColumns - 1);
        const i = (row * this.capeColumns + col) * 3;
        this.capePositions[i] = (u * 2 - 1) * width;
        this.capePositions[i + 1] = 1.035 - v * 2.52 + Math.sin(u * Math.PI * 5) * v * 0.035;
        this.capePositions[i + 2] = 0.245 + v * 0.22
          + Math.sin(v * 10 - time * waveSpeed + u * 2.5) * v * 0.12 * flutter
          + Math.sin(u * Math.PI * 6) * (0.025 + v * 0.035);
      }
    }
    this.capeGeometry.getAttribute('position').needsUpdate = true;
    this.capeGeometry.computeVertexNormals();
  }
}
