import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import RAPIER from 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/+esm';

document.addEventListener('DOMContentLoaded', async () => {
  const container = document.getElementById('lanyard-frame-wrap');
  const placeholder = document.getElementById('lanyard-placeholder');
  if (!container) return;

  // 1. Initialize Physics (Rapier)
  await RAPIER.init();
  const gravity = { x: 0.0, y: -9.81, z: 0.0 };
  const world = new RAPIER.World(gravity);

  // 2. Setup Scene
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, container.clientWidth / container.clientHeight, 0.1, 1000);
  // Camera closer for close-up and centered framing
  camera.position.set(0, 0, 5.5);

  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'high-performance' });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.domElement.style.touchAction = 'none';
  container.insertBefore(renderer.domElement, placeholder);

  // 3. Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 1.5);
  scene.add(ambientLight);
  const spotLight = new THREE.SpotLight(0xffffff, 3);
  spotLight.position.set(5, 5, 5);
  scene.add(spotLight);

  // Array to keep track of meshes and their corresponding physics bodies
  const physicsBodies = [];
  let cardBody = null;
  let cardMesh = null;

  // 4. Strap Logic (Continuous Mesh with TubeGeometry)
  const segmentCount = 20; // More segments for smoother curve
  const segmentLength = 0.25; 
  const strapWidth = 0.15; // Visual width/radius
  
  const textureLoader = new THREE.TextureLoader();
  let strapTexture = null;
  try {
    strapTexture = await new Promise((resolve, reject) => {
      textureLoader.load(
        './3D-Lanyard/textures/strap-texture.png',
        (texture) => {
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
          resolve(texture);
        },
        undefined,
        reject
      );
    });
  } catch (err) {
    console.warn("Strap texture not found.");
  }

  const strapMaterial = new THREE.MeshStandardMaterial({
    color: strapTexture ? 0xffffff : 0x111111,
    map: strapTexture,
    roughness: 0.6,
    metalness: 0.1,
    side: THREE.DoubleSide // Ensure both sides are visible
  });
  
  // Anchor the top higher up to center the card in the frame
  const topAnchorPos = { x: 0, y: 5, z: 0 };
  const anchorDesc = RAPIER.RigidBodyDesc.fixed();
  anchorDesc.setTranslation(topAnchorPos.x, topAnchorPos.y, topAnchorPos.z);
  const anchorBody = world.createRigidBody(anchorDesc);
  let parentBody = anchorBody;

  const ropeBodies = [];
  for (let i = 0; i < segmentCount; i++) {
    const yPos = topAnchorPos.y - (i * segmentLength);
    
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic();
    bodyDesc.setTranslation(0, yPos, 0);
    bodyDesc.setLinearDamping(0.8);
    bodyDesc.setAngularDamping(0.8);
    
    const body = world.createRigidBody(bodyDesc);
    const colliderDesc = RAPIER.ColliderDesc.ball(0.05).setMass(0.05); // Use balls for smoother chain
    world.createCollider(colliderDesc, body);

    ropeBodies.push(body);

    const jointParams = RAPIER.JointData.spherical(
      { x: 0, y: i === 0 ? 0 : -segmentLength, z: 0 },
      { x: 0, y: 0, z: 0 }
    );
    world.createImpulseJoint(jointParams, parentBody, body, true);

    parentBody = body;
  }

  // Visual Rope Mesh
  const initialPoints = [
    new THREE.Vector3(topAnchorPos.x, topAnchorPos.y, topAnchorPos.z),
    new THREE.Vector3(topAnchorPos.x, topAnchorPos.y - 1, topAnchorPos.z)
  ];
  const curve = new THREE.CatmullRomCurve3(initialPoints);
  const ropeGeometry = new THREE.TubeGeometry(curve, 64, strapWidth / 2, 8, false);
  const ropeMesh = new THREE.Mesh(ropeGeometry, strapMaterial);
  scene.add(ropeMesh);

  // 5. Load Card Model
  let cardSize = new THREE.Vector3(1, 1.5, 0.1);
  const gltfLoader = new GLTFLoader();
  try {
    const gltf = await new Promise((resolve, reject) => {
      gltfLoader.load('./3D-Lanyard/models/card.glb', resolve, undefined, reject);
    });
    
    cardMesh = gltf.scene;
    
    const box = new THREE.Box3().setFromObject(cardMesh);
    cardSize = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    cardMesh.traverse((child) => {
      if (child.isMesh) {
        child.position.sub(center);
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    
    const cardY = topAnchorPos.y - (segmentCount * segmentLength) - (cardSize.y / 2);
    
    const cardBodyDesc = RAPIER.RigidBodyDesc.dynamic();
    cardBodyDesc.setTranslation(0, cardY, 0);
    cardBodyDesc.setLinearDamping(1.0);
    cardBodyDesc.setAngularDamping(1.0);
    
    cardBody = world.createRigidBody(cardBodyDesc);
    // Lock all rotations physically for stability (Always face front)
    cardBody.lockRotations(true, true);
    const cardColliderDesc = RAPIER.ColliderDesc.cuboid(cardSize.x / 2, cardSize.y / 2, cardSize.z / 2).setMass(1.2);
    world.createCollider(cardColliderDesc, cardBody);

    scene.add(cardMesh);

    // Connect last strap segment to card
    const cardJointParams = RAPIER.JointData.spherical(
      { x: 0, y: -segmentLength, z: 0 },
      { x: 0, y: cardSize.y / 2, z: 0 }
    );
    world.createImpulseJoint(cardJointParams, parentBody, cardBody, true);
    
  } catch(err) {
    console.error("Failed to load card model.", err);
  }

  // 6. Interaction
  const raycaster = new THREE.Raycaster();
  const mouse = new THREE.Vector2();
  let draggedBody = null;
  let dragConstraint = null;
  
  const kMouseDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
  kMouseDesc.setTranslation(0, 0, 0);
  const kinematicMouseBody = world.createRigidBody(kMouseDesc);

  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  const intersection = new THREE.Vector3();

  const getPointerPos = (e) => {
    const rect = container.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  };

  const onPointerDown = (e) => {
    getPointerPos(e);
    raycaster.setFromCamera(mouse, camera);

    if (cardMesh) {
      const intersects = raycaster.intersectObject(cardMesh, true);
      if (intersects.length > 0) {
        draggedBody = cardBody;
        raycaster.ray.intersectPlane(dragPlane, intersection);
        kinematicMouseBody.setTranslation(intersection, true);
        
        const jointParams = RAPIER.JointData.spherical({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
        dragConstraint = world.createImpulseJoint(jointParams, kinematicMouseBody, draggedBody, true);
        document.body.style.cursor = 'grabbing';
      }
    }
  };

  const onPointerMove = (e) => {
    if (!draggedBody) return;
    getPointerPos(e);
    raycaster.setFromCamera(mouse, camera);
    raycaster.ray.intersectPlane(dragPlane, intersection);
    kinematicMouseBody.setNextKinematicTranslation(intersection);
  };

  const onPointerUp = () => {
    if (dragConstraint) {
      world.removeImpulseJoint(dragConstraint, true);
      dragConstraint = null;
    }
    draggedBody = null;
    document.body.style.cursor = 'default';
  };

  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  if (placeholder) {
    placeholder.classList.add('hidden');
  }

  // 7. Update Loop
  const clock = new THREE.Clock();
  let accumulator = 0;
  const deltaTime = 1 / 60;

  const animate = () => {
    requestAnimationFrame(animate);
    
    accumulator += Math.min(clock.getDelta(), 0.1);
    while (accumulator >= deltaTime) {
      world.step();
      accumulator -= deltaTime;
    }

    // Update Rope Geometry
    const points = [new THREE.Vector3(topAnchorPos.x, topAnchorPos.y, topAnchorPos.z)];
    ropeBodies.forEach(body => {
      const t = body.translation();
      points.push(new THREE.Vector3(t.x, t.y, t.z));
    });
    
    if (cardBody) {
      const t = cardBody.translation();
      // Connect to top center of card
      points.push(new THREE.Vector3(t.x, t.y + cardSize.y / 2, t.z));
      
      // Update Card Mesh
      cardMesh.position.set(t.x, t.y, t.z);
      // LOCK ROTATION: Always face camera (neutral rotation)
      cardMesh.quaternion.set(0, 0, 0, 1);
    }

    curve.points = points;
    ropeMesh.geometry.dispose();
    ropeMesh.geometry = new THREE.TubeGeometry(curve, 64, strapWidth / 2, 8, false);

    // Dynamic Texture Repeat to prevent squashing
    if (strapTexture) {
      const curveLength = curve.getLength();
      // U is mapped along the curve length, V is mapped around the circumference
      // Circumference = strapWidth * PI
      const circumference = strapWidth * Math.PI;
      // repeatCount = length / circumference
      const repeatCount = curveLength / circumference; 
      strapTexture.repeat.set(repeatCount, 1);
    }

    renderer.render(scene, camera);
  };
  animate();

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
});


