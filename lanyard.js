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
    const camera = new THREE.PerspectiveCamera(20, container.clientWidth / container.clientHeight, 0.1, 1000);
    camera.position.set(0, 1, 13); // Mundur + sedikit naik agar card & tali proporsional

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
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.8);
    fillLight.position.set(-5, 0, 5);
    scene.add(fillLight);

    let cardBody = null;
    let cardMesh = null;
    let cardSize = new THREE.Vector3(1, 1.5, 0.05);

    // 4. Strap / Tali Config
    // FIX: Kurangi segment & panjang agar card tidak terlalu jauh ke bawah
    const segmentCount = 12;
    const segmentLength = 0.22;
    const strapWidth = 0.12; // Lebar tali flat ribbon (dalam world units)

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
      console.warn("Strap texture not found, using fallback color.");
    }

    // FIX Masalah 2: Material tali flat (bukan tabung)
    const strapMaterial = new THREE.MeshStandardMaterial({
      color: strapTexture ? 0xffffff : 0x1a1a1a,
      map: strapTexture,
      roughness: 0.7,
      metalness: 0.05,
      side: THREE.DoubleSide,
    });

    // Anchor point di atas — posisi disesuaikan agar card terlihat proporsional di viewport
    const topAnchorPos = { x: 0, y: 3.2, z: 0 };
    const anchorDesc = RAPIER.RigidBodyDesc.fixed();
    anchorDesc.setTranslation(topAnchorPos.x, topAnchorPos.y, topAnchorPos.z);
    const anchorBody = world.createRigidBody(anchorDesc);
    let parentBody = anchorBody;

    const ropeBodies = [];
    for (let i = 0; i < segmentCount; i++) {
      const yPos = topAnchorPos.y - (i * segmentLength);

      const bodyDesc = RAPIER.RigidBodyDesc.dynamic();
      bodyDesc.setTranslation(0, yPos, 0);
      bodyDesc.setLinearDamping(0.9);
      bodyDesc.setAngularDamping(0.9);

      const body = world.createRigidBody(bodyDesc);
      const colliderDesc = RAPIER.ColliderDesc.ball(0.04).setMass(0.04);
      world.createCollider(colliderDesc, body);
      ropeBodies.push(body);

      const jointParams = RAPIER.JointData.spherical(
        { x: 0, y: i === 0 ? 0 : -segmentLength, z: 0 },
        { x: 0, y: 0, z: 0 }
      );
      world.createImpulseJoint(jointParams, parentBody, body, true);
      parentBody = body;
    }

    // FIX Masalah 2: Ribbon Mesh — bukan TubeGeometry, tapi PlaneGeometry yang di-update sepanjang curve
    // Kita pakai teknik custom ribbon: dua sisi paralel dari curve, disambung jadi mesh strip datar
    const ribbonSegments = 60;
    // Geometry sementara, akan di-rebuild tiap frame
    const ribbonGeometry = new THREE.BufferGeometry();
    const ribbonVertices = new Float32Array((ribbonSegments + 1) * 2 * 3);
    const ribbonUVs = new Float32Array((ribbonSegments + 1) * 2 * 2);
    const ribbonIndices = [];
    for (let i = 0; i < ribbonSegments; i++) {
      const a = i * 2, b = i * 2 + 1, c = i * 2 + 2, d = i * 2 + 3;
      ribbonIndices.push(a, b, c, b, d, c);
    }
    ribbonGeometry.setAttribute('position', new THREE.BufferAttribute(ribbonVertices, 3));
    ribbonGeometry.setAttribute('uv', new THREE.BufferAttribute(ribbonUVs, 2));
    ribbonGeometry.setIndex(ribbonIndices);
    const ribbonMesh = new THREE.Mesh(ribbonGeometry, strapMaterial);
    scene.add(ribbonMesh);

    // Helper: update ribbon dari array titik curve
    // FIX: getTangents tidak exist di Three.js — hitung tangent manual dari selisih antar titik
    function updateRibbon(curvePoints) {
      if (curvePoints.length < 2) return;
      const curve = new THREE.CatmullRomCurve3(curvePoints);
      const points = curve.getPoints(ribbonSegments);
      const up = new THREE.Vector3(0, 0, 1); // ribbon flat menghadap kamera

      const posArr = ribbonGeometry.attributes.position.array;
      const uvArr = ribbonGeometry.attributes.uv.array;
      const halfW = strapWidth / 2;

      for (let i = 0; i <= ribbonSegments; i++) {
        // Hitung tangent manual: selisih titik sebelum & sesudah
        let tangent;
        if (i === 0) {
          tangent = new THREE.Vector3().subVectors(points[1], points[0]).normalize();
        } else if (i === ribbonSegments) {
          tangent = new THREE.Vector3().subVectors(points[i], points[i - 1]).normalize();
        } else {
          tangent = new THREE.Vector3().subVectors(points[i + 1], points[i - 1]).normalize();
        }

        // right = cross(tangent, up) → arah lebar ribbon
        const right = new THREE.Vector3().crossVectors(tangent, up).normalize();

        // Kalau right hampir nol (tali lurus vertikal), fallback ke X
        if (right.lengthSq() < 0.001) right.set(1, 0, 0);

        const p = points[i];
        const l = p.clone().addScaledVector(right, -halfW);
        const r = p.clone().addScaledVector(right, halfW);

        const vi = i * 2;
        posArr[vi * 3]     = l.x; posArr[vi * 3 + 1]     = l.y; posArr[vi * 3 + 2]     = l.z;
        posArr[(vi+1)*3]   = r.x; posArr[(vi+1)*3 + 1]   = r.y; posArr[(vi+1)*3 + 2]   = r.z;

        const u = i / ribbonSegments;
        uvArr[vi * 2] = 0; uvArr[vi * 2 + 1] = u;
        uvArr[(vi+1)*2] = 1; uvArr[(vi+1)*2 + 1] = u;
      }

      ribbonGeometry.attributes.position.needsUpdate = true;
      ribbonGeometry.attributes.uv.needsUpdate = true;
      ribbonGeometry.computeVertexNormals();
    }

    // 5. Load Card Model
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
      // FIX Masalah 1: Damping yang wajar, JANGAN lock rotasi
      cardBodyDesc.setLinearDamping(1.2);
      cardBodyDesc.setAngularDamping(2.5); // Angular damping tinggi = rotasi pelan & smooth, tidak liar

      cardBody = world.createRigidBody(cardBodyDesc);
      // FIX Masalah 1: TIDAK lockRotations — biarkan fisika yang handle goyang kartu
      // Tapi kita restrict agar card tidak berputar di sumbu Y (tetap menghadap depan)
      // Caranya: enable angular axes X dan Z saja (no Y spin)
      cardBody.setEnabledRotations(true, false, true, true); // rotasi X & Z boleh, Y tidak

      const cardColliderDesc = RAPIER.ColliderDesc.cuboid(
        cardSize.x / 2,
        cardSize.y / 2,
        cardSize.z / 2
      ).setMass(1.0);
      world.createCollider(cardColliderDesc, cardBody);

      scene.add(cardMesh);

      // Connect last strap segment ke card
      const cardJointParams = RAPIER.JointData.spherical(
        { x: 0, y: -segmentLength * 0.5, z: 0 },
        { x: 0, y: cardSize.y / 2, z: 0 }
      );
      world.createImpulseJoint(cardJointParams, parentBody, cardBody, true);

    } catch (err) {
      console.error("Failed to load card model.", err);
      // Fallback box card jika model tidak ada
      const fallbackGeo = new THREE.BoxGeometry(0.7, 1.0, 0.04);
      const fallbackMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
      cardMesh = new THREE.Mesh(fallbackGeo, fallbackMat);
      cardSize = new THREE.Vector3(0.7, 1.0, 0.04);

      const cardY = topAnchorPos.y - (segmentCount * segmentLength) - (cardSize.y / 2);
      const cardBodyDesc = RAPIER.RigidBodyDesc.dynamic();
      cardBodyDesc.setTranslation(0, cardY, 0);
      cardBodyDesc.setLinearDamping(1.2);
      cardBodyDesc.setAngularDamping(2.5);
      cardBody = world.createRigidBody(cardBodyDesc);
      cardBody.setEnabledRotations(true, false, true, true);

      const cardColliderDesc = RAPIER.ColliderDesc.cuboid(
        cardSize.x / 2, cardSize.y / 2, cardSize.z / 2
      ).setMass(1.0);
      world.createCollider(cardColliderDesc, cardBody);
      scene.add(cardMesh);

      const cardJointParams = RAPIER.JointData.spherical(
        { x: 0, y: -segmentLength * 0.5, z: 0 },
        { x: 0, y: cardSize.y / 2, z: 0 }
      );
      world.createImpulseJoint(cardJointParams, parentBody, cardBody, true);
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

    // Quaternion helper untuk smooth card rotation
    const _cardQuat = new THREE.Quaternion();
    const _targetQuat = new THREE.Quaternion();

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

      // Update Ribbon Geometry dari posisi rope bodies
      const curvePoints = [new THREE.Vector3(topAnchorPos.x, topAnchorPos.y, topAnchorPos.z)];
      ropeBodies.forEach(body => {
        const t = body.translation();
        curvePoints.push(new THREE.Vector3(t.x, t.y, t.z));
      });

      if (cardBody) {
        const t = cardBody.translation();
        // Ujung tali ke titik atas kartu
        curvePoints.push(new THREE.Vector3(t.x, t.y + cardSize.y / 2, t.z));

        // FIX Masalah 1: Ambil rotasi dari fisika, JANGAN di-reset paksa
        const rot = cardBody.rotation();
        _cardQuat.set(rot.x, rot.y, rot.z, rot.w);

        // Smooth lerp rotasi agar tidak terlalu "snap" tapi tetap ada goyang
        cardMesh.quaternion.slerp(_cardQuat, 0.15);
        cardMesh.position.set(t.x, t.y, t.z);
      }

      // Update ribbon
      updateRibbon(curvePoints);

      // Update UV repeat tali sesuai panjang
      if (strapTexture) {
        const totalLength = curvePoints.reduce((acc, pt, i) => {
          if (i === 0) return acc;
          return acc + pt.distanceTo(curvePoints[i - 1]);
        }, 0);
        strapTexture.repeat.set(1, Math.max(1, Math.round(totalLength / strapWidth)));
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
