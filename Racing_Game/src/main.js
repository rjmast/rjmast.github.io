import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RapierPhysics } from './lib/RapierPhysics.js';
import { RapierHelper } from 'three/addons/helpers/RapierHelper.js';
import Stats from 'three/addons/libs/stats.module.js';
// Post-processing for cinematic distance blur (depth-of-field) on the huge
// Spa map. Used only on maps that opt in via MAPS[id].dof — Nordschleife /
// GP go straight through renderer.render() with zero overhead.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { openRoom, generateRoomCode } from './lib/net.js';

// ── console muzzle ──
// Wallet / Web3 / inspector extensions inject contentscript code that
// throws ReferenceErrors ("VI is not defined", "jw is not defined") and
// floods console.warn with their internal EventEmitter / ObjectMultiplex
// chatter. None of this is from the game; it just buries the actual
// [ai] / [track] / [preload] logs we care about. Suppress just the noise
// — leave everything else untouched.
( () => {

    const NOISE = [
        /VI is not defined/,
        /jw is not defined/,
        /MaxListenersExceededWarning/,
        /ObjectMultiplex/,
        /RGBELoader has been deprecated/,
        /THREE\.Clock: This module has been deprecated/
    ];
    const isNoise = ( args ) => {

        const s = args && args.length ? String( args[ 0 ] ) : '';
        for ( const re of NOISE ) if ( re.test( s ) ) return true;
        return false;

    };
    for ( const k of [ 'warn', 'error', 'log' ] ) {

        const orig = console[ k ].bind( console );
        console[ k ] = ( ...args ) => { if ( ! isNoise( args ) ) orig( ...args ); };

    }
    // Uncaught ReferenceErrors from injected extension scripts surface as
    // ErrorEvents on window — kill them at the source so they never reach
    // the console.
    window.addEventListener( 'error', ( e ) => {

        if ( e && e.message && ( e.message.includes( 'VI is not defined' ) || e.message.includes( 'jw is not defined' ) ) ) e.preventDefault();

    }, true );

} )();

let camera, scene, renderer, stats;
let physics, physicsHelper, controls;
let car, chassis, chassisCollider, wheels, vehicleController;
let clock;
let fpsLabel, posLabel;
let lapTimer;
let track, trackBody, sunLight, sunTarget;
// AI driver state. `racingLine` is the per-map waypoint loop loaded from
// public/racing-lines/<id>.json by loadTrack(); `ai.enabled` is the L-toggle.
// See aiUpdate() / toggleAiMode() near the bottom of the file.
let racingLine = null;
const ai = {
    enabled: false,
    closestIdx: 0,
    // ±1 — which way to step through racingLine each frame. Decided at toggle
    // time by comparing waypoint tangent vs car heading; necessary because
    // the Hierholzer Euler circuit doesn't always emit waypoints in the
    // direction the player spawns facing, and the offline `orientLoop` check
    // is fooled by doubled-back sections.
    dir: 1,
    lineMesh: null,
    badgeEl: null,
    paintedMats: new Map(),
    paintColor: 0x9933FF,
    // Stuck-recovery: if forward-velocity stays near zero while we're trying
    // to drive, kick into a fixed-duration straight reverse to back off
    // grass / wall, then let the per-frame direction picker reacquire the
    // line in the correct heading. postRecoverUntil is a short grace window
    // immediately after recovery during which we DON'T count stuck time, so
    // the car has a moment to pick up forward speed before being judged
    // wedged again.
    stuckMs: 0,
    recoverUntil: 0,
    postRecoverUntil: 0
};

// ─── AI per-car / per-track tuning tables ────────────────────────────────
// These multiply the offline-baked `wp.v` (m/s) and shape the AI controller's
// brake-distance, trail-brake, and corner-exit decisions so each car drives
// like its archetype on each circuit. Effective corner speed cap:
//   v_cap = wp.v * car.gripMu * track.gripMu * track.aggression
// (with a defensive 0.95 headroom enforced in the controller itself).
//
// IMPORTANT: `wp.v` is ALREADY grip-limited by the offline min-curvature
// optimizer (v ≤ sqrt(μ·g/κ)), so multiplying by gripMu > 1 means "I trust my
// tyres a hair more than the optimizer did" — keep it modest. `cornerEntryLift`
// is similar: < 1.0 means "carry MORE speed into the corner than baked v",
// which on grip-limited corners is the launch-off-track button. We CLAMP the
// lift's effect downstream so vEff ≤ vCap × 1.04 max, but keeping these values
// near 1.0 keeps the controller honest.
//
// Keys match CARS[*].name (lowercased / normalised) and MAPS object keys.
const AI_CAR_PROFILES = {
    // 1300 kg FWD hot-hatch baseline. Understeery, narrow tyres, modest brakes;
    // no business trail-braking or pinning the throttle on exit.
    hatchback: {
        gripMu: 0.95, brakeBias: 0.95, throttleRamp: 0.55,
        trailBrakeStrength: 0.05, apexSlipTarget: 0.06,
        lookaheadGain: 0.95, cornerEntryLift: 1.00, slipLimit: 3.8
    },
    // 1700 kg RWD muscle. Heavy nose, fat torque, easy to swing the rear —
    // gentler throttle ramp and a real slipLimit to keep the tail in check.
    muscle: {
        gripMu: 0.98, brakeBias: 1.00, throttleRamp: 0.50,
        trailBrakeStrength: 0.08, apexSlipTarget: 0.09,
        lookaheadGain: 1.00, cornerEntryLift: 1.00, slipLimit: 4.5
    },
    // 1430 kg RWD GT3-class. Sharp turn-in, high revs, real brakes; can carry
    // serious speed mid-corner and trail-brake the front end.
    sport: {
        gripMu: 1.03, brakeBias: 1.15, throttleRamp: 0.80,
        trailBrakeStrength: 0.14, apexSlipTarget: 0.10,
        lookaheadGain: 1.10, cornerEntryLift: 0.99, slipLimit: 4.5
    },
    // AWD turbo rally. Stamp it on exit, late-brake into hairpins, big slip
    // headroom (4WD pulls itself straight) and a higher trailBrake for rotation.
    rally: {
        gripMu: 1.05, brakeBias: 1.10, throttleRamp: 0.95,
        trailBrakeStrength: 0.14, apexSlipTarget: 0.12,
        lookaheadGain: 1.05, cornerEntryLift: 0.98, slipLimit: 5.5
    },
    // V12 RWD supercar. Massive top speed, big carbon brakes, but the rear
    // bites if you ramp throttle too hard — slightly softer ramp than Sport.
    supercar: {
        gripMu: 1.05, brakeBias: 1.25, throttleRamp: 0.75,
        trailBrakeStrength: 0.16, apexSlipTarget: 0.10,
        lookaheadGain: 1.18, cornerEntryLift: 0.99, slipLimit: 4.8
    },
    // F1 — downforce + carbon-ceramic + slicks. Brake hard, attack apexes with
    // moderate trail, full throttle on exit. Looks ~2 corners ahead. gripMu is
    // intentionally modest above 1.0 because the baked v already saturates
    // grip — the F1's advantage is the BRAKES and exit ramp, not corner cap.
    f1: {
        gripMu: 1.08, brakeBias: 1.45, throttleRamp: 1.00,
        trailBrakeStrength: 0.22, apexSlipTarget: 0.11,
        lookaheadGain: 1.35, cornerEntryLift: 0.99, slipLimit: 5.5
    },
    // God car — fantasy μ, fantasy brakes, fantasy aero. Planning ~3 corners
    // ahead, late-braking to obscene degrees, hangs the rear on demand.
    god: {
        gripMu: 1.15, brakeBias: 1.55, throttleRamp: 1.00,
        trailBrakeStrength: 0.22, apexSlipTarget: 0.14,
        lookaheadGain: 1.55, cornerEntryLift: 0.98, slipLimit: 7.0
    }
};

const AI_TRACK_PROFILES = {
    // Nordschleife: bumpy, partly damp, long blind corners. Lower grip, look
    // further ahead, run a hair under qualifying pace because we can't see
    // over crests until late.
    nurburgring:    { gripMu: 0.92, lookaheadBias: 1.20, aggression: 0.98 },
    // GP layout: fresh, flat, modern asphalt. Stop-and-go style means we can
    // afford to look slightly less far ahead and push grip closer to the limit.
    nurburgring_gp: { gripMu: 1.02, lookaheadBias: 0.95, aggression: 1.02 },
    // Suzuka: medium grip, flowy figure-8 with tight chicanes. Closer lookahead
    // for the esses, neutral aggression.
    suzuka:         { gripMu: 1.00, lookaheadBias: 0.90, aggression: 1.00 }
};

const AI_TRACK_DEFAULT = { gripMu: 1.00, lookaheadBias: 1.00, aggression: 1.00 };
const AI_CAR_DEFAULT = {
    gripMu: 1.00, brakeBias: 1.00, throttleRamp: 0.70,
    trailBrakeStrength: 0.10, apexSlipTarget: 0.08,
    lookaheadGain: 1.00, cornerEntryLift: 1.00, slipLimit: 4.5
};

function _aiCarProfile() {
    // Normalise the CARS[*].name strings to the AI_CAR_PROFILES keys.
    if ( ! currentCar ) return AI_CAR_DEFAULT;
    const n = currentCar.name;
    if ( n === 'Hatchback' )      return AI_CAR_PROFILES.hatchback;
    if ( n === 'Muscle V8' )      return AI_CAR_PROFILES.muscle;
    if ( n === 'Sport Flat-six' ) return AI_CAR_PROFILES.sport;
    if ( n === 'Rally Turbo' )    return AI_CAR_PROFILES.rally;
    if ( n === 'Supercar V12' )   return AI_CAR_PROFILES.supercar;
    if ( n === 'F1' )             return AI_CAR_PROFILES.f1;
    if ( n === 'God Car' )        return AI_CAR_PROFILES.god;
    return AI_CAR_DEFAULT;
}
function _aiTrackProfile() {
    return AI_TRACK_PROFILES[ currentMapId ] || AI_TRACK_DEFAULT;
}

let speedoEl, speedoNumEl, speedoGearEl, speedoRpmFillEl, speedoModeEl, speedoControllerEl;

// Lucide SVG icons inlined so we don't pull in the whole lucide package.
// Both use `currentColor` so they inherit text colour.
const ICONS = {
    'bar-chart-3': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>',
    'gamepad-2': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>',
    'x': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
};

function iconHTML( name, size = 14 ) {

    return `<span style="display:inline-flex;width:${ size }px;height:${ size }px;vertical-align:-2px">${ ICONS[ name ] || '' }</span>`;

}

// ---------------- steering wheel + cockpit (driver POV) ----------------

function buildSteeringWheel( car ) {

    const group = new THREE.Group();

    let rimColor = 0x111111, hubColor = 0x222222, spokeColor = 0x111111;
    let rimMetal = 0.4, rimRough = 0.6;
    let hubMetal = 0.4, hubRough = 0.6;
    let hubEmissive = 0x000000, hubEmissiveIntensity = 0;
    let spokeMetal = 0.4, spokeRough = 0.6;
    let flatBottom = false;
    let paddles = false;

    switch ( car.name ) {

        case 'Hatchback':      rimColor = 0x111111; hubColor = 0xFFD400; spokeColor = 0xFFD400; break;
        case 'Muscle V8':      rimColor = 0x111111; hubColor = 0xCC1A1A; spokeColor = 0x111111; break;
        case 'Sport Flat-six': rimColor = 0x111111; hubColor = 0x1A1A1A; spokeColor = 0xC0C0C0; spokeMetal = 0.8; spokeRough = 0.3; break;
        case 'Rally Turbo':    rimColor = 0x1F4DFF; hubColor = 0x111111; spokeColor = 0x111111; rimRough = 0.95; rimMetal = 0.05; break;
        case 'Supercar V12':   rimColor = 0x0A0A0A; hubColor = 0x1A1A1A; spokeColor = 0xFF6F1A; rimRough = 0.9; rimMetal = 0.05; break;
        case 'F1':             rimColor = 0x080808; hubColor = 0xCC1A1A; spokeColor = 0x111111; rimRough = 0.4; rimMetal = 0.3; flatBottom = true; paddles = true; break;
        case 'God Car':        rimColor = 0xEEEEEE; hubColor = 0x00FFFF; spokeColor = 0xEEEEEE; rimMetal = 0.9; rimRough = 0.15; spokeMetal = 0.9; spokeRough = 0.15; hubEmissive = 0x00FFFF; hubEmissiveIntensity = 1.0; break;

    }

    const rimMat = new THREE.MeshStandardMaterial( { color: rimColor, metalness: rimMetal, roughness: rimRough } );
    const hubMat = new THREE.MeshStandardMaterial( { color: hubColor, metalness: hubMetal, roughness: hubRough, emissive: hubEmissive, emissiveIntensity: hubEmissiveIntensity } );
    const spokeMat = new THREE.MeshStandardMaterial( { color: spokeColor, metalness: spokeMetal, roughness: spokeRough } );

    const rimR = 0.18, rimTube = 0.025;
    let rimGeo;
    if ( flatBottom ) {

        const gap = Math.PI / 3;
        rimGeo = new THREE.TorusGeometry( rimR, rimTube, 8, 32, Math.PI * 2 - gap );
        rimGeo.rotateZ( - Math.PI / 2 + gap / 2 );

    } else {

        rimGeo = new THREE.TorusGeometry( rimR, rimTube, 8, 32 );

    }
    const rim = new THREE.Mesh( rimGeo, rimMat );
    rim.castShadow = false;
    group.add( rim );

    const hub = new THREE.Mesh( new THREE.CylinderGeometry( 0.05, 0.05, 0.05, 16 ), hubMat );
    hub.rotation.x = Math.PI / 2;
    hub.castShadow = false;
    group.add( hub );

    const spokeInner = 0.04, spokeOuter = rimR;
    const spokeLen = spokeOuter - spokeInner;
    const spokeGeo = new THREE.BoxGeometry( spokeLen, 0.02, 0.015 );
    const baseAngles = [ Math.PI / 2, Math.PI / 2 + ( 2 * Math.PI ) / 3, Math.PI / 2 + ( 4 * Math.PI ) / 3 ];
    for ( const a of baseAngles ) {

        const spoke = new THREE.Mesh( spokeGeo, spokeMat );
        const midR = ( spokeInner + spokeOuter ) / 2;
        spoke.position.set( Math.cos( a ) * midR, Math.sin( a ) * midR, 0 );
        spoke.rotation.z = a;
        spoke.castShadow = false;
        group.add( spoke );

    }

    if ( paddles ) {

        const paddleMat = new THREE.MeshStandardMaterial( { color: 0xCC1A1A, metalness: 0.3, roughness: 0.5 } );
        const paddleGeo = new THREE.BoxGeometry( 0.06, 0.04, 0.01 );
        const pL = new THREE.Mesh( paddleGeo, paddleMat );
        pL.position.set( - 0.15, - 0.2, - 0.02 );
        pL.castShadow = false;
        group.add( pL );
        const pR = new THREE.Mesh( paddleGeo, paddleMat );
        pR.position.set( 0.15, - 0.2, - 0.02 );
        pR.castShadow = false;
        group.add( pR );

    }

    return group;

}

function _disposeSteeringWheel() {

    if ( ! steeringWheelGroup || ! car ) return;
    car.remove( steeringWheelGroup );
    steeringWheelGroup.traverse( ( o ) => {

        if ( o.geometry ) o.geometry.dispose();
        if ( o.material ) o.material.dispose();

    } );
    steeringWheelGroup = null;
    steeringWheelMesh = null;

}

function buildAndMountSteeringWheel( carConfig ) {

    if ( ! car ) return;
    _disposeSteeringWheel();
    const cockpit = COCKPITS[ carConfig.name ];
    if ( ! cockpit ) return;

    steeringWheelGroup = new THREE.Group();
    steeringWheelGroup.position.set( cockpit.steeringWheelOffset.x, cockpit.steeringWheelOffset.y, cockpit.steeringWheelOffset.z );
    steeringWheelGroup.rotation.x = cockpit.steeringWheelTilt;
    car.add( steeringWheelGroup );

    steeringWheelMesh = buildSteeringWheel( carConfig );
    steeringWheelGroup.add( steeringWheelMesh );

}

const _povWorldPos = new THREE.Vector3();
const _povWorldLook = new THREE.Vector3();

function updatePovCamera() {

    if ( ! car ) return;
    const cockpit = COCKPITS[ currentCar.name ];
    if ( ! cockpit ) return;

    _povWorldPos.set( cockpit.cockpitOffset.x, cockpit.cockpitOffset.y, cockpit.cockpitOffset.z );
    car.localToWorld( _povWorldPos );
    camera.position.copy( _povWorldPos );

    _povWorldLook.set( cockpit.cockpitLookOffset.x, cockpit.cockpitLookOffset.y, cockpit.cockpitLookOffset.z );
    car.localToWorld( _povWorldLook );
    camera.lookAt( _povWorldLook );

    if ( Math.abs( camera.fov - cockpit.fov ) > 0.1 ) {

        camera.fov = cockpit.fov;
        camera.updateProjectionMatrix();

    }

}

function setCameraMode( mode ) {

    cameraMode = mode;
    if ( mode === 'pov' ) {

        if ( carVisualsGroup ) carVisualsGroup.visible = false;
        if ( controls ) controls.enabled = false;
        chaseCam.enabled = false;

    } else if ( mode === 'free' ) {

        if ( carVisualsGroup ) carVisualsGroup.visible = true;
        if ( controls ) controls.enabled = true;
        chaseCam.enabled = false;
        camera.fov = chaseCam.baseFov;
        camera.updateProjectionMatrix();

    } else { // chase

        if ( carVisualsGroup ) carVisualsGroup.visible = true;
        if ( controls ) controls.enabled = false;
        chaseCam.enabled = true;
        chaseCam.initialized = false;

    }

}

function cycleCameraMode() {

    const modes = [ 'chase', 'free', 'pov' ];
    const next = ( modes.indexOf( cameraMode ) + 1 ) % modes.length;
    setCameraMode( modes[ next ] );

}

// ---------------- crosshair raycast (X to identify mesh) ----------------
//
// Aim the camera at any mesh, press X, and we'll print the material
// name + world hit position. Useful for finding the junk meshes baked
// into the community track GLBs (debug cubes, leftover placeholders)
// without having to re-bake the asset — add the dumped (x, y, z) to
// `MAPS[id].excludeMeshesNear` and reload.

const _pickRaycaster = new THREE.Raycaster();
const _pickOrigin = new THREE.Vector2( 0, 0 );

function pickMeshAtCrosshair() {

    if ( ! camera || ! track ) return;
    _pickRaycaster.setFromCamera( _pickOrigin, camera );
    // Walk the entire track tree because chunked meshes live under a flat group.
    const hits = _pickRaycaster.intersectObject( track, true );
    if ( ! hits.length ) {

        console.log( '[pick] no mesh under crosshair' );
        return;

    }
    const hit = hits[ 0 ];
    const mat = hit.object && hit.object.material;
    const matName = mat && mat.name ? mat.name : '(unnamed)';
    const p = hit.point;
    console.log( `[pick] mat="${ matName }"  world (${ p.x.toFixed( 2 ) }, ${ p.y.toFixed( 2 ) }, ${ p.z.toFixed( 2 ) })  dist ${ hit.distance.toFixed( 1 ) }m  meshName="${ hit.object.name || '' }"` );
    showPickToast( matName, p );

}

let _pickToastEl = null;
let _pickToastTimer = 0;
function showPickToast( matName, p ) {

    if ( ! _pickToastEl ) {

        _pickToastEl = document.createElement( 'div' );
        _pickToastEl.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.85);color:#FFCB47;font-family:Monospace;font-size:14px;padding:10px 14px;border-radius:6px;pointer-events:none;z-index:9999;border:1px solid rgba(255,203,71,0.4);';
        document.body.appendChild( _pickToastEl );

    }
    _pickToastEl.textContent = `pick: "${ matName }"  @  ${ p.x.toFixed( 2 ) }, ${ p.y.toFixed( 2 ) }, ${ p.z.toFixed( 2 ) }`;
    _pickToastEl.style.display = 'block';
    clearTimeout( _pickToastTimer );
    _pickToastTimer = setTimeout( () => { if ( _pickToastEl ) _pickToastEl.style.display = 'none'; }, 4000 );

}

// ---------------- car swap (Q to cycle) ----------------

function applyCarConfig( car, skipVisuals ) {

    currentCar = car;

    // Engine model values used by every per-frame path.
    engine.idleRpm = car.engineIdleRpm;
    engine.redline = car.engineRedline;
    engine.autoUpshiftRpm = car.autoUpshiftRpm;
    engine.autoDownshiftRpm = car.autoDownshiftRpm;

    // Clamp current gear to the new car's gear count (if we shrank from 10
    // gears down to 5 we don't want to be in nonexistent 8th).
    if ( transmission.gear > car.gearRatios.length ) transmission.gear = car.gearRatios.length;

    // Mass — Rapier setAdditionalMass adds to the baseline (lightest car).
    // if ( chassis ) {

    //     const baselineMass = Math.min( ...CARS.map( c => c.mass ) );
    //     const extra = Math.max( 0, car.mass - baselineMass );
    //     chassis.setAdditionalMass( extra, true );

    // }
    
    // Mass + lowered center of mass. The chassis box is 2×1×4 centered at y=0,
    // but the wheels connect near y=-0.3, so the default CoM sits above the
    // suspension. Dropping the CoM below center kills the wheelie/pitch-up
    // under acceleration.
    if ( chassis ) {

        const totalMass = car.mass;

        // Solid-box inertia (1/12)·m·(a²+b²) per axis. Box = 2(x)×1(y)×4(z).
        const w = 2, h = 1, d = 4;
        const ix = ( 1 / 12 ) * totalMass * ( h * h + d * d );
        const iy = ( 1 / 12 ) * totalMass * ( w * w + d * d );
        const iz = ( 1 / 12 ) * totalMass * ( w * w + h * h );

        chassis.setAdditionalMassProperties(
            totalMass,
            { x: 0, y: - 0.5, z: 0 },          // CoM dropped 0.5m below center
            { x: ix, y: iy, z: iz },
            { x: 0, y: 0, z: 0, w: 1 },
            true
        );

    }
    

    // Re-apply the chassis-collider material every car swap. Friction is
    // the per-car value; restitution stays at 0 (cars scrape, never bounce
    // — see the comment in createCar for the underlying gotcha with how
    // addMesh stores the third arg). applyCarConfig runs before createCar
    // on first init, in which case there's no collider yet — skip silently
    // and the values will be set when createCar finishes.
    if ( chassisCollider ) {

        chassisCollider.setFriction( car.chassisFriction );
        chassisCollider.setRestitution( 0.0 );

    }

    // Per-wheel suspension + friction + connection-point Y. Wheels keep their
    // X/Z positions; we only retune what the wheel/spring does.
    if ( vehicleController ) {

        for ( let i = 0; i < 4; i ++ ) {

            vehicleController.setWheelFrictionSlip( i, car.wheelFrictionSlip );
            vehicleController.setWheelSuspensionStiffness( i, car.suspensionStiffness );
            vehicleController.setWheelSuspensionCompression( i, car.suspensionCompression );
            vehicleController.setWheelSuspensionRelaxation( i, car.suspensionRelaxation );
            vehicleController.setWheelSuspensionRestLength( i, car.suspensionRestLength );
            const cp = vehicleController.wheelChassisConnectionPointCs( i );
            vehicleController.setWheelChassisConnectionPointCs( i, { x: cp.x, y: car.wheelConnectionY, z: cp.z } );

        }

    }

    // Visuals.
    if ( ! skipVisuals && carVisualsGroup ) {

        _disposeCarVisuals();
        buildCarVisuals( carVisualsGroup, car );

    }

    // Cockpit / steering wheel rebuilt per-car (different colour, paddles
    // for F1, flat-bottomed rim, etc.).
    if ( ! skipVisuals ) buildAndMountSteeringWheel( car );

    // Re-bake the per-car toe into the wheel steering channel.
    applySuspensionGeometry();

    // Engine sound.
    swapEngineAudio( car );

    // Update the speedometer gear-digit colour + persistent top badge to match.
    const hex = '#' + car.bodyColor.toString( 16 ).padStart( 6, '0' );
    if ( speedoGearEl ) speedoGearEl.style.color = hex;
    if ( carBadgeEl ) {

        carBadgeEl.textContent = car.name.toUpperCase();
        carBadgeEl.style.color = hex;
        carBadgeEl.style.borderColor = hex + '4d'; // ~30% alpha

    }

}

function cycleCar( direction ) {

    if ( typeof _isCarLocked === 'function' && _isCarLocked() ) {

        if ( typeof showCarToast === 'function' ) showCarToast( 'car locked for race' );
        return;

    }

    currentCarIndex = ( currentCarIndex + direction + CARS.length ) % CARS.length;
    applyCarConfig( CARS[ currentCarIndex ] );
    showCarToast( CARS[ currentCarIndex ].name );
    resetTires();         // fresh tires on each car
    resetDrivetrain();    // engine starts at the new car's idle, clutch closed
    clearSkidMarks();
    if ( typeof resetDualsenseState === 'function' ) resetDualsenseState();
    if ( typeof _broadcastLocalMeta === 'function' ) _broadcastLocalMeta();

}

function initCarToast() {

    // Persistent top-right badge: sits above the keybind cheatsheet. Rounded
    // square edges (4px) to match the rest of the dark overlays.
    carBadgeEl = document.createElement( 'div' );
    carBadgeEl.className = 'car-badge-desktop';
    carBadgeEl.style.cssText = [
        'position:absolute', 'top:10px', 'right:10px',
        'padding:6px 12px', 'background:rgba(0,0,0,0.55)',
        'color:#FFCB47', 'font-family:Monospace', 'font-size:13px',
        'font-weight:700', 'letter-spacing:2px', 'border-radius:4px',
        'z-index:3', 'pointer-events:none',
        'border:1px solid rgba(255,255,255,0.18)',
        'box-shadow:0 4px 14px rgba(0,0,0,0.35)'
    ].join( ';' );
    carBadgeEl.textContent = currentCar.name.toUpperCase();
    document.body.appendChild( carBadgeEl );

    // Center pop-up toast on cycle.
    carToastEl = document.createElement( 'div' );
    carToastEl.style.cssText = [
        'position:absolute', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
        'padding:18px 36px', 'background:rgba(0,0,0,0.78)', 'color:#FFCB47',
        'font-family:Monospace', 'font-size:28px', 'font-weight:700',
        'letter-spacing:2px', 'border-radius:8px', 'z-index:10',
        'pointer-events:none', 'opacity:0', 'transition:opacity 200ms',
        'border:1px solid rgba(255,203,71,0.4)',
        'box-shadow:0 8px 32px rgba(0,0,0,0.5)'
    ].join( ';' );
    document.body.appendChild( carToastEl );

}

let _carToastTimer = null;
function showCarToast( name ) {

    if ( ! carToastEl ) return;
    carToastEl.textContent = '→  ' + name.toUpperCase();
    carToastEl.style.opacity = '1';
    if ( _carToastTimer ) clearTimeout( _carToastTimer );
    _carToastTimer = setTimeout( () => { carToastEl.style.opacity = '0'; }, 1400 );

}

// Generic toast — used for driver-assist toggles (ABS / TC on / off). Reuses
// the same overlay element as showCarToast so the visual style stays
// consistent and they don't fight for screen space.
function showToast( text ) {

    if ( ! carToastEl ) return;
    carToastEl.textContent = text;
    carToastEl.style.opacity = '1';
    if ( _carToastTimer ) clearTimeout( _carToastTimer );
    _carToastTimer = setTimeout( () => { carToastEl.style.opacity = '0'; }, 1200 );

}

function toggleTractionControl() {

    tcCfg.enabled = ! tcCfg.enabled;
    showToast( tcCfg.enabled ? 'TC ON' : 'TC OFF' );
    console.log( '[assists] TC →', tcCfg.enabled ? 'ON' : 'OFF' );

}

function toggleAbs() {

    absCfg.enabled = ! absCfg.enabled;
    showToast( absCfg.enabled ? 'ABS ON' : 'ABS OFF' );
    console.log( '[assists] ABS →', absCfg.enabled ? 'ON' : 'OFF' );

}

// ---------------- camber + toe (suspension geometry) ----------------
// Rapier's vehicle controller can't tilt wheel axles out of the suspension
// plane, so we approximate camber's effect on lateral grip by modulating
// setWheelSideFrictionStiffness with corner load. Toe is baked into the
// per-wheel steering offset (front wheels get base toe + driver steering on top).

const _DEG = Math.PI / 180;
const CAMBER_GRIP_PER_DEG = 0.06;     // +6 % lat grip per |°| of camber at reference load
const CAMBER_STRAIGHT_COST = 0.30;    // straight-line penalty coefficient

function applySuspensionGeometry() {

    if ( ! vehicleController || ! currentCar ) return;
    const toe = currentCar.toeDeg || [ 0, 0, 0, 0 ];
    for ( let i = 0; i < 4; i ++ ) {

        vehicleController.setWheelSteering( i, toe[ i ] * _DEG );

    }

}

function updateSuspensionGeometry() {

    if ( ! vehicleController || ! currentCar ) return;
    const camber = currentCar.camberDeg || [ 0, 0, 0, 0 ];
    for ( let i = 0; i < 4; i ++ ) {

        const cVal = camber[ i ];
        const cMag = Math.abs( cVal );
        if ( cMag < 0.01 ) {

            vehicleController.setWheelSideFrictionStiffness( i, 1.0 );
            continue;

        }
        const load = vehicleController.wheelIsInContact( i )
            ? Math.max( 0, vehicleController.wheelSuspensionForce( i ) )
            : 0;
        const loadFactor = load / TIRE_LOAD_REF;
        // Negative camber (top-leans-in) is the configured race setup → bonus
        // grip under load. Positive camber would reduce it. Penalty term scales
        // with magnitude either way (any camber away from 0° costs straight-line grip).
        const gain = - cVal * CAMBER_GRIP_PER_DEG * loadFactor;
        const penalty = cMag * CAMBER_STRAIGHT_COST * _DEG;
        const mult = Math.max( 0.5, 1.0 + gain - penalty );
        vehicleController.setWheelSideFrictionStiffness( i, mult );

    }

}

// Wheel index convention is FL=0, FR=1, RL=2, RR=3 (matches the
// "WHEELS · FL · FR · RL · RR" stats panel). Returns the indices that
// receive engine torque for a given driveType.
function drivenWheelIndices( driveType ) {

    if ( driveType === 'RWD' ) return [ 2, 3 ];
    if ( driveType === 'AWD' ) return [ 0, 1, 2, 3 ];
    return [ 0, 1 ]; // FWD default

}

// ---------------- drivetrain v2 (engine flywheel + clutch + LSD) ----------------
// Engine has its own angular velocity with flywheel inertia — no longer slaved
// kinematically to wheel speed. Clutch couples engine and wheels through a stiff
// spring; opens during shifts. LSD biases torque to the slower drive wheel.

const _OMEGA_PER_RPM = 2 * Math.PI / 60;
const _RPM_PER_OMEGA = 60 / ( 2 * Math.PI );

const drivetrain = {
    engineOmega: 900 * _OMEGA_PER_RPM, // start at idle
    lastWheelRotation: [ 0, 0, 0, 0 ],
    wheelOmega: [ 0, 0, 0, 0 ],
    clutchTorque: 0,
    clutchOpen: true,
    // Traction-control telemetry — updated each frame by applyVehicleForces.
    // `cutPct` is the largest fractional torque cut across driven wheels, in
    // [0,1]. `engaged` is sticky for ~120ms so the UI light stays visible.
    tc: { cutPct: 0, engaged: false, engagedUntil: 0, eventCount: 0 },
    // ABS telemetry — symmetric to TC but for the brake side. cutPct is the
    // largest fractional brake-force cut across the four wheels this frame.
    abs: { cutPct: 0, engaged: false, engagedUntil: 0, eventCount: 0 }
};

function resetDrivetrain() {

    drivetrain.engineOmega = ( engine.idleRpm || 900 ) * _OMEGA_PER_RPM;
    drivetrain.clutchTorque = 0;
    drivetrain.clutchOpen = true;
    for ( let i = 0; i < 4; i ++ ) {

        // Seed lastWheelRotation from the live wheel so the first-frame
        // finite-difference doesn't generate a fake huge ω.
        drivetrain.lastWheelRotation[ i ] = vehicleController ? ( vehicleController.wheelRotation( i ) || 0 ) : 0;
        drivetrain.wheelOmega[ i ] = 0;

    }

}

function _idleGovernor( omegaRpm ) {

    const target = engine.idleRpm + 200;
    if ( omegaRpm >= target ) return 0;
    return ( target - omegaRpm ) / target;

}

function updateDrivetrain( dt, throttle, ratio, brake ) {

    if ( ! vehicleController ) return;

    // 1) wheel ω from wheelRotation finite-difference, light low-pass.
    for ( let i = 0; i < 4; i ++ ) {

        const theta = vehicleController.wheelRotation( i ) || 0;
        let dTheta = theta - drivetrain.lastWheelRotation[ i ];
        if ( dTheta > Math.PI ) dTheta -= 2 * Math.PI;
        if ( dTheta < - Math.PI ) dTheta += 2 * Math.PI;
        drivetrain.lastWheelRotation[ i ] = theta;
        const raw = dTheta / Math.max( dt, 1e-4 );
        drivetrain.wheelOmega[ i ] = drivetrain.wheelOmega[ i ] * 0.6 + raw * 0.4;

    }

    // 2) Engine torque has TWO components:
    //    - playerTorque: what the driver actually asked for (throttle). This is
    //      what's available to transmit through the clutch to the wheels.
    //    - idleTorque: internal anti-stall, ONLY spins the flywheel — never
    //      reaches the wheels. Real engines maintain idle via spark + fuel that
    //      doesn't get passed to the gearbox.
    const rpm = drivetrain.engineOmega * _RPM_PER_OMEGA;
    const torqueBell = torqueAt( rpm );
    const playerTorque = Math.max( 0, throttle ) * torqueBell * currentCar.maxEngineForce;
    const idleTorque = _idleGovernor( rpm ) * torqueBell * currentCar.maxEngineForce;

    // 3) Internal friction. Brake adds a small engine-braking bleed.
    const frictionCoef = 0.00018 + 0.00045 * brake;
    const engineFriction = frictionCoef * drivetrain.engineOmega * currentCar.maxEngineForce;

    // 4) Clutch. Open during shifts (`shiftCooldown > 0`) and in neutral.
    //    Saturation is bounded by the PLAYER-requested torque plus a tiny creep
    //    allowance (so automatics inch forward at a stop, brake disables creep).
    const clutchOpen = transmission.shiftCooldown > 0 || ratio === 0;
    drivetrain.clutchOpen = clutchOpen;
    let clutchTorque = 0;
    if ( ! clutchOpen ) {

        const gearMult = Math.abs( ratio ) * currentCar.finalDrive;
        const wheelOmegaAvg = 0.5 * ( drivetrain.wheelOmega[ 0 ] + drivetrain.wheelOmega[ 1 ] );
        const wheelEquivAtClutch = wheelOmegaAvg * gearMult * Math.sign( ratio );
        const slip = drivetrain.engineOmega - wheelEquivAtClutch;
        // Clutch saturation is sized like a real clutch — fixed friction limit,
        // NOT scaled with current throttle. Real clutches transmit up to about
        // 1.5× engine peak torque; the engine finds equilibrium via slip.
        // We DO gate the FORWARD-drive direction by throttle (so off-throttle
        // doesn't push the car forward), but keep the REVERSE direction at
        // ~half peak so engine-braking still works when coasting off throttle.
        const maxFwd = ( throttle > 0.05 )
            ? currentCar.maxEngineForce * 1.5
            : ( brake > 0.05 ? 0 : currentCar.maxEngineForce * 0.03 );
        const maxRev = currentCar.maxEngineForce * 0.5;
        let raw = slip * currentCar.clutchStiffness * 0.05;
        if ( raw > maxFwd ) raw = maxFwd;
        if ( raw < - maxRev ) raw = - maxRev;
        clutchTorque = raw;

    }
    drivetrain.clutchTorque = clutchTorque;

    // 5) Integrate flywheel: dω = (T_player + T_idle − T_friction − T_clutch) / I.
    //    Both engine torque components add to the flywheel; only T_clutch leaves
    //    via the gearbox.
    const netTorque = playerTorque + idleTorque - engineFriction - clutchTorque;
    drivetrain.engineOmega += ( netTorque / currentCar.engineInertia ) * dt;

    const stallOmega = engine.idleRpm * 0.8 * _OMEGA_PER_RPM;
    const redlineOmega = engine.redline * 1.02 * _OMEGA_PER_RPM;
    if ( drivetrain.engineOmega < stallOmega ) drivetrain.engineOmega = stallOmega;
    if ( drivetrain.engineOmega > redlineOmega ) drivetrain.engineOmega = redlineOmega;

    // Publish to existing engine.rpm so HUD / audio remain unchanged.
    engine.rpm = drivetrain.engineOmega * _RPM_PER_OMEGA;

    // 6) Split clutch torque across drive wheels (front-wheel-drive only here).
    //    LSD bias: factor=0 → open diff (equal split), factor=1 → fully locked
    //    (all torque to slower wheel).
    //
    //    NOTE: we do NOT gear-amplify clutchTorque here. The torqueAt(rpm) curve
    //    and per-car maxEngineForce together produce values calibrated for the
    //    wheel-side (matching the original simple model). Multiplying by
    //    gearMult would 10×+ amplify creep at idle into a real launch.
    let wheelTorque0 = 0, wheelTorque1 = 0;
    if ( ! clutchOpen ) {

        const totalAtWheels = clutchTorque * Math.sign( ratio );
        const w0 = Math.abs( drivetrain.wheelOmega[ 0 ] );
        const w1 = Math.abs( drivetrain.wheelOmega[ 1 ] );
        const fast = Math.max( w0, w1, 0.1 );
        const slow = Math.min( w0, w1 );
        const lockingExp = Math.max( 0.05, 4 * ( 1 - currentCar.lsdLocking ) );
        const bias = Math.pow( slow / fast, lockingExp );
        const slowShare = 0.5 + 0.5 * ( 1 - bias );
        const fastShare = 1 - slowShare;
        if ( w0 <= w1 ) {

            wheelTorque0 = totalAtWheels * slowShare;
            wheelTorque1 = totalAtWheels * fastShare;

        } else {

            wheelTorque0 = totalAtWheels * fastShare;
            wheelTorque1 = totalAtWheels * slowShare;

        }

    }

    // Rapier convention: NEGATIVE engine force = forward motion.
    vehicleController.setWheelEngineForce( 0, - wheelTorque0 );
    vehicleController.setWheelEngineForce( 1, - wheelTorque1 );

}

// ---------------- aerodynamics ----------------
// F_drag    = Cd × v²  applied opposite to velocity
// F_downforce = Cl × v²  applied in -Y world
// Per-car Cd / Cl already baked into each CARS entry by the planning subagent
// so engine force ≈ Cd × topSpeed² balances at the target top speed.

const _aeroVel = new THREE.Vector3();
const _aeroImpulse = { x: 0, y: 0, z: 0 };

function updateAerodynamics( dt ) {

    if ( ! chassis || ! currentCar ) return;
    const v = chassis.linvel();
    const speed2 = v.x * v.x + v.y * v.y + v.z * v.z;
    if ( speed2 < 25 ) return; // < 5 m/s, skip — no meaningful aero at low speed

    const Cd = currentCar.Cd || 0;
    const Cl = currentCar.Cl || 0;
    if ( Cd <= 0 && Cl <= 0 ) return;

    const speed = Math.sqrt( speed2 );
    // Drag impulse opposite velocity. F = Cd × v², impulse = F × dt, then split
    // back across components via the unit vector.
    if ( Cd > 0 ) {

        const dragMag = Cd * speed2;
        const k = ( dragMag * dt ) / speed;
        _aeroImpulse.x = - v.x * k;
        _aeroImpulse.y = - v.y * k;
        _aeroImpulse.z = - v.z * k;
        chassis.applyImpulse( _aeroImpulse, true );

    }

    // Downforce: F = Cl × v² straight down in world. Pure load, no pitch torque.
    if ( Cl > 0 ) {

        _aeroImpulse.x = 0;
        _aeroImpulse.y = - Cl * speed2 * dt;
        _aeroImpulse.z = 0;
        chassis.applyImpulse( _aeroImpulse, true );

    }

}

// ---------------- brake lights + reverse light ----------------

function updateBrakeLights() {

    if ( ! carVisualsGroup ) return;
    const braking = input.brake > 0.05;
    const inReverse = transmission.gear === - 1;
    carVisualsGroup.traverse( ( o ) => {

        if ( ! o.userData.taillight ) return;
        // Brake boosts emissive ~2.3× over the per-car base (so muscle pops
        // harder than the hatchback).
        o.material.emissiveIntensity = o.userData.baseEmissiveIntensity * ( braking ? 2.3 : 1.0 );
        if ( o.userData.reverseLight ) {

            if ( inReverse ) {

                o.material.color.setHex( 0xFFFFFF );
                o.material.emissive.setHex( 0xFFFFFF );

            } else {

                o.material.color.setHex( o.userData.baseColor );
                o.material.emissive.setHex( o.userData.baseEmissiveColor );

            }

        }

    } );

}

// ---------------- god-car fluid RGB underglow + road light ----------------
//
// Each tagged neon mesh has its own MeshStandardMaterial with userData.godNeon
// and userData.hueOffset. The PointLight beneath the chassis is tagged with
// userData.godRoadLight. This function advances a shared hue phase and
// rewrites material.color, material.emissive, and the light colour every
// frame so the whole car flows through the rainbow. Only runs when the
// God Car is selected — other cars early-return.
let _godNeonPhase = 0;
const _godNeonTmp = new THREE.Color();
function updateGodNeon( dt ) {

    if ( ! carVisualsGroup ) return;
    if ( ! currentCar || currentCar.name !== 'God Car' ) return;

    // ~6 seconds per full rotation through the hue wheel.
    _godNeonPhase = ( _godNeonPhase + ( dt || 1 / 60 ) * 0.17 ) % 1;
    let primaryHue = _godNeonPhase;

    carVisualsGroup.traverse( ( o ) => {

        if ( o.material && o.material.userData && o.material.userData.godNeon ) {

            const h = ( primaryHue + ( o.material.userData.hueOffset || 0 ) / ( Math.PI * 2 ) + 1 ) % 1;
            _godNeonTmp.setHSL( h, 1.0, 0.55 );
            o.material.color.copy( _godNeonTmp );
            o.material.emissive.copy( _godNeonTmp );

        }
        if ( o.isLight && o.userData && o.userData.godRoadLight ) {

            _godNeonTmp.setHSL( primaryHue, 1.0, 0.55 );
            o.color.copy( _godNeonTmp );

        }

    } );

}

// ---------------- controller rumble (Web Gamepad Haptic Actuator) ----------------
//
// "Art of Rally" style calm haptics: a barely-there continuous surface
// buzz, a touch more when a tyre is sliding, short event pulses on curb
// hits / ABS / TC engagement. Magnitudes capped low — this should never
// feel like the controller is angry.
//
// The Web Gamepad API can't loop: `playEffect('dual-rumble', ...)` is
// one-shot. To fake continuous we re-issue every `reIssueMs` with a
// slightly longer `duration` so the next effect overlaps the previous.
// Magnitudes 0..1 — `weak` is the small motor (high-freq buzz), `strong`
// is the heavy motor (low-freq thump). Works in Chrome/Edge on macOS +
// Windows over USB and Bluetooth for DualSense / DualShock 4 / Xbox
// pads. Silently no-ops on Safari and on pads without `vibrationActuator`.

// Master gain headroom. The base magnitudes inside updateRumble +
// rumblePulse were tuned for a "calm" Art-of-Rally feel; the slider
// gets multiplied by this so RUM=40 reproduces that old calm baseline
// and RUM=100 gives ~2.5x stronger feedback for players who want more.
const RUMBLE_MAX_SCALE = 2.5;

const rumble = {
    // master scale 0..1 from the slider. Effective multiplier =
    // strength * RUMBLE_MAX_SCALE. 0 hard-disables.
    strength: 0.4,
    // continuous baseline (set every frame from car state)
    contWeak: 0, contStrong: 0,
    // one-shot pulse (decays to 0 when onceEndsAt is in the past)
    onceWeak: 0, onceStrong: 0, onceEndsAt: 0,
    // re-issue throttle so we don't hammer playEffect every animation tick
    lastIssued: 0, reIssueMs: 90,
    // edge tracking
    prevTcEngaged: false, prevAbsEngaged: false,
    prevSusp: [ 0, 0, 0, 0 ]
};

function rumblePulse( weak, strong, durationMs ) {

    if ( rumble.strength <= 0 ) return;
    const now = performance.now();
    const end = now + durationMs;
    // strongest pulse wins until it expires
    if ( end > rumble.onceEndsAt
        || weak > rumble.onceWeak
        || strong > rumble.onceStrong ) {

        rumble.onceWeak = weak;
        rumble.onceStrong = strong;
        rumble.onceEndsAt = end;

    }

}

function rumbleSetContinuous( weak, strong ) {

    rumble.contWeak = weak;
    rumble.contStrong = strong;

}

function rumbleTick() {

    if ( rumble.strength <= 0 || gamepad.index < 0 ) return;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads[ gamepad.index ];
    if ( ! pad || ! pad.vibrationActuator || ! pad.vibrationActuator.playEffect ) return;
    const now = performance.now();
    let oW = 0, oS = 0;
    if ( now < rumble.onceEndsAt ) { oW = rumble.onceWeak; oS = rumble.onceStrong; }
    // Master scale applied here so the slider gain affects both the
    // continuous baseline and any active one-shot pulse uniformly.
    // RUMBLE_MAX_SCALE gives slider 1.0 enough headroom over the old
    // calm baseline (which now lives at slider 0.4).
    const scale = rumble.strength * RUMBLE_MAX_SCALE;
    const weak = Math.max( oW, rumble.contWeak ) * scale;
    const strong = Math.max( oS, rumble.contStrong ) * scale;
    if ( weak < 0.01 && strong < 0.01 ) return; // silence — nothing to play
    if ( now - rumble.lastIssued < rumble.reIssueMs ) return;
    rumble.lastIssued = now;
    pad.vibrationActuator.playEffect( 'dual-rumble', {
        startDelay: 0,
        duration: 140,
        weakMagnitude: Math.min( 1, weak ),
        strongMagnitude: Math.min( 1, strong )
    } ).catch( () => {} );

}

function updateRumble( speed ) {

    if ( rumble.strength <= 0 || ! vehicleController ) return;
    // 1) Continuous surface buzz — proportional to speed, capped low. The
    //    weak motor is the small high-freq one; perfect for a "tyres on
    //    tarmac" hiss without the heavy thumping you get from a strong
    //    motor at the same magnitude.
    const speedKmh = Math.abs( speed ) * 3.6;
    let surface = 0;
    if ( speedKmh > 3 ) surface = Math.min( 0.08, speedKmh / 800 );

    // 2) Tyre slide — lateral slip angle past peak. Light continuous
    //    rumble that gets your attention without screaming.
    let slide = 0;
    for ( let i = 0; i < 4; i ++ ) {
        if ( ! vehicleController.wheelIsInContact( i ) ) continue;
        const slip = Math.abs( tires.slipAngle[ i ] );
        if ( slip > 0.18 ) {
            const mag = Math.min( 0.18, ( slip - 0.18 ) * 1.4 );
            if ( mag > slide ) slide = mag;
        }
    }
    rumbleSetContinuous( surface + slide * 0.5, slide );

    // 3) Suspension impulse spikes — kerb / pothole / hard landing.
    //    Look at the per-frame delta in wheel suspension force; sudden
    //    jumps trigger a short one-shot pulse scaled by the impulse size.
    for ( let i = 0; i < 4; i ++ ) {
        const susp = vehicleController.wheelIsInContact( i )
            ? Math.max( 0, vehicleController.wheelSuspensionForce( i ) )
            : 0;
        const prev = rumble.prevSusp[ i ];
        const delta = Math.abs( susp - prev );
        if ( delta > 6000 ) {
            const intensity = Math.min( 0.4, delta / 30000 );
            rumblePulse( intensity * 0.6, intensity, 80 );
        }
        rumble.prevSusp[ i ] = susp;
    }

    // 4) TC engage edge — weak-motor-only tick to flag the cut.
    if ( drivetrain.tc.engaged && ! rumble.prevTcEngaged ) rumblePulse( 0.15, 0, 70 );
    rumble.prevTcEngaged = drivetrain.tc.engaged;

    // 5) ABS engage edge — strong-motor-only pulse, like the real-world
    //    pedal pulsing on the foot.
    if ( drivetrain.abs.engaged && ! rumble.prevAbsEngaged ) rumblePulse( 0, 0.20, 60 );
    rumble.prevAbsEngaged = drivetrain.abs.engaged;

}

// ---------------- DualSense adaptive triggers (WebHID) ----------------
//
// Sony's DualSense exposes two voice-coil actuators inside L2 and R2 that
// can act as programmable resistance / vibration on the trigger pull.
// The standard Web Gamepad API doesn't reach them — we have to talk to
// the device directly over WebHID and write the right output report.
//
// Layout we use:
//   - Trigger control block lives at offset 11 (R2) and 22 (L2) inside the
//     "common" payload, 11 bytes each: mode byte + 10 parameter bytes.
//   - Wire-level framing differs USB vs BT:
//        USB: reportId=0x02, length=47 ( 1 flags hi + 1 flags lo + ... )
//        BT : reportId=0x31, length=78, last 4 bytes = CRC32 over
//             [0xA2, reportId, ...payload] with poly 0xEDB88320.
//   - We always set both feature-flag bits 0+1 (=0x04 + 0x08 lo-byte mask)
//     so the firmware actually applies our trigger fields and lifecycle
//     bit 0 in the high flags so the LED / lightbar state isn't touched.
//
// The protocol layer is self-contained: feature-detect navigator.hid, fail
// silent on Safari / Firefox / non-Sony pads, throttle re-writes to ~30 Hz,
// auto-disable after 3 consecutive write errors. Public surface:
//   dsTriggerOff(side)
//   dsTriggerFeedback(side, startPos, force)
//   dsTriggerWeapon(side, startPos, endPos, force)
//   dsTriggerVibration(side, startPos, frequency, amplitude)
// side is 'L2' or 'R2'. All numeric args get clamped to the spec range.
//
// References cross-checked against the community-reverse-engineered
// `ds5w` / `pydualsense` projects + Sony's own driver report layouts.

const ds = {
    device: null,            // HIDDevice when claimed, else null
    transport: 'usb',        // 'usb' | 'bt' (auto-detected from packet size)
    authorized: false,       // persisted in localStorage as 'dualsenseAuthorized'
    consecutiveErrors: 0,    // 3 strikes → disable
    disabled: false,         // hard kill after repeated write failures
    lastFlushAt: 0,          // last successful HID write timestamp
    minFlushMs: 33,          // ~30 Hz cap on outbound reports
    // BT-only: monotonic seq nibble that gets written into payload[0] high
    // nibble of every outbound report. Some firmwares (verified against
    // daidr/dualsense-tester) ignore reports whose seq doesn't advance.
    btSeq: 0,
    // Cached trigger state — when both sides match what we last sent and
    // it's within minFlushMs of the last write, we skip the HID call.
    // Each side is { mode, p: [10 bytes] }.
    pending: {
        L2: { mode: 0, p: [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ], dirty: true },
        R2: { mode: 0, p: [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ], dirty: true }
    },
    lastSent: {
        L2: { mode: 0xFF, p: [ - 1, - 1, - 1, - 1, - 1, - 1, - 1, - 1, - 1, - 1 ] },
        R2: { mode: 0xFF, p: [ - 1, - 1, - 1, - 1, - 1, - 1, - 1, - 1, - 1, - 1 ] }
    },
    // In-flight guard so a rapid double-click on the toggle button can't
    // race the picker / attach / detach lifecycle (which is fully async).
    // Without this, clicking again while a detach is awaiting close()
    // would slip into the else-branch and re-open the picker mid-tear-down.
    toggleInFlight: false,
    // Edge-tracking for the mapper.
    prevTcEngaged: false,
    tcBumpUntil: 0,           // R2 wheelspin/TC vibration end time (ms)
    absPulseUntil: 0,         // L2 ABS pulse hold end time (ms)
    // Edge timers + last-mode tracking for the racing-feel mapper below.
    revLimitUntil: 0,         // R2 rev-limiter buzz end time (ms)
    revLimitCooldownUntil: 0, // earliest time a new rev-limit buzz may fire
    prevShiftCd: 0,           // last frame's transmission.shiftCooldown
    shiftTickUntil: 0,        // R2 paddle-shift detent end time (ms)
    tcCooldownUntil: 0,       // earliest time wheelspin buzz may re-arm
    kerbHitUntil: 0,          // L2 kerb-impact bump end time (ms)
    hardLandUntil: 0,         // L2 bottom-out thump end time (ms)
    prevLatSlip: false,       // last frame's lateral-slip-active flag (raw, no brake gate)
    latSlipUntil: 0,          // R2 lateral-slide buzz end time (ms)
    latSlipCooldownUntil: 0,  // earliest time slide buzz may re-arm
    prevReverseEngaged: false,// edge-detect reverse-gear engagement
    reverseTickUntil: 0,      // R2 reverse-engaged snap end time (ms)
    prevHandbrakeOn: false,   // edge-detect handbrake at speed
    handbrakeTickUntil: 0,    // R2 handbrake-yank end time (ms)
    prevSusp: [ 0, 0, 0, 0 ]  // per-wheel suspension force last frame
};

// Sony's HID filter — covers the DualSense USB IDs we've seen in the wild.
// requestDevice() lets the user pick; the IDs just narrow the picker so the
// USB hub doesn't show every keyboard / mouse.
const DS_FILTERS = [
    { vendorId: 0x054C, productId: 0x0CE6 }, // DualSense (CFI-ZCT1W) original
    { vendorId: 0x054C, productId: 0x0DF2 }, // DualSense Edge / later firmware
    { vendorId: 0x054C }                     // anything else from Sony — fallback
];

// Sniff a connected gamepad and decide whether to surface the picker button.
// Conservative: require either "dualsense" in the id string OR the Sony
// vendor 054c hex. Avoids false positives on DualShock 4 (which doesn't
// support adaptive triggers — they're motors-only).
function _dsGamepadLooksLikeDualSense() {

    if ( gamepad.index < 0 ) return false;
    const id = ( gamepad.id || '' ).toLowerCase();
    if ( id.includes( 'dualsense' ) ) return true;
    // Sony VID often shows up as "054c" inside the id (Chrome) or as the
    // raw "vendor: 1356" decimal (Firefox-style strings). We've also seen
    // "wireless controller" on bluetooth; combine with vendor for safety.
    if ( id.includes( '054c' ) ) return true;
    if ( id.includes( 'sony' ) && id.includes( 'wireless controller' ) ) return true;
    return false;

}

// CRC32 table (poly 0xEDB88320, reflected). Required for the BT report
// trailer — the firmware drops any 78-byte report whose last 4 bytes
// don't match crc32([0xA2, ...wholeReport[0..73]]).
const _DS_CRC_TABLE = ( () => {

    const t = new Uint32Array( 256 );
    for ( let i = 0; i < 256; i ++ ) {

        let c = i;
        for ( let k = 0; k < 8; k ++ ) c = ( c & 1 ) ? ( 0xEDB88320 ^ ( c >>> 1 ) ) : ( c >>> 1 );
        t[ i ] = c >>> 0;

    }
    return t;

} )();

function _dsCrc32( bytes ) {

    let c = 0xFFFFFFFF;
    for ( let i = 0; i < bytes.length; i ++ ) {

        c = _DS_CRC_TABLE[ ( c ^ bytes[ i ] ) & 0xFF ] ^ ( c >>> 8 );

    }
    return ( c ^ 0xFFFFFFFF ) >>> 0;

}

// Equality on a side's pending state vs last-sent state — used to skip
// redundant HID writes when nothing has changed.
function _dsSideEquals( a, b ) {

    if ( a.mode !== b.mode ) return false;
    for ( let i = 0; i < 10; i ++ ) if ( a.p[ i ] !== b.p[ i ] ) return false;
    return true;

}

// Public: write a "mode + 10 params" trigger block into the pending state.
// Side-effect is deferred to the next dsFlush() — caller doesn't need to
// throttle, that's our job.
function _dsSetTrigger( side, mode, params ) {

    if ( ds.disabled ) return;
    const slot = ds.pending[ side ];
    if ( ! slot ) return;
    slot.mode = mode & 0xFF;
    for ( let i = 0; i < 10; i ++ ) slot.p[ i ] = ( params[ i ] || 0 ) & 0xFF;
    slot.dirty = true;

}

function dsTriggerOff( side ) { _dsSetTrigger( side, 0x00, [ 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] ); }

// Wipe all per-frame edge-detection state used by updateDualsense(). Called
// from the R-reset / car-swap / map-swap paths so the teleport's chaotic
// suspension/slip discontinuities don't synthesize false kerb/wheelspin/
// shift-tick events on the spawn frame, and so the 80ms mode-hold from
// a pre-reset cue doesn't suppress the next real event.
function resetDualsenseState() {

    ds.prevTcEngaged = false;
    ds.prevShiftCd = 0;
    ds.prevLatSlip = false;
    ds.prevReverseEngaged = false;
    ds.prevHandbrakeOn = false;
    ds.prevSusp[ 0 ] = 0;
    ds.prevSusp[ 1 ] = 0;
    ds.prevSusp[ 2 ] = 0;
    ds.prevSusp[ 3 ] = 0;
    ds.tcBumpUntil = 0;
    ds.tcCooldownUntil = 0;
    ds.absPulseUntil = 0;
    ds.revLimitUntil = 0;
    ds.revLimitCooldownUntil = 0;
    ds.shiftTickUntil = 0;
    ds.kerbHitUntil = 0;
    ds.hardLandUntil = 0;
    ds.latSlipUntil = 0;
    ds.latSlipCooldownUntil = 0;
    ds.reverseTickUntil = 0;
    ds.handbrakeTickUntil = 0;
    dsTriggerOff( 'L2' );
    dsTriggerOff( 'R2' );

}

// All adaptive-trigger parameters are 0..255 in the native protocol
// (verified against github.com/daidr/dualsense-tester reference).
// Earlier impl clamped to 0..9 / 0..8 which silently produced
// almost-no-force — the player felt nothing.

// Mode 0x01 — constant resistance from `startPos` to end of pull.
// params: [start, force]
function dsTriggerFeedback( side, startPos, force ) {

    const s = Math.max( 0, Math.min( 255, startPos | 0 ) );
    const f = Math.max( 0, Math.min( 255, force | 0 ) );
    _dsSetTrigger( side, 0x01, [ s, f, 0, 0, 0, 0, 0, 0, 0, 0 ] );

}

// Mode 0x02 — soft trigger / weapon: light pull until `startPos`, then
// stiffens through `endPos`, then snaps free past `endPos`.
// params: [start, end, force]
function dsTriggerWeapon( side, startPos, endPos, force ) {

    const s = Math.max( 0, Math.min( 254, startPos | 0 ) );
    const e = Math.max( s + 1, Math.min( 255, endPos | 0 ) );
    const f = Math.max( 0, Math.min( 255, force | 0 ) );
    _dsSetTrigger( side, 0x02, [ s, e, f, 0, 0, 0, 0, 0, 0, 0 ] );

}

// Mode 0x06 — vibrate at `frequency` Hz with `force` strength once the
// trigger crosses `startPos`. Frequency is in Hz (0..15-ish useful).
// params: [frequency, force, start]
function dsTriggerVibration( side, startPos, frequency, force ) {

    const s = Math.max( 0, Math.min( 255, startPos | 0 ) );
    const fr = Math.max( 0, Math.min( 15, frequency | 0 ) );
    const f = Math.max( 0, Math.min( 255, force | 0 ) );
    _dsSetTrigger( side, 0x06, [ fr, f, s, 0, 0, 0, 0, 0, 0, 0 ] );

}

// Build + push the actual HID report. Bails early on no device, no dirty
// state, or rate-limit. All transport gotchas isolated here.
async function dsFlush() {

    if ( ds.disabled || ! ds.device || ! ds.device.opened ) return;
    const now = performance.now();
    const lDirty = ds.pending.L2.dirty || ! _dsSideEquals( ds.pending.L2, ds.lastSent.L2 );
    const rDirty = ds.pending.R2.dirty || ! _dsSideEquals( ds.pending.R2, ds.lastSent.R2 );
    if ( ! lDirty && ! rDirty ) return;
    if ( now - ds.lastFlushAt < ds.minFlushMs ) return;

    // Build the 47-byte struct payload (verified against
    // daidr/dualsense-tester `src/router/DualSense/views/_OutputPanel/
    // outputStruct.ts`). Field order: validFlag0, validFlag1, rumbleR,
    // rumbleL, headphoneVol, speakerVol, micVol, audioCtrl, muteLed,
    // pwrSaveMute, R2.mode, R2.p0..p9, L2.mode, L2.p0..p9, ...reserved,
    // hapticVol, audioCtrl2, validFlag2, ...reserved, lightbarSetup,
    // ledBrightness, playerIndicator, ledRGB.
    //
    // Earlier impl set validFlag1=0x00. The reference defaults it to 0xF7
    // (= mask-out LED/mute/mic touches the firmware would otherwise apply).
    // With flag1=0 some firmware revisions reset the trigger block before
    // applying it — explaining "no resistance at all" even with perfect
    // mode bytes. We now match the reference and force-set flag1 bit 3
    // OFF only when we actually want to drive LED brightness (we never do).
    const common = new Uint8Array( 47 );
    // validFlag0 bit2 = right-trigger effect enable, bit3 = left-trigger
    // effect enable. Bits 0/1 (rumble enable) stay 0 here because
    // navigator.getGamepads().vibrationActuator owns the motors on a
    // separate code path.
    common[ 0 ] = 0x04 | 0x08;
    // validFlag1: mirror the reference's "don't touch the audio/LED stack"
    // default. 0xF7 = bits 0,1,2,4,5,6,7 set (bit3 cleared = "don't drive
    // LED brightness"). Without these enable bits the firmware ignores
    // entire blocks of the output report, including — surprise — the
    // adaptive-trigger block on some firmware versions.
    // validFlag1 was 0xF7 (the reference's UI default); that enables the
    // mic-LED, lightbar, player-indicator, etc. control fields, and
    // because we send zeros for all of them every flush the controller
    // re-applies an "all-off" LED state ~30 times per second → visible
    // lightbar flicker. 0x00 means "don't touch any of those" — the
    // controller keeps whatever LED state it had before we attached.
    common[ 1 ] = 0x00;
    // Motor magnitudes (offset 2 / 3) stay 0 — rumbleTick() handles those
    // through navigator.getGamepads().vibrationActuator on a different code path.
    // R2 block starts at offset 10 (R2 mode at 10, R2 params 11..20).
    common[ 10 ] = ds.pending.R2.mode;
    for ( let i = 0; i < 10; i ++ ) common[ 11 + i ] = ds.pending.R2.p[ i ];
    // L2 block starts at offset 21.
    common[ 21 ] = ds.pending.L2.mode;
    for ( let i = 0; i < 10; i ++ ) common[ 22 + i ] = ds.pending.L2.p[ i ];
    // Bytes 32..46 stay zero — those are LED brightness / lightbar colour
    // / player-num indicator fields that we explicitly don't touch.

    try {

        if ( ds.transport === 'bt' ) {

            // BT output report: id=0x31, total 77 bytes (NOT 78). The first
            // 2 bytes are a BT framing header — byte 0 is `seq << 4` (high
            // nibble is a monotonic sequence counter, low nibble unused),
            // byte 1 is 0x10 (=DS5 output sub-type). Bytes 2..48 hold the
            // 47-byte common struct. Bytes 49..72 stay zero (padding for
            // fields we don't touch). Bytes 73..76 are CRC32 of
            // [0xA2, 0x31, ...payload[0..72]].
            //
            // Earlier impl wrote 78 bytes with [0x02, 0x00, ...] as the
            // prefix — that's a USB-style header. The DS5 firmware silently
            // drops BT reports of the wrong length / wrong header, which is
            // exactly the symptom the user described.
            const payload = new Uint8Array( 77 );
            payload[ 0 ] = ( ds.btSeq << 4 ) & 0xFF;
            ds.btSeq = ( ds.btSeq + 1 ) & 0xFF;
            payload[ 1 ] = 0x10;
            for ( let i = 0; i < 47; i ++ ) payload[ 2 + i ] = common[ i ];
            // CRC is computed over [0xA2, 0x31, payload[0..72]] = 75 bytes.
            const seed = new Uint8Array( 2 + 73 );
            seed[ 0 ] = 0xA2;
            seed[ 1 ] = 0x31;
            for ( let i = 0; i < 73; i ++ ) seed[ 2 + i ] = payload[ i ];
            const crc = _dsCrc32( seed );
            payload[ 73 ] = crc & 0xFF;
            payload[ 74 ] = ( crc >>> 8 ) & 0xFF;
            payload[ 75 ] = ( crc >>> 16 ) & 0xFF;
            payload[ 76 ] = ( crc >>> 24 ) & 0xFF;
            await ds.device.sendReport( 0x31, payload );

        } else {

            // USB report: id=0x02, raw 47-byte common payload.
            await ds.device.sendReport( 0x02, common );

        }

        ds.lastFlushAt = now;
        ds.consecutiveErrors = 0;
        // Snapshot the just-sent state so the next flush diff has something
        // to compare against.
        for ( const side of [ 'L2', 'R2' ] ) {

            ds.lastSent[ side ].mode = ds.pending[ side ].mode;
            for ( let i = 0; i < 10; i ++ ) ds.lastSent[ side ].p[ i ] = ds.pending[ side ].p[ i ];
            ds.pending[ side ].dirty = false;

        }

    } catch ( err ) {

        ds.consecutiveErrors ++;
        if ( ds.consecutiveErrors >= 3 ) {

            ds.disabled = true;
            console.warn( '[dualsense] disabling adaptive triggers — 3 consecutive write failures' );

        }

    }

}

// Take a fresh-from-the-picker (or getDevices()) HIDDevice and wire it up.
// Detects transport from the device's reports, claims it, swaps the UI
// button to the "on" indicator.
async function _dsAttach( device ) {

    if ( ! device ) return false;
    try {

        if ( ! device.opened ) await device.open();
        ds.device = device;
        ds.disabled = false;
        ds.consecutiveErrors = 0;
        // Pick transport. BT reports include id 0x31; USB has 0x02.
        let hasBt = false, hasUsb = false;
        for ( const r of ( device.collections?.[ 0 ]?.outputReports || [] ) ) {

            if ( r.reportId === 0x31 ) hasBt = true;
            if ( r.reportId === 0x02 ) hasUsb = true;

        }
        ds.transport = hasBt && ! hasUsb ? 'bt' : 'usb';
        // Force a fresh flush by invalidating last-sent.
        for ( const side of [ 'L2', 'R2' ] ) {

            ds.lastSent[ side ].mode = 0xFF;
            ds.pending[ side ].dirty = true;

        }
        device.addEventListener( 'disconnect', _dsHandleDisconnect );
        ds.authorized = true;
        try { localStorage.setItem( 'dualsenseAuthorized', '1' ); } catch ( _ ) {}
        _dsUpdateButton();
        console.log( `[dualsense] attached via ${ ds.transport }, vendor ${ device.vendorId?.toString( 16 ) } product ${ device.productId?.toString( 16 ) }` );
        // Confirmation pulse: 600 ms of strong constant resistance on
        // both triggers so the player can verify the link is live before
        // they even hit the throttle. After 600 ms the per-frame mapper
        // takes over and the pull goes back to RPM/brake-driven.
        try {

            dsTriggerFeedback( 'R2', 80, 200 );
            dsTriggerFeedback( 'L2', 80, 200 );
            ds.lastFlushAt = 0;
            await dsFlush();
            console.log( '[dualsense] sent test pulse: R2/L2 feedback startPos 80 force 200' );

        } catch ( e ) { console.warn( '[dualsense] test pulse failed:', e?.message || e ); }
        return true;

    } catch ( err ) {

        console.warn( '[dualsense] attach failed:', err?.message || err );
        ds.device = null;
        return false;

    }

}

function _dsHandleDisconnect() {

    ds.device = null;
    ds.consecutiveErrors = 0;
    ds.disabled = false;
    _dsUpdateButton();

}

// Explicit user-triggered detach. Different from the OS-side disconnect
// path — we need to (a) tell the controller to release both triggers so
// they don't stay stuck stiff after we close the HID handle, (b) clear
// the persisted authorization flag so reloads don't silently re-claim
// the controller.
async function _dsDetach() {

    if ( ! ds.device ) { _dsUpdateButton(); return; }
    try {

        // Force-flush an OFF report for both triggers so the controller
        // doesn't keep the last resistance/vibration state after we
        // release it.
        dsTriggerOff( 'L2' );
        dsTriggerOff( 'R2' );
        ds.lastFlushAt = 0; // bypass the rate-limit
        await dsFlush();
        if ( ds.device.opened ) await ds.device.close();

    } catch ( err ) {

        console.warn( '[dualsense] detach error:', err?.message || err );

    }
    try { localStorage.removeItem( 'dualsenseAuthorized' ); } catch ( _ ) {}
    ds.device = null;
    ds.authorized = false;
    ds.disabled = false;
    ds.consecutiveErrors = 0;
    _dsUpdateButton();

}

// Permission flow: requestDevice() requires a user gesture, so we render
// a small button into #info (matching the .volume-row styling) and let
// the player opt in. After authorization we silently re-claim on every
// page load via getDevices() — Chrome remembers the grant per origin.
let _dsButtonEl = null;

function _dsUpdateButton() {

    if ( ! _dsButtonEl ) return;
    // Two states only: "adaptive triggers: on" when a device is open and
    // claimed, "adaptive triggers: off" otherwise. Always visible when the
    // browser supports WebHID — if the player has no DualSense, clicking
    // pops the picker which will show an empty list and they can dismiss.
    // (Earlier versions hid the row when no DS gamepad was polled, but
    // gamepad-index detection is flaky and the user was clicking on a
    // transiently-hidden button getting no response.)
    const on = !!( ds.device && ds.device.opened );
    _dsButtonEl.textContent = on ? 'adaptive triggers: on' : 'adaptive triggers: off';
    _dsButtonEl.style.opacity = ds.toggleInFlight ? '0.5' : '1';
    _dsButtonEl.disabled = !!ds.toggleInFlight;
    _dsButtonEl.style.display = '';
    // Adding/removing this row changes #info's height, which would
    // otherwise leave the "stats for nerds" toggle button overlapping
    // the bottom of the cheatsheet.
    if ( typeof _positionStatsBelowInfo === 'function' ) _positionStatsBelowInfo();

}

function initDualsenseButton() {

    if ( ! ( 'hid' in navigator ) ) return; // Safari / Firefox: no-op
    const infoEl = document.getElementById( 'info' );
    if ( ! infoEl ) return;

    const row = document.createElement( 'div' );
    row.className = 'volume-row desktop-only';
    row.style.justifyContent = 'flex-end';

    const btn = document.createElement( 'button' );
    btn.type = 'button';
    btn.textContent = 'adaptive triggers: off';
    btn.style.cssText = [
        'background: rgba(255,255,255,0.08)',
        'color: #FFCB47',
        'border: 1px solid rgba(255,203,71,0.35)',
        'padding: 2px 8px',
        'border-radius: 3px',
        'font: inherit',
        'font-size: 10px',
        'cursor: pointer',
        'pointer-events: auto'
    ].join( ';' );
    // Visible by default whenever WebHID is supported (we already early-return
    // in initDualsenseButton if `hid` not in navigator). Previously hidden when
    // no DS gamepad was polled, but that produced "I click and nothing happens"
    // bugs when the gamepad index transiently dropped between polls.

    btn.addEventListener( 'click', async () => {

        // In-flight guard: requestDevice / open / close are all async, and a
        // rapid double-click would race the lifecycle. If a toggle is already
        // running, ignore this click — the button is also visually disabled
        // (opacity 0.5 + disabled attribute) via _dsUpdateButton.
        if ( ds.toggleInFlight ) return;
        ds.toggleInFlight = true;
        _dsUpdateButton();
        try {

            if ( ds.device && ds.device.opened ) {

                // ON → OFF: flush triggers free, close HID, clear localStorage.
                await _dsDetach();

            } else {

                // OFF → ON: pop picker, attach the first picked device.
                const devices = await navigator.hid.requestDevice( { filters: DS_FILTERS } );
                if ( devices && devices[ 0 ] ) await _dsAttach( devices[ 0 ] );

            }

        } catch ( err ) {

            console.warn( '[dualsense] toggle failed:', err?.message || err );

        } finally {

            ds.toggleInFlight = false;
            _dsUpdateButton();

        }

    } );

    row.appendChild( btn );
    // Park the button under the RUM slider so the order in #info is
    // VOL → RUM → triggers — same column, same vibe.
    const allRows = infoEl.querySelectorAll( '.volume-row' );
    const anchor = allRows.length ? allRows[ allRows.length - 1 ] : null;
    if ( anchor && anchor.nextSibling ) infoEl.insertBefore( row, anchor.nextSibling );
    else infoEl.appendChild( row );

    if ( typeof _positionStatsBelowInfo === 'function' ) _positionStatsBelowInfo();

    _dsButtonEl = btn;
    _dsUpdateButton();

    // Re-evaluate visibility whenever a gamepad goes in / out — the
    // window-level listeners already fire renderControlsCheatsheet, we
    // piggyback off the same events for symmetry.
    window.addEventListener( 'gamepadconnected', _dsUpdateButton );
    window.addEventListener( 'gamepaddisconnected', _dsUpdateButton );

    // Silent reconnect: if we got a grant on a prior visit, Chrome will
    // return the device from getDevices() without prompting. Bail if the
    // grant is still scoped to a device that's currently unplugged.
    if ( localStorage.getItem( 'dualsenseAuthorized' ) === '1' ) {

        navigator.hid.getDevices().then( ( list ) => {

            const dev = ( list || [] ).find( d => d.vendorId === 0x054C );
            if ( dev ) _dsAttach( dev );
            else _dsUpdateButton();

        } ).catch( () => {} );

    }

    // Global disconnect listener at the navigator.hid level catches the
    // case where the user unplugs while we hold the handle but haven't
    // wired the per-device listener yet (race on initial getDevices).
    navigator.hid.addEventListener( 'disconnect', ( e ) => {

        if ( e.device === ds.device ) _dsHandleDisconnect();

    } );

}

// ---------------- DualSense effect mapper — per-car racing-pedal feel ----------------
//
// What each in-game moment maps to physically on the controller. All cues
// are EVENT-driven (no continuous cruise resistance), so both triggers are
// fully free 95% of the time and the player keeps modulation authority.
//
// Per-car personalization: every cue reads its force range / freq / startPos /
// hold-ms / cooldown-ms / detection-threshold from `currentCar.dsProfile.*`.
// A 1700 kg muscle car's ABS pulses slow + heavy; a 911's pulses fast + crisp.
// The Hatchback's plastic rev limiter buzzes at 10 Hz; the F1's screams at 15.
// See each car's `dsProfile` literal in the CARS array for the rationale.
//
// Cues (shared across cars, tuned per-car):
//   R2 — revLimit (vibration) > shiftTick (feedback) > wheelspin (vibration) > slide (vibration)
//   L2 — abs (vibration) > kerb (feedback) > brakePressure (progressive feedback)
//
// FORCE-AMPLITUDE RULE (load-bearing): forces stay subtle. Per-car forceMin/
// forceMax caps are enforced in the helper closures so no profile can blow
// past ~130 momentary / ~110 sustained. Differentiation between cars is
// expressed via freq / startPos / threshold / duration, NOT raw amplitude.
//
// All forces are also scaled by the master RUM slider; RUM=0 silences
// everything. dsFlush() handles rate-limiting + state diffing.

// Fallback profile used if currentCar.dsProfile is missing (shouldn't
// happen — every car ships one — but defensive so a typo in a car config
// can't silently brick the trigger feedback).
const DS_DEFAULT_PROFILE = {
    revLimit:      { forceMin: 90, forceMax: 130, freq: 14, startPos: 60,  holdMs: 250, cooldownMs: 400 },
    shiftTick:     { forceMin: 45, forceMax:  90, startPos: 130, holdMs: 70 },
    wheelspin:     { forceMin: 60, forceMax: 100, freq: 12, startPos: 100, holdMs: 220, cooldownMs: 700, slipThreshold: 0.35 },
    slide:         { forceMin: 35, forceMax:  70, freq:  8, startPos: 80,  holdMs: 220, cooldownMs: 900, slipThreshold: 0.40, speedKmhMin: 22 },
    abs:           { forceMin: 70, forceMax: 110, freq: 12, startPos: 25,  holdMs: 100, brakeThreshold: 0.30 },
    kerb:          { forceMin: 60, forceMax: 110, startPos: 60,  holdMs: 120, suspThreshold: 20000 },
    brakePressure: { forceMin: 25, forceMax: 100, startPos: 80,  deadzone: 0.55, ramp: 200, trailBonus: 35 },
    // Cues added after per-car profiles were authored. Cars can override
    // these later; for now every car uses the defaults via the `cue()` helper.
    reverse:       { forceMin: 60, forceMax:  90,            startPos: 50,  holdMs: 200 },
    hardLand:      { forceMin: 95, forceMax: 130,            startPos: 50,  holdMs: 200 },
    handbrake:     { forceMin: 60, forceMax:  95, freq: 10,  startPos: 80,  holdMs: 180 }
};

function updateDualsense( speed ) {

    if ( ! ds.device || ds.disabled ) return;
    if ( rumble.strength <= 0 ) {

        dsTriggerOff( 'L2' );
        dsTriggerOff( 'R2' );
        dsFlush();
        return;

    }
    const scale = Math.min( 1.5, rumble.strength * 1.5 );
    const now = performance.now();
    const prof = ( currentCar && currentCar.dsProfile ) || DS_DEFAULT_PROFILE;
    // Per-cue fallback: a car can ship without a key and inherit the default.
    // New cues (reverse / hardLand / handbrake) aren't customized per-car yet
    // so they always read from DS_DEFAULT_PROFILE in practice.
    const cue = ( name ) => prof[ name ] || DS_DEFAULT_PROFILE[ name ];

    // RUM=0 (or near-0) — short-circuit BEFORE arming any cues. If we let the
    // arming code run and then bailed out at render time, the *Until timers
    // would persist; the moment the player nudges RUM back up they'd get a
    // burst of stale cues that "happened" while muted. Clearing here keeps
    // the channel honest: silent really means silent.
    if ( scale < 0.05 ) {

        ds.tcBumpUntil = 0;
        ds.shiftTickUntil = 0;
        ds.latSlipUntil = 0;
        ds.revLimitUntil = 0;
        ds.kerbHitUntil = 0;
        ds.hardLandUntil = 0;
        ds.absPulseUntil = 0;
        ds.reverseTickUntil = 0;
        ds.handbrakeTickUntil = 0;
        dsTriggerOff( 'L2' );
        dsTriggerOff( 'R2' );
        dsFlush();
        return;

    }

    // Midpoint × master scale, clamped to per-cue [forceMin, forceMax].
    // The clamp is load-bearing: it enforces the per-car force ceiling so a
    // high RUM setting can't push forces past what the profile allows.
    const _f = ( p ) => {

        const mid = ( p.forceMin + p.forceMax ) * 0.5;
        return Math.max( p.forceMin, Math.min( p.forceMax, Math.round( mid * scale ) ) );

    };
    // Ramped force: t∈[0,1] interpolates linearly between forceMin (at t=0)
    // and forceMax (at t=1), then scaled + clamped. Used by ABS where harder
    // brake input = stronger pulse-back.
    const _fRamp = ( p, t ) => {

        const u = Math.max( 0, Math.min( 1, t ) );
        const raw = p.forceMin + ( p.forceMax - p.forceMin ) * u;
        return Math.max( p.forceMin, Math.min( p.forceMax, Math.round( raw * scale ) ) );

    };

    // -------- read game state --------
    const rpm = engine.rpm || 0;
    const redline = engine.redline || 7500;
    const brake = Math.max( 0, Math.min( 1, input.brake || 0 ) );
    const steerMag = Math.min( 1, Math.abs( input.steer || 0 ) );
    const speedKmh = Math.abs( speed ) * 3.6;

    // Driven-wheel longitudinal slip — wheelspin detector (≠ lateral slide).
    let drivenIdx = [ 0, 1, 2, 3 ];
    try { drivenIdx = drivenWheelIndices( currentCar && currentCar.driveType ); } catch ( e ) {}
    let maxDriveSlip = 0;
    for ( let k = 0; k < drivenIdx.length; k ++ ) {

        const i = drivenIdx[ k ];
        const s = Math.abs( tires.slipRatio[ i ] || 0 );
        if ( s > maxDriveSlip ) maxDriveSlip = s;

    }

    // Max lateral slip angle on any grounded wheel — chassis-slide cue.
    let maxLatSlip = 0;
    for ( let i = 0; i < 4; i ++ ) {

        if ( ! vehicleController.wheelIsInContact( i ) ) continue;
        const s = Math.abs( tires.slipAngle[ i ] || 0 );
        if ( s > maxLatSlip ) maxLatSlip = s;

    }

    // Kerb hit — sudden positive jump in any wheel's suspension load.
    // Per-car suspThreshold: F1 fires at 8 kN (22 mm of travel transmits
    // everything), Hatchback at 26 kN (soft springs absorb the small stuff).
    let kerbSpike = 0;
    for ( let i = 0; i < 4; i ++ ) {

        const inContact = vehicleController.wheelIsInContact( i );
        const susp = inContact ? Math.max( 0, vehicleController.wheelSuspensionForce( i ) ) : 0;
        const d = susp - ds.prevSusp[ i ];
        if ( d > kerbSpike ) kerbSpike = d;
        ds.prevSusp[ i ] = susp;

    }
    // Kerb hit at the profile threshold; HARD LANDING when the spike is
    // ≥2.5× the threshold (genuine bottom-out from a jump or curb-launch
    // landing). Hard-landing has its own *Until timer + L2 priority slot so
    // it punches through ambient kerb chatter and feels like an impact.
    if ( kerbSpike > prof.kerb.suspThreshold ) ds.kerbHitUntil = Math.max( ds.kerbHitUntil, now + prof.kerb.holdMs );
    if ( kerbSpike > prof.kerb.suspThreshold * 2.5 ) ds.hardLandUntil = Math.max( ds.hardLandUntil, now + cue( 'hardLand' ).holdMs );

    // Wheelspin event — TC engaged OR a driven tyre past per-car slip threshold.
    // Two arming paths so a sustained burnout doesn't go silent after holdMs:
    //   1. Rising edge with cooldown elapsed → fresh long cue
    //   2. Sustained continuous engagement → 80 ms rolling refresh keeps the
    //      buzz alive the whole time the tyres are actually scrabbling. The
    //      cooldown rule only applies to the rising edge; it exists to defeat
    //      threshold-bobbing flicker, not to silence sustained spin.
    const wheelspin = drivetrain.tc.engaged || maxDriveSlip > prof.wheelspin.slipThreshold;
    if ( wheelspin && ! ds.prevTcEngaged && now >= ds.tcCooldownUntil ) {

        ds.tcBumpUntil = now + prof.wheelspin.holdMs;
        ds.tcCooldownUntil = now + prof.wheelspin.cooldownMs;

    } else if ( wheelspin && ds.prevTcEngaged ) {

        ds.tcBumpUntil = Math.max( ds.tcBumpUntil, now + 80 );

    }
    ds.prevTcEngaged = wheelspin;

    // ABS active — hold the cue past release so it doesn't flicker as
    // ABS modulates internally. Per-car holdMs (F1 60 ms crisp, Hatchback 110 ms).
    if ( drivetrain.abs.engaged ) ds.absPulseUntil = now + prof.abs.holdMs;

    // Rev limiter — per-car buzz/hold/cooldown. Cooldown ensures holding
    // throttle at redline doesn't refire every frame.
    if ( rpm >= redline * 0.99 && now >= ds.revLimitCooldownUntil ) {

        ds.revLimitUntil = now + prof.revLimit.holdMs;
        ds.revLimitCooldownUntil = now + prof.revLimit.cooldownMs;

    }

    // Paddle-shift click — rising edge of transmission.shiftCooldown.
    const shiftCd = transmission.shiftCooldown || 0;
    if ( shiftCd > 0 && ds.prevShiftCd <= 0 ) ds.shiftTickUntil = now + prof.shiftTick.holdMs;
    ds.prevShiftCd = shiftCd;

    // Reverse-engaged snap — confirmation tactile when the player slots into
    // reverse (rising edge of input.reverseEngaged).
    if ( input.reverseEngaged && ! ds.prevReverseEngaged ) ds.reverseTickUntil = now + cue( 'reverse' ).holdMs;
    ds.prevReverseEngaged = !! input.reverseEngaged;

    // Handbrake-at-speed yank — rising edge of pulling the e-brake while
    // actually moving. Quiet at parking-lot speeds, sharp on track.
    const handbrakeActive = ( input.handbrake || 0 ) > 0.5 && speedKmh > 40;
    if ( handbrakeActive && ! ds.prevHandbrakeOn ) ds.handbrakeTickUntil = now + cue( 'handbrake' ).holdMs;
    ds.prevHandbrakeOn = handbrakeActive;

    // Lateral chassis slide — track the RAW slide state (ignoring brake) so
    // releasing brake mid-corner doesn't spuriously refire the cue. The brake
    // gate is applied only at render time (slide cue is silent while braking
    // because L2 owns those channels via ABS / pedal feel).
    const slidingNow = maxLatSlip > prof.slide.slipThreshold && speedKmh > prof.slide.speedKmhMin;
    if ( slidingNow && ! ds.prevLatSlip && now >= ds.latSlipCooldownUntil ) {

        ds.latSlipUntil = now + prof.slide.holdMs;
        ds.latSlipCooldownUntil = now + prof.slide.cooldownMs;

    } else if ( slidingNow && ds.prevLatSlip ) {

        ds.latSlipUntil = Math.max( ds.latSlipUntil, now + 80 );

    }
    ds.prevLatSlip = slidingNow;

    // ===== R2 priority chain =====
    //   rev > shift > reverse > handbrake > wheelspin > slide
    // Deliberate driver actions (shift/reverse/handbrake) sit above ambient
    // cues (wheelspin/slide) so they're never masked by ambient buzz.
    if ( now < ds.revLimitUntil ) {

        const p = prof.revLimit;
        dsTriggerVibration( 'R2', p.startPos, p.freq, _f( p ) );

    } else if ( now < ds.shiftTickUntil ) {

        const p = prof.shiftTick;
        dsTriggerFeedback( 'R2', p.startPos, _f( p ) );

    } else if ( now < ds.reverseTickUntil ) {

        const p = cue( 'reverse' );
        dsTriggerFeedback( 'R2', p.startPos, _f( p ) );

    } else if ( now < ds.handbrakeTickUntil ) {

        const p = cue( 'handbrake' );
        dsTriggerVibration( 'R2', p.startPos, p.freq, _f( p ) );

    } else if ( now < ds.tcBumpUntil ) {

        const p = prof.wheelspin;
        dsTriggerVibration( 'R2', p.startPos, p.freq, _f( p ) );

    } else if ( now < ds.latSlipUntil && brake < 0.3 ) {

        // Slide render still gates on brake-off — L2 owns those channels
        // (ABS / pedal feel) when braking. The arming side ignores brake to
        // avoid spurious refire when the player releases mid-corner.
        const p = prof.slide;
        dsTriggerVibration( 'R2', p.startPos, p.freq, _f( p ) );

    } else {

        dsTriggerOff( 'R2' );

    }

    // ===== L2 priority chain =====
    //   ABS > hardLand > kerb > brake-pressure
    // Hard-landing inserts above ambient kerb chatter so a jump-out impact
    // punches through. ABS gate intentionally dropped from the render
    // condition so light-pedal lockups (wet/ice) still produce the pedal
    // tag-back — the per-car brakeThreshold is only used to scale the ramp.
    if ( now < ds.absPulseUntil ) {

        const p = prof.abs;
        const t = Math.max( 0, ( brake - p.brakeThreshold ) / Math.max( 0.001, 1 - p.brakeThreshold ) );
        dsTriggerVibration( 'L2', p.startPos, p.freq, _fRamp( p, t ) );

    } else if ( now < ds.hardLandUntil ) {

        const p = cue( 'hardLand' );
        dsTriggerFeedback( 'L2', p.startPos, _f( p ) );

    } else if ( now < ds.kerbHitUntil ) {

        const p = prof.kerb;
        dsTriggerFeedback( 'L2', p.startPos, _f( p ) );

    } else if ( brake > prof.brakePressure.deadzone ) {

        // Progressive brake-pedal pressure: per-car deadzone + ramp slope,
        // with trail-brake bonus (steerMag × brake × trailBonus) capped at
        // trailBonus. Force clamped to per-car [forceMin, forceMax] × scale.
        const p = prof.brakePressure;
        const trailBonus = Math.min( p.trailBonus, steerMag * brake * p.trailBonus );
        const target = ( brake - p.deadzone ) * p.ramp;
        const f = Math.max( p.forceMin, Math.min( p.forceMax, Math.round( ( target + trailBonus ) * scale ) ) );
        dsTriggerFeedback( 'L2', p.startPos, f );

    } else {

        dsTriggerOff( 'L2' );

    }

    dsFlush();

}

// ---------------- skid marks ----------------

const SKID_MAX = 800;
let skidMesh = null;
let skidIndex = 0;
const _skidDummy = new THREE.Object3D();
const _skidQuat = new THREE.Quaternion();
const _skidEuler = new THREE.Euler();
const _skidZeroMatrix = new THREE.Matrix4().makeScale( 0, 0, 0 );

function initSkidMarks() {

    // Single InstancedMesh = 1 draw call for up to 800 marks. PlaneGeometry
    // rotated to lie flat in XZ so its normal is +Y (faces up).
    const geom = new THREE.PlaneGeometry( 0.4, 0.55 );
    geom.rotateX( - Math.PI / 2 );
    const mat = new THREE.MeshBasicMaterial( {
        color: 0x111111, transparent: true, opacity: 0.6,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: - 2
    } );
    skidMesh = new THREE.InstancedMesh( geom, mat, SKID_MAX );
    skidMesh.frustumCulled = false;
    skidMesh.castShadow = false;
    skidMesh.receiveShadow = false;
    for ( let i = 0; i < SKID_MAX; i ++ ) skidMesh.setMatrixAt( i, _skidZeroMatrix );
    skidMesh.instanceMatrix.needsUpdate = true;
    scene.add( skidMesh );

}

function placeSkidMark( cp, headingY ) {

    _skidDummy.position.set( cp.x, cp.y + 0.025, cp.z );
    _skidDummy.rotation.set( 0, headingY, 0 );
    _skidDummy.updateMatrix();
    skidMesh.setMatrixAt( skidIndex, _skidDummy.matrix );
    skidIndex = ( skidIndex + 1 ) % SKID_MAX;

}

function updateSkidMarks() {

    if ( ! vehicleController || ! skidMesh || ! chassis ) return;
    const speed = Math.abs( vehicleController.currentVehicleSpeed() );
    if ( speed < 2 ) return; // no marks when crawling / parked

    const r = chassis.rotation();
    _skidQuat.set( r.x, r.y, r.z, r.w );
    _skidEuler.setFromQuaternion( _skidQuat, 'YXZ' );

    const handbraking = input.handbrake > 0.1;
    let dirty = false;

    // Rear wheels = indices 2 and 3. Hard lateral slip OR locked handbrake
    // both leave marks. Lateral slip threshold 3.0 is tuned to "started
    // drifting".
    for ( const wi of [ 2, 3 ] ) {

        if ( ! vehicleController.wheelIsInContact( wi ) ) continue;
        const side = Math.abs( vehicleController.wheelSideImpulse( wi ) );
        if ( side < 3.0 && ! handbraking ) continue;
        const cp = vehicleController.wheelContactPoint( wi );
        placeSkidMark( cp, _skidEuler.y );
        dirty = true;

    }

    if ( dirty ) skidMesh.instanceMatrix.needsUpdate = true;

}

function clearSkidMarks() {

    if ( ! skidMesh ) return;
    for ( let i = 0; i < SKID_MAX; i ++ ) skidMesh.setMatrixAt( i, _skidZeroMatrix );
    skidMesh.instanceMatrix.needsUpdate = true;
    skidIndex = 0;

}

// ---------------- tire model (heat + wear) ----------------

const tires = {
    // Surface temp is what the grip curve reads. Carcass is the slow reservoir.
    // Pressure rises with carcass temp. Wear is monotonic-decreasing.
    // `heat` is kept as an alias for surface so the existing tile widget keeps working.
    heat:        [ 25, 25, 25, 25 ],
    carcass:     [ 25, 25, 25, 25 ],
    pressure:    [ 200, 200, 200, 200 ], // kPa cold baseline (matches TIRE_P_COLD declared below)
    wear:        [ 1.0, 1.0, 1.0, 1.0 ],
    slipRatio:   [ 0, 0, 0, 0 ],         // longitudinal slip (live telemetry)
    slipAngle:   [ 0, 0, 0, 0 ],         // lateral slip in rad (live telemetry)
    gripMult:    [ 1, 1, 1, 1 ],         // last Pacejka multiplier (telemetry)
    prevWheelRot:[ 0, 0, 0, 0 ]          // for finite-difference angular velocity
};

// Two-layer tyre thermal model + tyre pressure (Gay-Lussac) + Pacejka-flavoured
// slip-grip curve. Surface temp drives grip + cools fast; carcass temp is the
// bulk reservoir + slowly couples to surface via conduction. Pressure rises with
// carcass temp and modulates contact-patch grip via a Gaussian around the cold-
// optimum.
const TIRE_AMBIENT       = 25;
const TIRE_OPTIMAL_HEAT  = 90;     // surface temp peak (slightly raised from 80 — modern compounds)
const TIRE_HEAT_SIGMA_SQ = 900;
const TIRE_ROLL_GAIN     = 0.020;  // °C/s into carcass per (load_kN × m/s)
const TIRE_SLIP_GAIN     = 0.85;   // °C/s into SURFACE per slip-unit
const TIRE_FWD_SLIP_FAC  = 0.5;
const TIRE_SURF_CARC_K   = 0.35;   // surface↔carcass conduction (per second)
const TIRE_SURF_COOL_K   = 0.045;  // surface→air convection
const TIRE_CARC_COOL_K   = 0.008;  // carcass→air (insulated, slow)
const TIRE_COOL_VSCALE   = 28;     // m/s where forced cooling doubles
const TIRE_AIR_COOL_K    = 0.05;   // airborne cooling
const TIRE_LOAD_REF      = 1000;   // N
const TIRE_HEAT_MIN      = 15;
const TIRE_HEAT_MAX      = 160;
const TIRE_WEAR_RATE     = 0.0015;

// Pressure model
const TIRE_P_COLD        = 200;    // kPa baseline
const TIRE_P_COLD_T      = 25;     // °C
const TIRE_P_OPTIMAL     = 230;    // kPa for peak grip
const TIRE_P_SIGMA_SQ    = 800;
const TIRE_P_GAIN        = 0.78;   // kPa per °C above cold
const TIRE_P_GRIP_WEIGHT = 0.25;   // how much pressure deviation eats grip

// Slip / Pacejka — we compute slipRatio (longitudinal) and slipAngle (lateral)
// per wheel from chassis velocity + wheel angular velocity, then run them
// through a smooth peak-and-drop curve. Below peak: full grip. Past peak:
// grip drops linearly to a floor — so the player CAN lose grip by over-driving
// (sim feel) but a stationary car never goes below baseline (no slide-on-the-spot).
const PAC_PEAK_SLIP      = 0.14;   // ~14 % slip ratio = grip peak (typical road tyre)
const PAC_PEAK_ANGLE     = 0.18;   // ~10° slip angle = lateral peak (was 0.12 / 7° — too early)
const PAC_FALLOFF        = 0.6;    // gentler past-peak falloff (was 1.3 — cliff)
const PAC_GRIP_FLOOR     = 0.78;   // never less than 78 % grip even at full slide (was 0.55)
const PAC_SLIP_RATIO_CAP = 2.0;    // saturation for snowy/locked wheels

// Inverse-quaternion world→chassis-local vector (so we can decompose chassis
// linear velocity into forward / lateral components).
function _worldToLocalVec( v, q, out ) {

    const x = v.x, y = v.y, z = v.z;
    const qx = - q.x, qy = - q.y, qz = - q.z, qw = q.w;
    const ix =  qw * x + qy * z - qz * y;
    const iy =  qw * y + qz * x - qx * z;
    const iz =  qw * z + qx * y - qy * x;
    const iw = - qx * x - qy * y - qz * z;
    out.x = ix * qw + iw * - qx + iy * - qz - iz * - qy;
    out.y = iy * qw + iw * - qy + iz * - qx - ix * - qz;
    out.z = iz * qw + iw * - qz + ix * - qy - iy * - qx;
    return out;

}
const _carLocalVel = { x: 0, y: 0, z: 0 };

function updateTires( dt ) {

    if ( ! vehicleController || ! chassis ) return;

    const vSpeed = Math.abs( vehicleController.currentVehicleSpeed() );
    const linvel = chassis.linvel();
    const r = chassis.rotation();
    _worldToLocalVec( linvel, r, _carLocalVel );
    // In chassis-local: +Z = back, -Z = forward. Our convention uses -Z forward,
    // so vLong = -localV.z gives signed forward speed (positive when moving
    // forward).
    const vLong = - _carLocalVel.z;
    const vLat  = _carLocalVel.x;
    const driven = drivenWheelIndices( currentCar.driveType );

    for ( let i = 0; i < 4; i ++ ) {

        let Tsurf = tires.heat[ i ];
        let Tcarc = tires.carcass[ i ];
        const airV = vSpeed;
        const conv = 1 + airV / TIRE_COOL_VSCALE;

        if ( ! vehicleController.wheelIsInContact( i ) ) {

            // Airborne — fast cooling of surface toward ambient. Carcass cools
            // more slowly but also forced by airflow.
            Tsurf += - TIRE_AIR_COOL_K * conv * ( Tsurf - TIRE_AMBIENT ) * dt;
            Tcarc += - TIRE_CARC_COOL_K * conv * ( Tcarc - TIRE_AMBIENT ) * dt;
            tires.heat[ i ] = Math.max( TIRE_HEAT_MIN, Math.min( TIRE_HEAT_MAX, Tsurf ) );
            tires.carcass[ i ] = Math.max( TIRE_HEAT_MIN, Math.min( TIRE_HEAT_MAX, Tcarc ) );
            tires.slipRatio[ i ] = 0;
            tires.slipAngle[ i ] = 0;
            tires.gripMult[ i ] = 1;
            continue;

        }

        const load = Math.max( 0, vehicleController.wheelSuspensionForce( i ) ) / TIRE_LOAD_REF;
        const sideI = Math.abs( vehicleController.wheelSideImpulse( i ) );
        const fwdI  = Math.abs( vehicleController.wheelForwardImpulse( i ) );

        // Slip ratio (longitudinal): difference between wheel-rim speed and
        // contact-patch ground speed, normalised.
        //
        // IMPORTANT: we do NOT use `wheelRotation` here. Rapier's wheelRotation
        // is the integral of its internal solver-decided angular velocity, which
        // depends on the very friction value we feed back via setWheelFrictionSlip.
        // That creates a feedback loop: low friction → Rapier holds ω low → we
        // see vWheel ≈ 0 → kappa = -1 → pacFactor → 0.55 → friction lower next
        // frame. Symptom: cruising cars showed slip ratio of -1 on all wheels.
        //
        // Instead derive vWheel kinematically from the drivetrain:
        //   driven wheel: ω = engineOmega / gearMult
        //   non-driven  : ω = vLong / WHEEL_RADIUS (free-rolling)
        // Driven set depends on the per-car driveType (FWD/RWD/AWD).
        const isDriven = driven.indexOf( i ) >= 0;
        const ratio = gearRatio( transmission.gear );
        const engineOmegaRad = engine.rpm * Math.PI / 30; // RPM → rad/s
        let vWheel;
        if ( isDriven && ratio !== 0 && transmission.shiftCooldown <= 0 ) {

            const gearMult = Math.abs( ratio ) * currentCar.finalDrive;
            const idealOmega = engineOmegaRad / gearMult * Math.sign( ratio );
            vWheel = idealOmega * WHEEL_RADIUS;

        } else {

            vWheel = vLong; // free-rolling matches ground

        }
        const denom = Math.max( Math.abs( vLong ), 0.5 );
        let kappa = ( vWheel - vLong ) / denom;
        if ( kappa > PAC_SLIP_RATIO_CAP ) kappa = PAC_SLIP_RATIO_CAP;
        if ( kappa < - PAC_SLIP_RATIO_CAP ) kappa = - PAC_SLIP_RATIO_CAP;

        // Slip angle (lateral): atan2(vLat, |vLong|). Only meaningful above
        // very low speeds — at standstill it's noise.
        let alpha = 0;
        if ( vSpeed > 0.5 ) alpha = Math.atan2( vLat, Math.abs( vLong ) + 0.5 );
        if ( alpha > Math.PI / 2 ) alpha = Math.PI / 2;
        if ( alpha < - Math.PI / 2 ) alpha = - Math.PI / 2;

        tires.slipRatio[ i ] = kappa;
        tires.slipAngle[ i ] = alpha;

        // Combined slip magnitude. We deliberately use ONLY the lateral
        // (slip-angle) component for the Pacejka falloff. Slip ratio is kept
        // for telemetry but doesn't feed grip back: our model derives engine
        // RPM kinematically from wheel speed, so slip ratio can't physically
        // detect wheel-spin without a real engine flywheel — which we don't
        // have. The lateral term is a genuine physical signal (chassis side-
        // slip relative to heading), so cornering-limit drift still works.
        const latRatio = Math.abs( alpha ) / PAC_PEAK_ANGLE;
        const slipMag = latRatio;

        // Pacejka-flavoured grip multiplier: full grip below peak, drops past
        // it, floored so we never lose all grip and slide off the road parked.
        let pacFactor;
        if ( slipMag < 1.0 ) {

            pacFactor = 1.0;

        } else {

            pacFactor = Math.max( PAC_GRIP_FLOOR, 1.0 - ( slipMag - 1.0 ) * PAC_FALLOFF );

        }

        // Thermal: surface heats from slip-impulse (already a proxy for slip
        // power); carcass heats from rolling deformation. They couple by
        // conduction, both cool to ambient.
        const slip = sideI + TIRE_FWD_SLIP_FAC * fwdI;
        const qSurfIn = TIRE_SLIP_GAIN * slip;
        const qRollIn = TIRE_ROLL_GAIN * load * vSpeed;
        const cond = TIRE_SURF_CARC_K * ( Tsurf - Tcarc );
        const qSurfOut = TIRE_SURF_COOL_K * conv * ( Tsurf - TIRE_AMBIENT );
        const qCarcOut = TIRE_CARC_COOL_K * conv * ( Tcarc - TIRE_AMBIENT );
        Tsurf += ( qSurfIn - cond - qSurfOut ) * dt;
        Tcarc += ( qRollIn + cond - qCarcOut ) * dt;
        if ( Tsurf < TIRE_HEAT_MIN ) Tsurf = TIRE_HEAT_MIN;
        if ( Tsurf > TIRE_HEAT_MAX ) Tsurf = TIRE_HEAT_MAX;
        if ( Tcarc < TIRE_HEAT_MIN ) Tcarc = TIRE_HEAT_MIN;
        if ( Tcarc > TIRE_HEAT_MAX ) Tcarc = TIRE_HEAT_MAX;
        tires.heat[ i ] = Tsurf;
        tires.carcass[ i ] = Tcarc;

        // Pressure: Gay-Lussac on carcass temp. Hotter = more pressure.
        tires.pressure[ i ] = TIRE_P_COLD + TIRE_P_GAIN * ( Tcarc - TIRE_P_COLD_T );

        // Wear: slip-only, never recovers, accelerated past 110°C surface.
        const wearRate = slip * TIRE_WEAR_RATE
            + 0.0008 * Math.max( 0, Tsurf - 110 );
        tires.wear[ i ] = Math.max( 0.2, tires.wear[ i ] - wearRate * dt );

        // Final grip = base × Pacejka × surfaceTemp × pressure × wear
        const heatDelta = Tsurf - TIRE_OPTIMAL_HEAT;
        const heatFactor = Math.exp( - heatDelta * heatDelta / TIRE_HEAT_SIGMA_SQ );
        const pDelta = tires.pressure[ i ] - TIRE_P_OPTIMAL;
        const pressFactor = ( 1 - TIRE_P_GRIP_WEIGHT ) + TIRE_P_GRIP_WEIGHT * Math.exp( - pDelta * pDelta / TIRE_P_SIGMA_SQ );

        // Cold tyres still have usable mechanical grip — only the *peak* falls
        // off when off-temperature. Floor raised from 0.4 → 0.7 so a fresh
        // spawn doesn't slide off a slope before the player gets to drive.
        const totalMult = pacFactor
            * ( 0.7 + 0.3 * heatFactor )
            * pressFactor
            * ( 0.5 + 0.5 * tires.wear[ i ] );
        tires.gripMult[ i ] = totalMult;

        const grip = currentCar.wheelFrictionSlip * totalMult;
        vehicleController.setWheelFrictionSlip( i, grip );

    }

}

function resetTires() {

    for ( let i = 0; i < 4; i ++ ) {

        tires.heat[ i ] = TIRE_AMBIENT;
        tires.carcass[ i ] = TIRE_AMBIENT;
        tires.pressure[ i ] = TIRE_P_COLD;
        tires.wear[ i ] = 1.0;
        tires.slipRatio[ i ] = 0;
        tires.slipAngle[ i ] = 0;
        tires.gripMult[ i ] = 1;
        // Seed from current wheel rotation so the next-frame finite-difference
        // doesn't manufacture a fake huge omega from a 0-to-N angle jump.
        tires.prevWheelRot[ i ] = vehicleController ? ( vehicleController.wheelRotation( i ) || 0 ) : 0;

    }

}

// ---------------- minimap (bottom-left, top-down birds-eye) ----------------

function initMinimap() {

    // Bottom-left container: semi-transparent dark frame + rounded corners,
    // matches the other overlay styling.
    const wrap = document.createElement( 'div' );
    wrap.style.cssText = [
        'position:absolute', 'bottom:200px', 'left:10px',
        'width:200px', 'height:200px',
        'background:rgba(0,0,0,0.55)', 'border:1px solid rgba(255,255,255,0.22)',
        'border-radius:8px', 'overflow:hidden', 'z-index:3',
        'display:none', 'pointer-events:none',
        'box-shadow:0 4px 16px rgba(0,0,0,0.4)'
    ].join( ';' );
    document.body.appendChild( wrap );
    minimap.containerEl = wrap;

    const canvas = document.createElement( 'canvas' );
    canvas.width = Math.floor( 200 * window.devicePixelRatio );
    canvas.height = Math.floor( 200 * window.devicePixelRatio );
    canvas.style.cssText = 'width:200px;height:200px;display:block';
    wrap.appendChild( canvas );
    minimap.canvas = canvas;

    // Tiny center-of-minimap dot for the car position (DOM, so it's crisp).
    const dot = document.createElement( 'div' );
    dot.style.cssText = [
        'position:absolute', 'top:50%', 'left:50%', 'transform:translate(-50%,-50%)',
        'width:0', 'height:0',
        'border-left:6px solid transparent', 'border-right:6px solid transparent',
        'border-bottom:10px solid #FFCB47', 'pointer-events:none'
    ].join( ';' );
    wrap.appendChild( dot );

    // Dedicated WebGL renderer for the minimap canvas. Antialiasing off and
    // shadow map disabled — minimap doesn't need them and we keep the cost low.
    const r = new THREE.WebGLRenderer( { canvas, alpha: true, antialias: false } );
    r.setPixelRatio( window.devicePixelRatio );
    r.setSize( 200, 200, false );
    r.setClearColor( 0x000000, 0 );
    r.shadowMap.enabled = false;
    minimap.renderer = r;

    // Orthographic top-down camera. half-size 250 = shows a 500m × 500m area
    // around the car. far 1000 covers the height drop on the Nürburgring.
    const half = 250;
    minimap.camera = new THREE.OrthographicCamera( - half, half, half, - half, 1, 1000 );
    // Drive-up — camera.up is rotated each frame to the car's heading so the
    // car always faces "up" on the map.
    minimap.camera.up.set( 0, 0, - 1 );

    // Toggle entry lives inside the keybind cheatsheet (#info) so it doesn't
    // need its own button. Only this single <p> has pointer-events / cursor,
    // the rest of the cheatsheet stays passive.
    const infoEl = document.getElementById( 'info' );
    if ( infoEl ) {

        const line = document.createElement( 'p' );
        line.textContent = 'minimap · off';
        line.style.cssText = 'pointer-events:auto;cursor:pointer';
        line.addEventListener( 'click', toggleMinimap );
        line.addEventListener( 'mouseenter', () => { line.style.color = '#FFCB47'; } );
        line.addEventListener( 'mouseleave', () => { line.style.color = ''; } );
        infoEl.appendChild( line );
        minimap.toggleBtn = line;

    }

}

function toggleMinimap() {

    minimap.enabled = ! minimap.enabled;
    if ( minimap.containerEl ) minimap.containerEl.style.display = minimap.enabled ? 'block' : 'none';
    if ( minimap.toggleBtn ) minimap.toggleBtn.textContent = 'minimap · ' + ( minimap.enabled ? 'on' : 'off' );

}

// Add a coloured dot inside the minimap frame for a remote peer. The dot
// is positioned each frame in renderMinimap() — here we just create the
// DOM node and parent it to the minimap container. Hex color is the
// already-hashed deterministic per-peer color so a friend looks the same
// on the minimap as their ghost car in the world.
function _addMinimapDot( peerId ) {

    if ( ! minimap.containerEl || minimap.peerDots.has( peerId ) ) return;
    const dot = document.createElement( 'div' );
    const colorHex = '#' + ( _colorForPeer( peerId ).toString( 16 ).padStart( 6, '0' ) );
    // Smaller than the local triangle, plain circle so it doesn't compete
    // visually with "you are here". Hidden until the first snap arrives —
    // renderMinimap toggles display each frame.
    dot.style.cssText = [
        'position:absolute', 'top:0', 'left:0',
        'width:8px', 'height:8px',
        'margin:-4px 0 0 -4px',
        'border-radius:50%',
        'background:' + colorHex,
        'border:1px solid rgba(0,0,0,0.6)',
        'box-shadow:0 0 4px rgba(0,0,0,0.5)',
        'pointer-events:none',
        'display:none'
    ].join( ';' );
    minimap.containerEl.appendChild( dot );
    minimap.peerDots.set( peerId, { el: dot, color: colorHex } );

}

function _removeMinimapDot( peerId ) {

    const entry = minimap.peerDots.get( peerId );
    if ( ! entry ) return;
    if ( entry.el && entry.el.parentNode ) entry.el.parentNode.removeChild( entry.el );
    minimap.peerDots.delete( peerId );

}

const _miniForward = new THREE.Vector3();
const _miniQuat = new THREE.Quaternion();

function renderMinimap() {

    if ( ! minimap.enabled || ! car || ! chassis ) return;

    // Camera position: high above the car so the ortho frustum covers a wide
    // ground area without geometry clipping at the near plane.
    minimap.camera.position.set( car.position.x, car.position.y + 500, car.position.z );

    // Drive-up: rotate camera.up to the car's planar forward heading. Project
    // to XZ plane so pitch/roll don't tilt the minimap.
    const r = chassis.rotation();
    _miniQuat.set( r.x, r.y, r.z, r.w );
    _miniForward.set( 0, 0, - 1 ).applyQuaternion( _miniQuat );
    _miniForward.y = 0;
    if ( _miniForward.lengthSq() < 1e-4 ) _miniForward.set( 0, 0, - 1 );
    _miniForward.normalize();
    minimap.camera.up.copy( _miniForward );
    minimap.camera.lookAt( car.position );

    // Temporarily strip the HDR background so the minimap is transparent
    // outside the track geometry — lets the dark panel behind show through.
    const bg = scene.background;
    scene.background = null;
    minimap.renderer.render( scene, minimap.camera );
    scene.background = bg;

    // Per-peer dots. We do this in DOM (not in the 3D scene) so they stay
    // crisp at any zoom and we can clamp to the edge of the minimap when
    // the peer is beyond the visible 500m × 500m window.
    _updateMinimapPeerDots();

}

// Project each remote car's world position into minimap-canvas pixels
// using the same orthographic basis the minimap camera uses, then place
// its DOM dot at that point. Off-screen dots clamp to the edge so distant
// peers are still locatable.
function _updateMinimapPeerDots() {

    if ( minimap.peerDots.size === 0 ) return;
    if ( ! car ) return;

    // ortho frustum = ±250 m, canvas = 200 × 200 px (centred)
    const HALF_METRES = 250;
    const HALF_PX = 100;
    const PAD = 6;          // keep edge-clamped dots fully visible inside the frame
    const MIN_PX = PAD;
    const MAX_PX = 2 * HALF_PX - PAD;
    const M_TO_PX = HALF_PX / HALF_METRES;

    // The minimap camera was already oriented in renderMinimap() above; reuse
    // _miniForward (its planar XZ forward) to derive the screen basis.
    const fx = _miniForward.x;
    const fz = _miniForward.z;
    // Three.js camera local axes with up=(fx,0,fz), view_dir=(0,-1,0):
    //   right = up × (-view_dir) = (fx,0,fz) × (0,1,0) = (-fz, 0, fx)
    // screen_x_metres = world_offset · camera_right, screen_y_metres = world_offset · camera_up.
    const rx = - fz;
    const rz = fx;

    const carX = car.position.x;
    const carZ = car.position.z;

    for ( const [ peerId, entry ] of minimap.peerDots ) {

        const rc = multiplayer.remotes.get( peerId );
        // Hide if peer's visual hasn't received any snaps yet, or if the
        // RemoteCar instance is gone (cleanup race) — we keep the dot
        // element around so we don't churn DOM, just set display:none.
        if ( ! rc || ! rc.group || ! rc.group.visible ) {

            if ( entry.el.style.display !== 'none' ) entry.el.style.display = 'none';
            continue;

        }

        const dx = rc.group.position.x - carX;
        const dz = rc.group.position.z - carZ;
        // Screen-right metres = offset · camera_right; screen-up metres = offset · camera_up.
        const sRight = dx * rx + dz * rz;
        const sUp = dx * fx + dz * fz;

        // Decide whether this peer is inside the visible window.
        const offscreen = ( Math.abs( sRight ) > HALF_METRES || Math.abs( sUp ) > HALF_METRES );

        let px = HALF_PX + sRight * M_TO_PX;
        let py = HALF_PX - sUp * M_TO_PX;   // DOM Y is inverted

        if ( offscreen ) {

            // Edge-clamp via uniform scale to the dominant axis so the dot
            // sits on the rectangular boundary in the actual direction of
            // the peer rather than getting smeared into a corner.
            const ax = Math.abs( sRight );
            const az = Math.abs( sUp );
            const scale = HALF_METRES / Math.max( ax, az );
            const cRight = sRight * scale;
            const cUp = sUp * scale;
            px = HALF_PX + cRight * M_TO_PX;
            py = HALF_PX - cUp * M_TO_PX;

        }

        // Clamp inside the frame so the ±4px dot doesn't poke past the border.
        if ( px < MIN_PX ) px = MIN_PX;
        else if ( px > MAX_PX ) px = MAX_PX;
        if ( py < MIN_PX ) py = MIN_PX;
        else if ( py > MAX_PX ) py = MAX_PX;

        // Visual cue for off-screen peers — slightly transparent so it's
        // obvious the dot is "stuck to the edge" rather than at that exact
        // map location.
        const wantOpacity = offscreen ? '0.6' : '1';
        if ( entry.el.style.opacity !== wantOpacity ) entry.el.style.opacity = wantOpacity;

        if ( entry.el.style.display !== 'block' ) entry.el.style.display = 'block';
        // transform is cheaper to update than left/top (no layout) — but
        // we need top/left as the anchor; transform translates from there.
        entry.el.style.transform = `translate(${ px }px, ${ py }px)`;

    }

}

// ---------------- lap timer ----------------
//
// Single-row pill at bottom-left (above the FPS bar) showing the running lap
// time. Click to drop UP a panel of past laps + average. Past laps persist in
// localStorage, keyed per map (lapTimes_v1_<mapId>).
//
// IMPORTANT: the timer only ARMS on a real user input — keyboard, gamepad, or
// touch — because the chassis can roll on its own under gravity on inclines
// and we don't want a phantom lap starting then. Once armed, it runs
// continuously until completeLap() is called (which records the split and
// restarts), or until the player presses R (which re-arms it from zero).
//
// To finish a lap you need a start/finish line check. That part is map-
// specific so I left it to you — see the END of this file for the hook
// (completeLap is exposed on window so you can also test from devtools).

const LAP_STORAGE_PREFIX = 'lapTimes_v1_';

function _fmtLap( ms ) {

    if ( ! isFinite( ms ) || ms < 0 ) return '—';
    const m = Math.floor( ms / 60000 );
    const s = Math.floor( ( ms % 60000 ) / 1000 );
    const cs = Math.floor( ( ms % 1000 ) / 10 );
    return `${ m }:${ String( s ).padStart( 2, '0' ) }.${ String( cs ).padStart( 2, '0' ) }`;

}

function initLapTimer() {

    lapTimer = {
        armed: false,    // true once a real input has been seen
        running: false,  // ticking
        startTime: 0,    // performance.now() reference
        elapsed: 0,
        laps: [],        // [{ time, ts }] — newest pushed at end
        expanded: false,
        // DOM
        root: null, bar: null, timeEl: null, arrowEl: null,
        panel: null, listEl: null, statsEl: null
    };

    // Anchor + drop-up host. Positioned right above the FPS pill (which is
    // at bottom:10px with ~24px height + a small gap).
    const root = document.createElement( 'div' );
    root.style.cssText = [
        'position:absolute', 'bottom:46px', 'left:10px',
        'z-index:2', 'font:12px Monospace', 'color:#fff',
        'user-select:none'
    ].join( ';' );

    // Collapsed bar — single small timeline: "LAP · 0:00.00 · ▲"
    const bar = document.createElement( 'div' );
    bar.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:4px 10px', 'background:rgba(0,0,0,0.55)',
        'border-radius:4px', 'cursor:pointer'
    ].join( ';' );

    const labelEl = document.createElement( 'span' );
    labelEl.textContent = 'LAP';
    labelEl.style.cssText = 'opacity:0.6;letter-spacing:1px';

    const timeEl = document.createElement( 'span' );
    timeEl.textContent = '0:00.00';
    timeEl.style.cssText = 'color:#FFCB47;font-weight:bold;min-width:64px;text-align:left';

    const arrowEl = document.createElement( 'span' );
    arrowEl.textContent = '▲';
    arrowEl.style.cssText = 'margin-left:4px;opacity:0.6;font-size:10px';

    bar.append( labelEl, timeEl, arrowEl );

    // Drop-up panel — grows upward over the minimap area.
    const panel = document.createElement( 'div' );
    panel.style.cssText = [
        'display:none', 'position:absolute',
        'bottom:100%', 'left:0', 'margin-bottom:4px',
        'min-width:200px', 'padding:6px 10px',
        'background:rgba(0,0,0,0.78)',
        'border:1px solid rgba(255,255,255,0.15)',
        'border-radius:4px', 'font-size:11px',
        'max-height:240px', 'overflow-y:auto',
        'box-shadow:0 4px 12px rgba(0,0,0,0.5)'
    ].join( ';' );

    // Header: best / count / avg + clear button.
    const statsEl = document.createElement( 'div' );
    statsEl.style.cssText = [
        'display:flex', 'justify-content:space-between', 'align-items:center',
        'gap:8px', 'margin-bottom:4px', 'padding-bottom:4px',
        'border-bottom:1px solid rgba(255,255,255,0.12)'
    ].join( ';' );

    const clearBtn = document.createElement( 'span' );
    clearBtn.textContent = 'clear';
    clearBtn.style.cssText = 'cursor:pointer;opacity:0.55;font-size:10px;flex-shrink:0';
    clearBtn.addEventListener( 'mouseenter', () => { clearBtn.style.opacity = '1'; } );
    clearBtn.addEventListener( 'mouseleave', () => { clearBtn.style.opacity = '0.55'; } );
    clearBtn.addEventListener( 'click', ( e ) => { e.stopPropagation(); _lapTimerClearAll(); } );

    const listEl = document.createElement( 'div' );

    panel.append( statsEl, listEl );

    bar.addEventListener( 'click', () => _lapTimerToggleExpanded() );

    root.append( panel, bar );
    document.body.appendChild( root );

    lapTimer.root = root;
    lapTimer.bar = bar;
    lapTimer.timeEl = timeEl;
    lapTimer.arrowEl = arrowEl;
    lapTimer.panel = panel;
    lapTimer.listEl = listEl;
    lapTimer.statsEl = statsEl;
    lapTimer.clearBtn = clearBtn;

    _lapTimerLoadForMap();
    _lapTimerRefreshPanel();

    // Expose so you can call from anywhere (or test from devtools).
    window.completeLap = completeLap;
    window.lapTimer = lapTimer;

}

function _lapTimerStorageKey() { return LAP_STORAGE_PREFIX + currentMapId; }

function _lapTimerLoadForMap() {

    try {

        const raw = localStorage.getItem( _lapTimerStorageKey() );
        lapTimer.laps = raw ? JSON.parse( raw ) : [];
        if ( ! Array.isArray( lapTimer.laps ) ) lapTimer.laps = [];

    } catch {

        lapTimer.laps = [];

    }

    // Each map change = fresh, disarmed timer.
    lapTimer.running = false;
    lapTimer.armed = false;
    lapTimer.elapsed = 0;
    lapTimer.startTime = 0;
    _resetLapAccumulators();
    if ( lapTimer.timeEl ) lapTimer.timeEl.textContent = '0:00.00';
    _updateLapFinishForward();

}

function _lapTimerSave() {

    try {

        localStorage.setItem( _lapTimerStorageKey(), JSON.stringify( lapTimer.laps ) );

    } catch {}

}

function _lapTimerClearAll() {

    lapTimer.laps = [];
    _lapTimerSave();
    _lapTimerRefreshPanel();

}

function _lapTimerToggleExpanded() {

    lapTimer.expanded = ! lapTimer.expanded;
    lapTimer.panel.style.display = lapTimer.expanded ? 'block' : 'none';
    lapTimer.arrowEl.textContent = lapTimer.expanded ? '▼' : '▲';

}

function _lapTimerRefreshPanel() {

    const laps = lapTimer.laps;
    const best = laps.length ? Math.min( ...laps.map( l => l.time ) ) : null;
    const avg = laps.length ? laps.reduce( ( s, l ) => s + l.time, 0 ) / laps.length : null;

    // Stats row inside the panel.
    lapTimer.statsEl.innerHTML = '';
    const left = document.createElement( 'span' );
    left.innerHTML =
        `<span style="opacity:0.55">best </span><span style="color:#5DD68F">${ best != null ? _fmtLap( best ) : '—' }</span>` +
        `  <span style="opacity:0.4">·</span>  ` +
        `<span style="opacity:0.55">avg </span>${ avg != null ? _fmtLap( avg ) : '—' }` +
        `  <span style="opacity:0.4">·</span>  ` +
        `<span style="opacity:0.55">${ laps.length } lap${ laps.length === 1 ? '' : 's' }</span>`;
    lapTimer.statsEl.append( left, lapTimer.clearBtn );

    // List — newest first.
    lapTimer.listEl.innerHTML = '';
    if ( laps.length === 0 ) {

        const empty = document.createElement( 'div' );
        empty.textContent = 'no laps yet';
        empty.style.cssText = 'opacity:0.45;font-style:italic;padding:4px 0';
        lapTimer.listEl.appendChild( empty );

    } else {

        for ( let i = laps.length - 1; i >= 0; i -- ) {

            const lap = laps[ i ];
            const row = document.createElement( 'div' );
            row.style.cssText = 'display:flex;justify-content:space-between;padding:2px 0';
            const num = document.createElement( 'span' );
            num.textContent = `#${ i + 1 }`;
            num.style.opacity = '0.45';
            const t = document.createElement( 'span' );
            t.textContent = _fmtLap( lap.time );
            if ( lap.time === best ) t.style.color = '#5DD68F';
            row.append( num, t );
            lapTimer.listEl.appendChild( row );

        }

    }

}

// Finish line = a horizontal plane through spawnPoint, perpendicular to the
// car's spawn-forward heading. We treat each frame as a sign-flip test on
// the signed along-track distance + a lateral tolerance so we only count
// crossings near the actual spawn marker (not the infinite plane extension).
//
// Several gates layered on top so accidental + cheese crossings don't count:
//
//   1. directional (prev < 0 → curr ≥ 0): only forward crossings register.
//      A U-turn-and-drive-back approach has prev > 0 throughout, never fires.
//
//   2. lateral < FINISH_LATERAL_TOL: only crossings near the spawn marker
//      count — the line is a segment, not an infinite plane.
//
//   3. maxForward ≥ FINISH_MIN_MAX_FWD: car has to actually get DOWN the
//      track. A short forward-then-reverse trick fails this.
//
//   4. minForward ≤ FINISH_MIN_MIN_FWD (negative): the car had to come back
//      AROUND from the other side. Loitering near the line / hopping across
//      via reverse never goes far enough negative.
//
//   5. travelled path length ≥ FINISH_MIN_TRAVEL: integral of |Δpos|. Catches
//      drift-near-spawn loops that somehow pass the others.
//
//   6. teleport guard: if a single frame's Δsigned is huge, treat it as a
//      respawn / out-of-bounds snap and skip the crossing test that frame.
//
// No minimum lap time. Cruise at 10 km/h if you want — the position gates
// already make a sub-30s lap physically impossible to drive anyway.
const _lapFinishForward = new THREE.Vector3();
const _lapFinishQuat = new THREE.Quaternion();
const FINISH_LATERAL_TOL = 30;        // m
const FINISH_MIN_MAX_FWD = 500;       // m — must have driven this far past start
const FINISH_MIN_MIN_FWD = - 200;     // m — must have come back from this far behind
const FINISH_MIN_TRAVEL = 1500;       // m — path length
const FINISH_MAX_TELEPORT = 50;       // m per frame — bigger = treat as a snap

function _updateLapFinishForward() {

    _lapFinishQuat.copy( spawnQuaternion );
    _lapFinishForward.set( 0, 0, - 1 ).applyQuaternion( _lapFinishQuat );
    _lapFinishForward.y = 0;
    if ( _lapFinishForward.lengthSq() < 1e-4 ) _lapFinishForward.set( 0, 0, - 1 );
    _lapFinishForward.normalize();

}

function _resetLapAccumulators() {

    if ( ! lapTimer ) return;
    lapTimer.maxSignedDist = 0;
    lapTimer.minSignedDist = 0;
    lapTimer.travelled = 0;
    lapTimer.prevChassisPos = null;
    lapTimer.prevSignedDist = undefined;

}

function _checkFinishLineCross() {

    if ( ! lapTimer || ! lapTimer.running || ! chassis ) return;

    const t = chassis.translation();
    const dx = t.x - spawnPoint.x;
    const dz = t.z - spawnPoint.z;

    const fx = _lapFinishForward.x;
    const fz = _lapFinishForward.z;

    // along-track (signed) and cross-track (unsigned) distances to the line.
    const signed = dx * fx + dz * fz;
    const lateral = Math.abs( dx * ( - fz ) + dz * fx );

    // Per-frame path length — clipped against teleport-size steps so that
    // a fall-and-respawn doesn't inflate the travel budget.
    if ( lapTimer.prevChassisPos ) {

        const sx = t.x - lapTimer.prevChassisPos.x;
        const sy = t.y - lapTimer.prevChassisPos.y;
        const sz = t.z - lapTimer.prevChassisPos.z;
        const step = Math.sqrt( sx * sx + sy * sy + sz * sz );
        if ( step < FINISH_MAX_TELEPORT ) lapTimer.travelled += step;

    } else {

        lapTimer.prevChassisPos = { x: 0, y: 0, z: 0 };

    }

    lapTimer.prevChassisPos.x = t.x;
    lapTimer.prevChassisPos.y = t.y;
    lapTimer.prevChassisPos.z = t.z;

    // Extremes of along-track signed distance over the lap so far.
    if ( signed > lapTimer.maxSignedDist ) lapTimer.maxSignedDist = signed;
    if ( signed < lapTimer.minSignedDist ) lapTimer.minSignedDist = signed;

    const prev = lapTimer.prevSignedDist;

    // Teleport guard: a big jump in signed (R reset, off-map snap) is not a
    // physical crossing. Re-anchor prev and bail this frame.
    if ( prev !== undefined && Math.abs( signed - prev ) > FINISH_MAX_TELEPORT ) {

        lapTimer.prevSignedDist = signed;
        return;

    }

    const isForwardCrossing = prev !== undefined && prev < 0 && signed >= 0;
    const nearLine = lateral < FINISH_LATERAL_TOL;
    const wentFarEnough = lapTimer.maxSignedDist >= FINISH_MIN_MAX_FWD;
    const cameFromBehind = lapTimer.minSignedDist <= FINISH_MIN_MIN_FWD;
    const travelledEnough = lapTimer.travelled >= FINISH_MIN_TRAVEL;

    if ( isForwardCrossing && nearLine &&
         wentFarEnough && cameFromBehind && travelledEnough ) {

        completeLap();

    }

    lapTimer.prevSignedDist = signed;

}

// Returns true if ANY meaningful input has been seen this frame.
// Used to gate the lap timer from starting under pure rolling motion.
function _anyInputActive() {

    if ( input.keyW || input.keyS || input.keyA || input.keyD || input.keyE ||
         input.arrowUp || input.arrowDown || input.arrowLeft || input.arrowRight ||
         input.keySpace ) return true;

    if ( touch.enabled && ( touch.throttle > 0.05 || touch.brake > 0.05 ||
         Math.abs( touch.steer ) > 0.05 || touch.handbrake > 0.05 ) ) return true;

    // Gamepad — any button down or any axis past the deadzone.
    if ( gamepad.index >= 0 ) {

        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        const pad = pads[ gamepad.index ];
        if ( pad ) {

            for ( let i = 0; i < pad.buttons.length; i ++ ) {

                if ( pad.buttons[ i ] && pad.buttons[ i ].pressed ) return true;

            }

            for ( let i = 0; i < pad.axes.length; i ++ ) {

                if ( Math.abs( pad.axes[ i ] ) > 0.2 ) return true;

            }

        }

    }

    return false;

}

function updateLapTimer() {

    if ( ! lapTimer ) return;

    // Arm on first real input. The chassis can creep on inclines under
    // gravity alone — we don't want that to start a phantom lap.
    if ( ! lapTimer.armed && _anyInputActive() ) {

        lapTimer.armed = true;
        lapTimer.running = true;
        lapTimer.startTime = performance.now();
        lapTimer.elapsed = 0;
        _resetLapAccumulators();

    }

    if ( lapTimer.running ) {

        lapTimer.elapsed = performance.now() - lapTimer.startTime;
        lapTimer.timeEl.textContent = _fmtLap( lapTimer.elapsed );
        _checkFinishLineCross();

    }

}

// Call this when the player crosses the start/finish line.
// Records the split, persists, refreshes the drop-up, restarts the clock
// from zero for the next lap. No-op if the timer hasn't been armed yet.
function completeLap() {

    if ( ! lapTimer || ! lapTimer.running ) return;
    const ms = performance.now() - lapTimer.startTime;
    if ( ms < 1000 ) return; // guard against double-triggering on the same line
    lapTimer.laps.push( { time: ms, ts: Date.now() } );
    _lapTimerSave();
    _lapTimerRefreshPanel();
    lapTimer.startTime = performance.now();
    lapTimer.elapsed = 0;
    _resetLapAccumulators();
    _onLocalLapCompleteForRace();

}

// Called from the R-reset path so the next lap starts fresh and re-armed.
function lapTimerResetCurrent() {

    if ( ! lapTimer ) return;
    lapTimer.running = false;
    lapTimer.armed = false;
    lapTimer.elapsed = 0;
    lapTimer.startTime = 0;
    _resetLapAccumulators();
    if ( lapTimer.timeEl ) lapTimer.timeEl.textContent = '0:00.00';

}

// ---------------- multiplayer ----------------
//
// Peer-to-peer via Trystero/nostr. No backend; works on GitHub Pages.
// Each peer owns its own physics; we broadcast position/rotation/velocity
// every ~50ms. Remote peers are rendered as translucent ghost cars —
// they pass through your chassis (no shared physics).
//
// UI lives bottom-left, above the lap pill. Two buttons by default:
//   [ make room ]  [ join room ]
// "make room" generates a 5-char code and shows it + waiting count.
// "join room" reveals an inline input. Anyone with the code joins.
//
// Race lifecycle:
//   lobby     — players in the room, no clock running
//   countdown — anyone clicks "start race"; 3-2-1 then everyone races
//   racing    — lap timer + finish-line detection are already armed
//   finished  — first peer to broadcast { type: 'finished' } wins
// Winner is announced via the existing car-toast plumbing.

const SNAP_INTERVAL_MS = 50;        // 20 Hz position broadcasts
const INTERP_DELAY_MS = 100;        // render remote cars 100ms in the past
const SPAWN_SLOT_OFFSET_M = 3;      // metres between adjacent spawn slots
const COUNTDOWN_MS = 3000;          // pre-race countdown
const MAX_BUFFERED_SNAPS = 30;

const multiplayer = {
    room: null,
    isHost: false,
    joinTime: 0,
    playerName: '',
    raceState: 'lobby',    // 'lobby' | 'ready_check' | 'countdown' | 'racing' | 'finished'
    raceStartAt: 0,        // ms (Date.now()) when racing actually begins
    raceWinner: null,      // peerId or 'self'
    raceWinnerName: '',
    remotes: new Map(),    // peerId -> RemoteCar
    metaByPeer: new Map(), // peerId -> { name, carIdx }
    readyMap: new Map(),   // peerId or 'self' -> { ready, carIdx }
    localReady: false,
    lastSnapAt: 0,
    // UI
    rootEl: null,
    primaryRow: null,
    joinForm: null,
    roomPanel: null,
    countdownEl: null
};

function _isCarLocked() {

    if ( ! multiplayer.room ) return false;
    const s = multiplayer.raceState;
    if ( s === 'countdown' || s === 'racing' ) return true;
    if ( s === 'ready_check' && multiplayer.localReady ) return true;
    return false;

}

// Solid cars during race-active states; ghost cars during lobby /
// finished so people can cruise around without bumping each other.
function _isCollidableRaceState() {

    const s = multiplayer.raceState;
    return s === 'ready_check' || s === 'countdown' || s === 'racing';

}

function _applyRaceModeToRemotes() {

    const on = _isCollidableRaceState();
    for ( const rc of multiplayer.remotes.values() ) rc.setCollidable( on );

}

function _localPlayerName() {

    let n = localStorage.getItem( 'playerName' );
    if ( ! n ) {

        n = 'P' + Math.floor( Math.random() * 9000 + 1000 );
        try { localStorage.setItem( 'playerName', n ); } catch {}

    }
    return n;

}

// Room codes are 5 chars of CODE_CHARS — the same charset net.js uses.
// We tolerate any case in the URL but uppercase when used.
const _ROOM_CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/i;

// Look in the URL for a room code in this order: last path segment, then
// ?room=, then #. Returns the code (upper-cased) or null. This lets a
// share link like https://host/path/AB12X auto-join the room AB12X.
function _parseAutoJoinCode() {

    const segs = location.pathname.split( '/' ).filter( Boolean );
    const last = segs[ segs.length - 1 ];
    if ( last && _ROOM_CODE_RE.test( last ) ) return last.toUpperCase();

    const q = new URLSearchParams( location.search ).get( 'room' );
    if ( q && _ROOM_CODE_RE.test( q ) ) return q.toUpperCase();

    const h = location.hash.replace( /^#/, '' );
    if ( h && _ROOM_CODE_RE.test( h ) ) return h.toUpperCase();

    return null;

}

// Build the share URL for a room code by replacing the last path segment
// of the current location with the code. Examples:
//   /            + AB12X  ->  /AB12X
//   /foo/        + AB12X  ->  /foo/AB12X
//   /foo/AB12X   + 99WWW  ->  /foo/99WWW   (existing code swapped)
function _shareUrl( code ) {

    let base = location.origin + location.pathname;
    // Strip trailing slash, then strip any trailing existing code, then add /code
    base = base.replace( /\/+$/, '' );
    base = base.replace( /\/[A-HJ-NP-Z2-9]{5}$/i, '' );
    return base + '/' + code;

}

// Push the room code into the URL bar so refresh / share / copy works.
// null clears it back to the base path.
function _setUrlForRoom( code ) {

    let path = location.pathname.replace( /\/+$/, '' ).replace( /\/[A-HJ-NP-Z2-9]{5}$/i, '' );
    if ( code ) path += '/' + code;
    if ( path === '' ) path = '/';
    history.replaceState( null, '', path + location.search + location.hash );

}

// Try to auto-join the URL's room code, but only once the chassis and the
// multiplayer UI exist (initMultiplayer runs BEFORE initPhysics). Poll for
// ~2s before giving up.
function _tryAutoJoinFromUrl() {

    const code = _parseAutoJoinCode();
    if ( ! code ) return;

    let tries = 0;
    const attempt = () => {

        tries ++;
        if ( chassis && multiplayer.rootEl && ! multiplayer.room ) {

            _joinRoom( code );
            return;

        }
        if ( tries < 30 && ! multiplayer.room ) setTimeout( attempt, 100 );

    };
    attempt();

}

// Build a recognisable ghost-car visual without dragging in the physics
// pipeline. Box body sized like the chassis collider + 4 cylinder wheels
// + a name sprite floating overhead. Coloured by the remote's chosen car.
class RemoteCar {

    constructor( peerId, meta ) {

        this.peerId = peerId;
        this.carIdx = meta && Number.isInteger( meta.carIdx ) ? meta.carIdx : 0;
        this.name = ( meta && meta.name ) || peerId.slice( 0, 6 );
        this.snaps = [];                  // [{ time, pos, rot, vel }]
        this.group = new THREE.Group();
        this._buildVisual();
        // Match the per-map car-visual scale so remote players look the same
        // size as the local player (Spa / Suzuka run carScale 1.5×).
        const ms = ( MAPS[ currentMapId ] && MAPS[ currentMapId ].carScale ) || 1;
        this.group.scale.setScalar( ms );
        scene.add( this.group );

    }

    _buildVisual() {

        // Use a hashed-per-peer color, NOT the remote's chosen car color.
        // Lets you visually tell friends apart at a glance regardless of
        // which car they actually picked.
        const color = _colorForPeer( this.peerId );

        const bodyMat = new THREE.MeshLambertMaterial( {
            color,
            transparent: true,
            opacity: 0.6,
            depthWrite: false
        } );
        const body = new THREE.Mesh( new THREE.BoxGeometry( 2, 1, 4 ), bodyMat );
        body.position.y = 0;
        this.group.add( body );
        this.bodyMat = bodyMat;

        // Subtle "roof" so direction is readable at a glance.
        const roofMat = new THREE.MeshLambertMaterial( {
            color: 0x111111,
            transparent: true,
            opacity: 0.5,
            depthWrite: false
        } );
        const roof = new THREE.Mesh( new THREE.BoxGeometry( 1.6, 0.6, 2 ), roofMat );
        roof.position.set( 0, 0.7, - 0.2 );
        this.group.add( roof );
        this.roofMat = roofMat;

        const wheelMat = new THREE.MeshLambertMaterial( {
            color: 0x080808,
            transparent: true,
            opacity: 0.7,
            depthWrite: false
        } );
        this.wheelMat = wheelMat;
        this.wheels = [];
        const wheelDX = 1.0, wheelDY = - 0.5, wheelDZ = 1.4;
        const wheelPositions = [
            [ - wheelDX, wheelDY, - wheelDZ ],
            [   wheelDX, wheelDY, - wheelDZ ],
            [ - wheelDX, wheelDY,   wheelDZ ],
            [   wheelDX, wheelDY,   wheelDZ ]
        ];
        for ( const p of wheelPositions ) {

            const w = new THREE.Mesh(
                new THREE.CylinderGeometry( 0.35, 0.35, 0.35, 16 ),
                wheelMat
            );
            w.rotation.z = Math.PI / 2;
            w.position.set( p[ 0 ], p[ 1 ], p[ 2 ] );
            this.group.add( w );
            this.wheels.push( w );

        }

        this._refreshNameSprite();

        // Hidden until the first snapshot arrives. Without this the group
        // sits at (0,0,0) — below the Nordschleife terrain — and you see
        // nothing until the first interpolated frame lands.
        this.group.visible = false;

        // Kinematic Rapier body shaped like the chassis collider. Disabled
        // by default (ghost cars), turned on when race state goes
        // ready_check / countdown / racing so our chassis can bounce off
        // remote cars. Asymmetric — they don't feel our hits locally
        // because each peer owns its own physics; the bounce is purely
        // visual on each side.
        this._buildPhysics();
        this._collidable = false;

    }

    _buildPhysics() {

        if ( ! physics || ! physics.RAPIER || ! physics.world ) return;
        const RAPIER = physics.RAPIER;
        const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased();
        bodyDesc.setTranslation( 0, - 10000, 0 ); // park far below world until first snap
        this.body = physics.world.createRigidBody( bodyDesc );
        // Match the visual scale (carScale per map). Without this, Spa/Suzuka
        // render remotes 1.5× but their collider stays 1× — the visual mesh
        // visually overlaps deeply before physics reports contact, and the
        // resulting penetration recovery launches the local car.
        const s = ( MAPS[ currentMapId ] && MAPS[ currentMapId ].carScale ) || 1;
        // chassis box is 2 × 1 × 4 (full extents) → half-extents 1 / 0.5 / 2
        const colliderDesc = RAPIER.ColliderDesc.cuboid( 1 * s, 0.5 * s, 2 * s );
        // High friction + zero restitution = cars scrape and rub; they do
        // NOT bounce off each other. Restitution 0 here is critical because
        // the local chassis is created with restitution ≈ 1 (see CARS[i].
        // chassisFriction being passed as restitution to addMesh) — Rapier
        // uses the MAX of the two materials, so leaving this at default
        // would amplify any contact into a launch.
        colliderDesc.setFriction( 0.8 );
        colliderDesc.setRestitution( 0.0 );
        this.collider = physics.world.createCollider( colliderDesc, this.body );
        this.collider.setEnabled( false );
        this._colliderScale = s;
        // Remember last commanded pose so we can detect huge jumps in
        // update() and skip the velocity-synthesising kinematic API.
        this._lastKinPos = null;

    }

    // Rebuilds the collider at the current map's carScale. Called from
    // swapMap so the box stays sized to the visual mesh after a map swap.
    rebuildPhysicsForMap() {

        if ( ! physics || ! physics.RAPIER || ! physics.world || ! this.body ) return;
        const s = ( MAPS[ currentMapId ] && MAPS[ currentMapId ].carScale ) || 1;
        if ( s === this._colliderScale ) return;
        const RAPIER = physics.RAPIER;
        // Use our own ghost/solid flag rather than collider.isEnabled() —
        // some Rapier builds don't expose isEnabled as a method on the
        // collider, but _collidable is set by setCollidable so it's the
        // canonical truth.
        const wasEnabled = !! this._collidable;
        if ( this.collider ) physics.world.removeCollider( this.collider, true );
        const colliderDesc = RAPIER.ColliderDesc.cuboid( 1 * s, 0.5 * s, 2 * s );
        colliderDesc.setFriction( 0.8 );
        colliderDesc.setRestitution( 0.0 );
        this.collider = physics.world.createCollider( colliderDesc, this.body );
        this.collider.setEnabled( wasEnabled );
        this._colliderScale = s;
        this._lastKinPos = null;

    }

    setCollidable( on ) {

        on = !! on;
        if ( this._collidable === on ) return;
        this._collidable = on;
        if ( this.collider ) this.collider.setEnabled( on );

        // Visual swap: opaque + writes depth when solid, translucent + no
        // depth write when ghost. The name sprite uses depthTest:false and
        // stays unchanged.
        const opacity = on ? 1.0 : 0.6;
        for ( const o of [ this.bodyMat, this.roofMat, this.wheelMat ] ) {

            if ( ! o ) continue;
            o.transparent = ! on;
            o.opacity = opacity;
            o.depthWrite = on;
            o.needsUpdate = true;

        }

    }

    _refreshNameSprite() {

        const carName = ( CARS[ this.carIdx ] || {} ).name || '';
        const tag = carName ? this.name + ' · ' + carName : this.name;
        if ( this.nameSprite ) {

            this.group.remove( this.nameSprite );
            if ( this.nameSprite.material ) {

                if ( this.nameSprite.material.map ) this.nameSprite.material.map.dispose();
                this.nameSprite.material.dispose();

            }

        }
        this.nameSprite = _makeNameSprite( tag );
        this.nameSprite.position.set( 0, 2.4, 0 );
        this.group.add( this.nameSprite );

    }

    setMeta( meta ) {

        if ( ! meta ) return;
        // Track carIdx for the ready-list UI but do NOT update the body
        // color — peer color is fixed per session by _colorForPeer.
        const prevCarIdx = this.carIdx;
        const carChanged = Number.isInteger( meta.carIdx ) && meta.carIdx !== prevCarIdx;
        if ( Number.isInteger( meta.carIdx ) ) this.carIdx = meta.carIdx;
        const nameChanged = meta.name && meta.name !== this.name;
        if ( nameChanged ) this.name = meta.name;

        if ( nameChanged || carChanged ) this._refreshNameSprite();

        // Live toast when a peer swaps cars mid-session — skip the very
        // first meta (no prior car to compare against). Reuses the car-
        // cycle toast so it looks consistent with your own swaps.
        if ( carChanged && Number.isInteger( prevCarIdx ) && CARS[ this.carIdx ] ) {

            if ( typeof showCarToast === 'function' ) {

                showCarToast( this.name + ' → ' + CARS[ this.carIdx ].name );

            }

        }

    }

    pushSnap( snap ) {

        const entry = {
            time: performance.now(),
            pos: snap.pos,
            rot: snap.rot,
            vel: snap.vel || [ 0, 0, 0 ]
        };
        this.snaps.push( entry );
        if ( this.snaps.length > MAX_BUFFERED_SNAPS ) this.snaps.shift();
        // First snap = peer is now visually placeable on the track.
        if ( ! this.group.visible ) {

            this._apply( entry );
            this.group.visible = true;

        }

    }

    // Snapshot interpolation: pick the two snaps straddling renderTime and
    // lerp/slerp between them. If renderTime is past the latest snap we
    // hold position (no extrapolation — feels better during lag spikes).
    update( renderTime, dt ) {

        const n = this.snaps.length;
        if ( n === 0 ) return;
        if ( n === 1 ) {

            this._apply( this.snaps[ 0 ], 1 );
            return;

        }

        let s0 = this.snaps[ 0 ];
        let s1 = this.snaps[ n - 1 ];
        for ( let i = 0; i < n - 1; i ++ ) {

            if ( this.snaps[ i ].time <= renderTime && this.snaps[ i + 1 ].time >= renderTime ) {

                s0 = this.snaps[ i ];
                s1 = this.snaps[ i + 1 ];
                break;

            }

        }

        const span = s1.time - s0.time;
        const t = span > 0 ? Math.max( 0, Math.min( 1, ( renderTime - s0.time ) / span ) ) : 0;

        this.group.position.set(
            s0.pos[ 0 ] + ( s1.pos[ 0 ] - s0.pos[ 0 ] ) * t,
            s0.pos[ 1 ] + ( s1.pos[ 1 ] - s0.pos[ 1 ] ) * t,
            s0.pos[ 2 ] + ( s1.pos[ 2 ] - s0.pos[ 2 ] ) * t
        );

        _qA.set( s0.rot[ 0 ], s0.rot[ 1 ], s0.rot[ 2 ], s0.rot[ 3 ] );
        _qB.set( s1.rot[ 0 ], s1.rot[ 1 ], s1.rot[ 2 ], s1.rot[ 3 ] );
        _qA.slerp( _qB, t );
        this.group.quaternion.copy( _qA );

        // Spin wheels from velocity so they don't look frozen.
        const v = s1.vel;
        const speed = Math.sqrt( v[ 0 ] * v[ 0 ] + v[ 2 ] * v[ 2 ] );
        const angularDelta = ( speed / 0.35 ) * dt;
        for ( const w of this.wheels ) w.rotation.x -= angularDelta;

        // When solid, drive the kinematic body to the rendered pose so the
        // local chassis can collide with it.
        if ( this.body && this._collidable && this.group.visible ) {

            const p = this.group.position;
            const q = this.group.quaternion;

            // setNextKinematicTranslation synthesises a per-step velocity
            // as (newPos - oldPos) / dt and slams that into anything it
            // hits. A 50 ms snap gap with a 50 m/s car = ~2.5 m jump,
            // which manifests as a 150 m/s phantom velocity that launches
            // our dynamic chassis into the skybox. If the jump exceeds
            // a sane threshold we teleport with setTranslation instead,
            // which doesn't compute a velocity — the collider effectively
            // appears at the new pose without smashing through us.
            // 2 m/frame ≈ 120 m/s @ 60 fps, comfortably above any real
            // speed the cars hit on these tracks.
            const MAX_KIN_DELTA = 2;
            const last = this._lastKinPos;
            const jumped = ! last || (
                Math.abs( p.x - last.x ) > MAX_KIN_DELTA ||
                Math.abs( p.y - last.y ) > MAX_KIN_DELTA ||
                Math.abs( p.z - last.z ) > MAX_KIN_DELTA
            );

            if ( jumped ) {

                this.body.setTranslation( { x: p.x, y: p.y, z: p.z }, true );
                this.body.setRotation( { x: q.x, y: q.y, z: q.z, w: q.w }, true );

            } else {

                this.body.setNextKinematicTranslation( { x: p.x, y: p.y, z: p.z } );
                this.body.setNextKinematicRotation( { x: q.x, y: q.y, z: q.z, w: q.w } );

            }

            if ( ! this._lastKinPos ) this._lastKinPos = { x: 0, y: 0, z: 0 };
            this._lastKinPos.x = p.x;
            this._lastKinPos.y = p.y;
            this._lastKinPos.z = p.z;

        } else if ( this._lastKinPos ) {

            // Reset tracking when collider is off so the next enable doesn't
            // see a stale "huge jump" from where we were before going ghost.
            this._lastKinPos = null;

        }

    }

    _apply( snap ) {

        this.group.position.set( snap.pos[ 0 ], snap.pos[ 1 ], snap.pos[ 2 ] );
        this.group.quaternion.set( snap.rot[ 0 ], snap.rot[ 1 ], snap.rot[ 2 ], snap.rot[ 3 ] );

    }

    destroy() {

        scene.remove( this.group );
        this.group.traverse( ( o ) => {

            if ( o.geometry ) o.geometry.dispose();
            if ( o.material ) {

                if ( o.material.map ) o.material.map.dispose();
                o.material.dispose();

            }

        } );
        if ( this.body && physics && physics.world ) {

            physics.world.removeRigidBody( this.body );
            this.body = null;
            this.collider = null;

        }

    }

}

const _qA = new THREE.Quaternion();
const _qB = new THREE.Quaternion();

// Deterministic vivid color per peer. We hash the peerId so the same
// friend always shows up the same color for you within a session (the
// color is local to your client, though — they see you with a different
// random color in their game). HSL with high saturation + medium lightness
// keeps colors distinguishable against the asphalt and the sky.
function _colorForPeer( peerId ) {

    let h = 0;
    for ( let i = 0; i < peerId.length; i ++ ) {

        h = ( ( h << 5 ) - h + peerId.charCodeAt( i ) ) | 0;

    }
    const hue = ( ( h >>> 0 ) % 360 ) / 360;
    const c = new THREE.Color();
    c.setHSL( hue, 0.85, 0.55 );
    return c.getHex();

}

function _makeNameSprite( name ) {

    const canvas = document.createElement( 'canvas' );
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext( '2d' );
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect( 0, 0, canvas.width, canvas.height );
    ctx.font = 'bold 32px Monospace';
    ctx.fillStyle = '#FFCB47';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText( name, canvas.width / 2, canvas.height / 2 );
    const tex = new THREE.CanvasTexture( canvas );
    const mat = new THREE.SpriteMaterial( { map: tex, depthTest: false } );
    const sprite = new THREE.Sprite( mat );
    sprite.scale.set( 4, 1, 1 );
    sprite.renderOrder = 999;
    return sprite;

}

// Spawn slot = where you land in the start grid. Slot 0 sits at
// spawnPoint; each subsequent slot shifts the local car one car-width
// to the right (perpendicular to spawn-forward, ground plane). With the
// deterministic sorted-ID slot system, ANY peer can land at slot 0 —
// it goes to whoever's selfId sorts alphabetically first. So we apply
// even slot=0 (a teleport-to-spawn) for symmetry; without it, a peer
// who recomputes from non-zero back to 0 wouldn't actually move.
function _applySpawnSlot( slot ) {

    if ( ! chassis || slot < 0 ) return;

    // Right vector = forward rotated 90° clockwise in the XZ plane.
    const fwdX = _lapFinishForward.x;
    const fwdZ = _lapFinishForward.z;
    const rightX = - fwdZ;
    const rightZ = fwdX;

    const offset = slot * SPAWN_SLOT_OFFSET_M;
    const x = spawnPoint.x + rightX * offset;
    const y = spawnPoint.y;
    const z = spawnPoint.z + rightZ * offset;

    chassis.setTranslation( new physics.RAPIER.Vector3( x, y, z ), true );
    chassis.setRotation( new physics.RAPIER.Quaternion( spawnQuaternion.x, spawnQuaternion.y, spawnQuaternion.z, spawnQuaternion.w ), true );
    chassis.setLinvel( new physics.RAPIER.Vector3( 0, 0, 0 ), true );
    chassis.setAngvel( new physics.RAPIER.Vector3( 0, 0, 0 ), true );
    chaseCam.initialized = false;
    input.handbrakeAfterReset = true;
    lapTimerResetCurrent();

}

// Deterministic spawn-slot assignment without any cross-peer coordination.
// Every client sorts the set { selfId, ...peerIds } alphabetically and
// finds its own index — that index is the same on every machine, so two
// peers can never claim the same slot even if they joined within the
// same tick. The original peer-count-based approach raced on join order
// and could collapse two joiners onto identical slots.
function _computeLocalSlot() {

    if ( ! multiplayer.room ) return 0;
    const selfId = multiplayer.room.selfId;
    if ( ! selfId ) return 0;
    const ids = multiplayer.room.peers().slice();
    ids.push( selfId );
    ids.sort();
    const idx = ids.indexOf( selfId );
    return idx < 0 ? 0 : idx;

}

// Only safe to teleport the local car during pre-race states — moving
// someone mid-race would feel awful and break their physics state.
// Lobby + ready_check are the windows where spawn re-shuffles are OK.
function _reapplyLocalSlotIfSafe() {

    if ( ! multiplayer.room ) return;
    const s = multiplayer.raceState;
    if ( s !== 'lobby' && s !== 'ready_check' ) return;
    _applySpawnSlot( _computeLocalSlot() );

}

function _hookRoomCallbacks( room ) {

    room.on( 'peerJoin', ( peerId ) => {

        // Pre-create a RemoteCar with no visuals-by-meta yet; meta will arrive
        // moments later and update it. Without this, the first few snaps
        // would arrive before we have a car to apply them to.
        if ( ! multiplayer.remotes.has( peerId ) ) {

            const rc = new RemoteCar( peerId, multiplayer.metaByPeer.get( peerId ) );
            rc.setCollidable( _isCollidableRaceState() );
            multiplayer.remotes.set( peerId, rc );

        }
        _renderMultiplayerUI();
        // Re-shuffle the local spawn slot deterministically every time the
        // peer set changes (but only while pre-race). Without this, a player
        // who joined early could end up sandwiched once more peers arrive.
        _reapplyLocalSlotIfSafe();
        // Add minimap dot for the newly-known peer.
        _addMinimapDot( peerId );

    } );

    room.on( 'peerLeave', ( peerId ) => {

        const rc = multiplayer.remotes.get( peerId );
        if ( rc ) rc.destroy();
        multiplayer.remotes.delete( peerId );
        multiplayer.metaByPeer.delete( peerId );
        multiplayer.readyMap.delete( peerId );
        _removeMinimapDot( peerId );
        _renderMultiplayerUI();
        // Re-shuffle slots so departing peers don't leave gaps in the grid.
        _reapplyLocalSlotIfSafe();
        // If their leaving means the remaining players are all ready, kick
        // off the countdown — otherwise the race stalls forever.
        _maybeStartCountdown();

    } );

    room.on( 'meta', ( peerId, data ) => {

        multiplayer.metaByPeer.set( peerId, data );
        let rc = multiplayer.remotes.get( peerId );
        if ( ! rc ) {

            rc = new RemoteCar( peerId, data );
            rc.setCollidable( _isCollidableRaceState() );
            multiplayer.remotes.set( peerId, rc );
            // Meta-before-peerJoin race: ensure the minimap dot exists.
            _addMinimapDot( peerId );

        } else {

            rc.setMeta( data );

        }
        // Map sync: if this peer is authoritative and we're on a different
        // map, hop to theirs. swapMap() is async; we rebroadcast meta after
        // it lands so peers know we're now on the right map.
        if ( _shouldSyncMapTo( data, peerId ) ) {

            const targetMap = data.mapId;
            swapMap( targetMap ).then( () => { _broadcastLocalMeta(); } );
            if ( typeof showCarToast === 'function' ) showCarToast( 'joining ' + ( MAPS[ targetMap ]?.label || targetMap ) );

        }
        _renderMultiplayerUI();

    } );

    room.on( 'snapshot', ( peerId, snap ) => {

        let rc = multiplayer.remotes.get( peerId );
        if ( ! rc ) {

            // Snapshot arrived before meta (race condition between actions
            // and the meta sent on peerJoin). Spawn with cached meta if any,
            // otherwise placeholder until meta lands.
            rc = new RemoteCar( peerId, multiplayer.metaByPeer.get( peerId ) );
            rc.setCollidable( _isCollidableRaceState() );
            multiplayer.remotes.set( peerId, rc );
            // Snapshot-before-peerJoin race: ensure the minimap dot exists.
            _addMinimapDot( peerId );
            _renderMultiplayerUI();

        }
        rc.pushSnap( snap );

    } );

    room.on( 'race', ( peerId, evt ) => {

        if ( ! evt || ! evt.type ) return;

        if ( evt.type === 'start_race' ) {

            // Anyone in the room can press "start race"; everyone enters
            // ready-check together.
            _enterReadyCheck();

        } else if ( evt.type === 'ready' ) {

            multiplayer.readyMap.set( peerId, { ready: true, carIdx: evt.carIdx } );
            _renderMultiplayerUI();
            _maybeStartCountdown();

        } else if ( evt.type === 'countdown' ) {

            // Only the first countdown event wins; later ones are ignored.
            if ( multiplayer.raceState === 'countdown' || multiplayer.raceState === 'racing' ) return;
            _enterCountdown( evt.startAt );

        } else if ( evt.type === 'finished' ) {

            if ( ! multiplayer.raceWinner ) {

                multiplayer.raceWinner = peerId;
                multiplayer.raceWinnerName = ( multiplayer.metaByPeer.get( peerId ) || {} ).name || peerId.slice( 0, 6 );
                multiplayer.raceState = 'finished';
                _applyRaceModeToRemotes();
                _announceWinner( multiplayer.raceWinnerName + ' wins!' );
                _renderMultiplayerUI();

            }

        }

    } );

}

function _enterReadyCheck() {

    multiplayer.raceState = 'ready_check';
    multiplayer.readyMap = new Map();
    multiplayer.localReady = false;
    multiplayer.raceWinner = null;
    multiplayer.raceWinnerName = '';
    lapTimerResetCurrent();
    _applyRaceModeToRemotes();
    _renderMultiplayerUI();

}

function _toggleReady() {

    if ( ! multiplayer.room ) return;
    if ( multiplayer.raceState !== 'ready_check' ) return;
    if ( multiplayer.localReady ) return; // no un-ready in v1

    const carIdx = typeof currentCarIndex === 'number' ? currentCarIndex : 0;
    multiplayer.localReady = true;
    multiplayer.readyMap.set( 'self', { ready: true, carIdx } );
    multiplayer.room.sendRace( { type: 'ready', carIdx } );
    _renderMultiplayerUI();
    _maybeStartCountdown();

}

// Local decision: if every peer in the room (and us) has sent a ready
// event, broadcast the countdown. Duplicates are debounced inside the
// 'countdown' race handler so multiple clients triggering this in the
// same tick is harmless.
function _maybeStartCountdown() {

    if ( ! multiplayer.room ) return;
    if ( multiplayer.raceState !== 'ready_check' ) return;
    if ( ! multiplayer.localReady ) return;

    const peers = multiplayer.room.peers();
    if ( peers.length < 1 ) return; // need at least one opponent

    for ( const p of peers ) {

        const r = multiplayer.readyMap.get( p );
        if ( ! r || ! r.ready ) return;

    }

    const startAt = Date.now() + COUNTDOWN_MS;
    multiplayer.room.sendRace( { type: 'countdown', startAt } );
    _enterCountdown( startAt );

}

function _enterCountdown( startAt ) {

    multiplayer.raceState = 'countdown';
    multiplayer.raceStartAt = startAt;
    multiplayer.raceWinner = null;
    multiplayer.raceWinnerName = '';
    lapTimerResetCurrent();
    _renderMultiplayerUI();

}

function _tickRace() {

    if ( multiplayer.raceState === 'countdown' ) {

        const remaining = multiplayer.raceStartAt - Date.now();
        if ( multiplayer.countdownEl ) {

            if ( remaining <= 0 ) multiplayer.countdownEl.textContent = 'GO!';
            else multiplayer.countdownEl.textContent = String( Math.ceil( remaining / 1000 ) );

        }
        if ( remaining <= 0 ) {

            multiplayer.raceState = 'racing';
            lapTimerResetCurrent();
            _renderMultiplayerUI();

        }

    }

}

function _announceWinner( msg ) {

    // Reuse the existing car-toast: just write into it.
    if ( typeof showCarToast === 'function' ) showCarToast( msg );
    else console.log( '[race]', msg );

}

// Called by completeLap() when the player crosses the finish line. If
// we're mid-race, broadcast the finish so peers know we won (or we know
// we beat them to it).
function _onLocalLapCompleteForRace() {

    if ( ! multiplayer.room ) return;
    if ( multiplayer.raceState !== 'racing' || multiplayer.raceWinner ) return;
    multiplayer.raceWinner = 'self';
    multiplayer.raceWinnerName = multiplayer.playerName + ' (you)';
    multiplayer.raceState = 'finished';
    _applyRaceModeToRemotes();
    multiplayer.room.sendRace( { type: 'finished' } );
    _announceWinner( 'you win!' );
    _renderMultiplayerUI();

}

// 20 Hz position broadcast — runs from animate() after the physics step.
function _maybeBroadcastSnapshot( now ) {

    if ( ! multiplayer.room || ! chassis ) return;
    if ( now - multiplayer.lastSnapAt < SNAP_INTERVAL_MS ) return;
    multiplayer.lastSnapAt = now;

    const p = chassis.translation();
    const r = chassis.rotation();
    const v = chassis.linvel();
    multiplayer.room.sendSnapshot( {
        pos: [ p.x, p.y, p.z ],
        rot: [ r.x, r.y, r.z, r.w ],
        vel: [ v.x, v.y, v.z ]
    } );

}

function _updateRemoteCars( dt ) {

    if ( multiplayer.remotes.size === 0 ) return;
    const renderTime = performance.now() - INTERP_DELAY_MS;
    for ( const rc of multiplayer.remotes.values() ) rc.update( renderTime, dt );

}

// Whenever the player swaps car or starts up, push the meta to peers so
// their RemoteCar instance for us repaints in the right body colour.
function _broadcastLocalMeta() {

    if ( ! multiplayer.room ) return;
    multiplayer.room.meta = {
        name: multiplayer.playerName,
        carIdx: typeof currentCarIndex === 'number' ? currentCarIndex : 0,
        mapId: currentMapId,
        isHost: multiplayer.isHost,
        joinTime: multiplayer.joinTime
    };
    multiplayer.room.sendMeta();

}

// Decide whether to adopt a peer's map. The host is authoritative — they
// never adopt. Non-hosts adopt from any host; if no peer is a host (e.g.
// two URL-joiners), the earlier joiner wins. Local clocks can skew across
// machines but joinTime drifts by network latency at most a few ms in
// practice; we tie-break by peerId so the rule is at least deterministic.
function _shouldSyncMapTo( theirMeta, theirPeerId ) {

    if ( ! theirMeta || ! theirMeta.mapId ) return false;
    if ( ! MAPS[ theirMeta.mapId ] ) return false;
    if ( theirMeta.mapId === currentMapId ) return false;

    if ( multiplayer.isHost ) return false;
    if ( theirMeta.isHost ) return true;

    const theirTime = Number.isFinite( theirMeta.joinTime ) ? theirMeta.joinTime : Infinity;
    if ( theirTime < multiplayer.joinTime ) return true;
    if ( theirTime > multiplayer.joinTime ) return false;
    return theirPeerId < ( multiplayer.room?.selfId || '' );

}

// ----- UI -----

function initMultiplayer() {

    multiplayer.playerName = _localPlayerName();

    const root = document.createElement( 'div' );
    root.className = 'mp-root-desktop';
    root.style.cssText = [
        'position:absolute', 'bottom:82px', 'left:10px',
        'z-index:5', 'font:12px Monospace', 'color:#fff',
        'user-select:none', 'min-width:200px',
        'pointer-events:auto'
    ].join( ';' );
    document.body.appendChild( root );
    multiplayer.rootEl = root;

    _renderMultiplayerUI();
    _tryAutoJoinFromUrl();

}

function _btnStyle() {

    return [
        'cursor:pointer', 'padding:4px 10px',
        'background:rgba(0,0,0,0.55)', 'border:none',
        'border-radius:4px', 'color:#fff',
        'font:12px Monospace'
    ].join( ';' );

}

function _renderMultiplayerUI() {

    // Mirror to mobile UI so the drawer chip + open MP modal sheet stay
    // in sync with room state changes (peers joining, race starting, etc.).
    if ( typeof device !== 'undefined' && device.touchOnly ) {

        if ( device.drawerOpen ) _renderMobileDrawer();
        if ( device.mpModalOpen ) _renderMobileMpModal();

    }

    if ( ! multiplayer.rootEl ) return;
    const root = multiplayer.rootEl;
    root.innerHTML = '';

    if ( ! multiplayer.room ) {

        // Default state — two buttons side by side.
        const row = document.createElement( 'div' );
        row.style.cssText = 'display:flex;gap:6px;align-items:center';

        const makeBtn = document.createElement( 'button' );
        makeBtn.textContent = 'make room';
        makeBtn.style.cssText = _btnStyle();
        makeBtn.addEventListener( 'click', () => _createRoom() );

        const joinBtn = document.createElement( 'button' );
        joinBtn.textContent = 'join room';
        joinBtn.style.cssText = _btnStyle();
        joinBtn.addEventListener( 'click', () => _showJoinForm() );

        row.append( makeBtn, joinBtn );
        root.append( row );

        if ( multiplayer.joinForm ) {

            root.append( multiplayer.joinForm );

        }
        return;

    }

    // In a room: panel with code, peer count, race controls.
    const panel = document.createElement( 'div' );
    panel.style.cssText = [
        'padding:6px 10px', 'background:rgba(0,0,0,0.7)',
        'border:1px solid rgba(255,255,255,0.15)',
        'border-radius:4px', 'display:flex',
        'flex-direction:column', 'gap:4px'
    ].join( ';' );

    const header = document.createElement( 'div' );
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px';

    const codeWrap = document.createElement( 'div' );
    const codeLabel = document.createElement( 'span' );
    codeLabel.textContent = 'room ';
    codeLabel.style.opacity = '0.6';
    const code = document.createElement( 'span' );
    code.textContent = multiplayer.room.roomCode;
    code.style.cssText = 'color:#FFCB47;font-weight:bold;letter-spacing:1px';
    codeWrap.append( codeLabel, code );

    const copyBtn = document.createElement( 'span' );
    copyBtn.textContent = 'copy link';
    copyBtn.title = _shareUrl( multiplayer.room.roomCode );
    copyBtn.style.cssText = 'cursor:pointer;opacity:0.65;font-size:10px';
    copyBtn.addEventListener( 'mouseenter', () => { copyBtn.style.opacity = '1'; } );
    copyBtn.addEventListener( 'mouseleave', () => { copyBtn.style.opacity = '0.65'; } );
    copyBtn.addEventListener( 'click', () => {

        const url = _shareUrl( multiplayer.room.roomCode );
        navigator.clipboard?.writeText( url ).then( () => {

            copyBtn.textContent = 'copied';
            setTimeout( () => { copyBtn.textContent = 'copy link'; }, 1100 );

        } );

    } );

    const leaveBtn = document.createElement( 'span' );
    leaveBtn.textContent = 'leave';
    leaveBtn.style.cssText = 'cursor:pointer;opacity:0.65;font-size:10px';
    leaveBtn.addEventListener( 'mouseenter', () => { leaveBtn.style.opacity = '1'; } );
    leaveBtn.addEventListener( 'mouseleave', () => { leaveBtn.style.opacity = '0.65'; } );
    leaveBtn.addEventListener( 'click', () => _leaveRoom() );

    header.append( codeWrap, copyBtn, leaveBtn );
    panel.append( header );

    const urlLine = document.createElement( 'div' );
    urlLine.textContent = _shareUrl( multiplayer.room.roomCode );
    urlLine.style.cssText = [
        'font-size:10px', 'opacity:0.55', 'user-select:all',
        'cursor:text', 'overflow:hidden', 'text-overflow:ellipsis',
        'white-space:nowrap', 'max-width:240px'
    ].join( ';' );
    panel.append( urlLine );

    const peers = multiplayer.room.peers();
    const status = document.createElement( 'div' );
    status.style.cssText = 'font-size:11px;opacity:0.85';
    if ( multiplayer.raceState === 'lobby' ) {

        status.textContent = `players: ${ peers.length + 1 }${ peers.length === 0 ? ' · waiting for friends...' : '' }`;

    } else if ( multiplayer.raceState === 'ready_check' ) {

        let readyCount = multiplayer.localReady ? 1 : 0;
        for ( const p of peers ) if ( multiplayer.readyMap.get( p )?.ready ) readyCount ++;
        const total = peers.length + 1;
        status.textContent = `${ readyCount }/${ total } ready · pick your car (Q), then press READY`;

    } else if ( multiplayer.raceState === 'countdown' ) {

        status.textContent = 'starting in ';
        const ce = document.createElement( 'span' );
        ce.style.cssText = 'color:#FFCB47;font-weight:bold';
        ce.textContent = String( Math.ceil( ( multiplayer.raceStartAt - Date.now() ) / 1000 ) );
        status.appendChild( ce );
        multiplayer.countdownEl = ce;

    } else if ( multiplayer.raceState === 'racing' ) {

        status.innerHTML = `<span style="color:#5DD68F">● racing</span> · ${ peers.length + 1 } players`;

    } else if ( multiplayer.raceState === 'finished' ) {

        status.innerHTML = `<span style="color:#FFCB47">★ ${ multiplayer.raceWinnerName } wins</span>`;

    }
    panel.append( status );

    // Ready list during ready_check — one row per player with their pick.
    if ( multiplayer.raceState === 'ready_check' ) {

        const list = document.createElement( 'div' );
        list.style.cssText = 'font-size:11px;display:flex;flex-direction:column;gap:2px;margin-top:2px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.12)';
        list.append( _readyRow( 'you', multiplayer.readyMap.get( 'self' ) ) );
        for ( const p of peers ) {

            const meta = multiplayer.metaByPeer.get( p );
            const name = ( meta && meta.name ) || p.slice( 0, 6 );
            list.append( _readyRow( name, multiplayer.readyMap.get( p ) ) );

        }
        panel.append( list );

    }

    // Race controls.
    const controls = document.createElement( 'div' );
    controls.style.cssText = 'display:flex;gap:6px';

    if ( multiplayer.raceState === 'lobby' || multiplayer.raceState === 'finished' ) {

        const startBtn = document.createElement( 'button' );
        startBtn.textContent = multiplayer.raceState === 'finished' ? 'race again' : 'start race';
        startBtn.style.cssText = _btnStyle();
        startBtn.addEventListener( 'click', () => _startRace() );
        controls.append( startBtn );

    } else if ( multiplayer.raceState === 'ready_check' && ! multiplayer.localReady ) {

        const readyBtn = document.createElement( 'button' );
        readyBtn.textContent = 'READY';
        readyBtn.style.cssText = _btnStyle() + ';background:#5DD68F;color:#0c0c0c;font-weight:bold';
        readyBtn.addEventListener( 'click', () => _toggleReady() );
        controls.append( readyBtn );

    }

    if ( controls.children.length > 0 ) panel.append( controls );

    root.append( panel );

}

function _readyRow( name, entry ) {

    const row = document.createElement( 'div' );
    row.style.cssText = 'display:flex;justify-content:space-between;gap:8px';
    const left = document.createElement( 'span' );
    left.textContent = name;
    left.style.opacity = '0.85';
    const right = document.createElement( 'span' );
    if ( entry && entry.ready ) {

        const carName = ( CARS[ entry.carIdx ] || {} ).name || '?';
        right.innerHTML = `<span style="color:#5DD68F">✓</span> <span style="opacity:0.7">${ carName }</span>`;

    } else {

        right.textContent = 'choosing...';
        right.style.opacity = '0.5';

    }
    row.append( left, right );
    return row;

}

function _showJoinForm() {

    const form = document.createElement( 'div' );
    form.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:6px';

    const input = document.createElement( 'input' );
    input.type = 'text';
    input.placeholder = 'room code';
    input.maxLength = 5;
    input.style.cssText = [
        'padding:4px 8px', 'background:rgba(0,0,0,0.55)',
        'border:1px solid rgba(255,255,255,0.2)', 'color:#fff',
        'border-radius:4px', 'font:12px Monospace',
        'width:90px', 'text-transform:uppercase', 'letter-spacing:1px'
    ].join( ';' );

    const goBtn = document.createElement( 'button' );
    goBtn.textContent = 'join';
    goBtn.style.cssText = _btnStyle();

    const submit = () => {

        const code = input.value.trim().toUpperCase();
        if ( code.length < 3 ) return;
        _joinRoom( code );

    };
    goBtn.addEventListener( 'click', submit );
    input.addEventListener( 'keydown', ( e ) => {

        e.stopPropagation(); // don't let the driving keybinds eat the typing
        if ( e.key === 'Enter' ) submit();

    } );
    input.addEventListener( 'keyup', ( e ) => { e.stopPropagation(); } );

    form.append( input, goBtn );
    multiplayer.joinForm = form;
    _renderMultiplayerUI();
    setTimeout( () => input.focus(), 0 );

}

function _createRoom() {

    const code = generateRoomCode();
    _enterRoom( code, true );

}

function _joinRoom( code ) {

    _enterRoom( code, false );

}

function _enterRoom( code, isHost ) {

    if ( multiplayer.room ) return;
    multiplayer.isHost = isHost;
    multiplayer.joinForm = null;

    multiplayer.joinTime = Date.now();
    const room = openRoom( code, {
        name: multiplayer.playerName,
        carIdx: typeof currentCarIndex === 'number' ? currentCarIndex : 0,
        mapId: currentMapId,
        isHost,
        joinTime: multiplayer.joinTime
    } );
    multiplayer.room = room;
    _hookRoomCallbacks( room );
    _setUrlForRoom( code );

    // Take a slot beside any peers already present. Slot is computed
    // deterministically by sorting peerIds + selfId — every machine
    // produces the same mapping, so no coordination is needed and
    // simultaneous joiners can't collide on the same slot. We still wait
    // ~300ms because room.peers() is empty on the very first tick after
    // openRoom; the peerJoin handler will also fire _reapplyLocalSlotIfSafe
    // when new peers show up, so this initial call is just for the case
    // where peers were already in the room when we arrived.
    setTimeout( () => {

        _reapplyLocalSlotIfSafe();

    }, 300 );

    _renderMultiplayerUI();

}

function _leaveRoom() {

    if ( multiplayer.room ) {

        try { multiplayer.room.leave(); } catch {}
        multiplayer.room = null;

    }
    for ( const rc of multiplayer.remotes.values() ) rc.destroy();
    multiplayer.remotes.clear();
    multiplayer.metaByPeer.clear();
    multiplayer.readyMap = new Map();
    multiplayer.localReady = false;
    multiplayer.raceState = 'lobby';
    multiplayer.raceWinner = null;
    multiplayer.raceWinnerName = '';
    multiplayer.isHost = false;
    // Tear down every per-peer minimap dot — otherwise stale dots would
    // hang around in the frame after we leave.
    for ( const peerId of Array.from( minimap.peerDots.keys() ) ) {

        _removeMinimapDot( peerId );

    }
    _setUrlForRoom( null );
    _renderMultiplayerUI();

}

function _startRace() {

    if ( ! multiplayer.room ) return;
    multiplayer.room.sendRace( { type: 'start_race' } );
    _enterReadyCheck();

}

// ---------------- audio ----------------
//
// Two looping AudioBufferSourceNodes:
//  - engine: playbackRate (pitch) is driven by engine.rpm; volume by throttle.
//  - squeal: volume is driven by max |wheelSideImpulse| across the four wheels.
// AudioContext starts in 'suspended' state on most browsers — created lazily
// on the first user gesture (keydown / pointerdown / touch).
const audio = {
    ctx: null,
    started: false,
    engineBuffer: null, squealBuffer: null,
    engineNode: null,   squealNode: null,
    engineGain: null,   squealGain: null,
    masterGain: null,
    masterVolume: 0.4,  // user-controllable; survives AudioContext (re)creation
    smoothedSqueal: 0,
    engineBufferCache: new Map() // url → AudioBuffer, lazily populated per car swap
};

const AUDIO_PATHS = {
    engine: 'sounds/engine.mp3',
    squeal: 'sounds/squeal.mp3'
};

async function _loadAudio( ctx, url ) {

    const res = await fetch( import.meta.env.BASE_URL + url );
    const buf = await res.arrayBuffer();
    return await ctx.decodeAudioData( buf );

}

// Helper used both at startup and when swapping cars: spin up a fresh
// AudioBufferSourceNode wired to the persistent engineGain, with loopStart
// set so the steady-state idle is what actually loops.
function _startEngineNode( buffer, loopStart ) {

    if ( ! audio.ctx || ! buffer ) return;
    if ( audio.engineNode ) {

        try { audio.engineNode.stop(); } catch ( e ) { /* already stopped */ }
        audio.engineNode.disconnect();

    }

    const node = audio.ctx.createBufferSource();
    node.buffer = buffer;
    node.loop = true;
    node.loopStart = loopStart;
    node.loopEnd = buffer.duration;
    node.connect( audio.engineGain );
    node.start();
    audio.engineNode = node;
    audio.engineBuffer = buffer;

}

async function swapEngineAudio( car ) {

    if ( ! audio.ctx || ! audio.started ) return;

    let buf;
    if ( audio.engineBufferCache.has( car.soundFile ) ) {

        buf = audio.engineBufferCache.get( car.soundFile );

    } else {

        try {

            buf = await _loadAudio( audio.ctx, car.soundFile );
            audio.engineBufferCache.set( car.soundFile, buf );

        } catch ( err ) {

            // No file for this car yet — keep using the existing buffer but
            // still re-apply the loopStart for this car's settings.
            buf = audio.engineBuffer;

        }

    }
    _startEngineNode( buf, car.soundLoopStart );

}

// ---------------- controls cheatsheet ----------------
//
// The #info panel in the top-right shows one set of bindings at a time.
// When a gamepad connects we swap to the controller scheme — otherwise we
// show the keyboard one. The scheme renders into #controlsList; the volume
// slider above and the minimap toggle below stay put as siblings.
// A PlayStation variant (CONTROLS_GAMEPAD_PS) exists alongside the Xbox
// scheme for DualShock / DualSense pads — selected via controllerKind().

const CONTROLS_KEYBOARD = [
    'W / ↑ · throttle',
    'Space · brake',
    'S / ↓ · brake · hold = reverse',
    'A D / ← → · steer',
    'E · handbrake',
    'M · auto / manual',
    'Q · cycle car',
    'L⇧ · upshift  ·  L⌃ · downshift',
    'R · reset',
    'C · cycle camera (chase / free / pov)',
    '1 / 2 / 3 / 4 · cycle map (Nordschleife / GP / Spa / Suzuka)',
    'B · toggle ABS    ·    N · toggle traction control',
    'T · record 60s telemetry (input + output → JSON)'
];

const CONTROLS_GAMEPAD = [
    'LS · steer',
    'RT · throttle',
    'LT · brake · hold full 2s @ stop = reverse',
    'A · handbrake',
    'B · toggle ABS',
    'X · auto / manual',
    'Back · cycle car',
    'RB · upshift  ·  LB · downshift',
    'Start · reset',
    'Y · cycle camera (chase / free / pov)',
    'D-pad → · cycle map',
    'D-pad ← · toggle minimap',
    'D-pad ↑ · stats for nerds',
    'D-pad ↓ · toggle traction control'
];

const CONTROLS_GAMEPAD_PS = [
    'LS · steer',
    'R2 · throttle',
    'L2 · brake · hold full 2s @ stop = reverse',
    '✕ · handbrake',
    '● · toggle ABS',
    '■ · auto / manual',
    'Share · cycle car',
    'R1 · upshift  ·  L1 · downshift',
    'Options · reset',
    '▲ · cycle camera (chase / free / pov)',
    'D-pad → · cycle map',
    'D-pad ← · toggle minimap',
    'D-pad ↑ · stats for nerds',
    'D-pad ↓ · toggle traction control'
];

function renderControlsCheatsheet() {

    const list = document.getElementById( 'controlsList' );
    if ( ! list ) return;

    const kind = controllerKind();
    const scheme = kind === 'ps' ? CONTROLS_GAMEPAD_PS : kind === 'xbox' ? CONTROLS_GAMEPAD : CONTROLS_KEYBOARD;
    list.innerHTML = '';
    for ( const line of scheme ) {

        const p = document.createElement( 'p' );
        p.textContent = line;
        list.appendChild( p );

    }

    // Stats-for-nerds toggle position is anchored to #info's bottom edge,
    // and the panel's height just changed.
    if ( typeof _positionStatsBelowInfo === 'function' ) _positionStatsBelowInfo();

}

function initVolumeSlider() {

    const infoEl = document.getElementById( 'info' );
    if ( ! infoEl ) return;

    const saved = parseFloat( localStorage.getItem( 'masterVolume' ) );
    if ( Number.isFinite( saved ) && saved >= 0 && saved <= 1 ) audio.masterVolume = saved;

    const row = document.createElement( 'div' );
    row.className = 'volume-row';

    const label = document.createElement( 'span' );
    label.textContent = 'VOL';
    label.style.opacity = '0.85';

    const slider = document.createElement( 'input' );
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    slider.value = String( audio.masterVolume );

    const readout = document.createElement( 'span' );
    readout.textContent = Math.round( audio.masterVolume * 100 );

    row.appendChild( label );
    row.appendChild( slider );
    row.appendChild( readout );
    infoEl.insertBefore( row, infoEl.firstChild );

    slider.addEventListener( 'input', () => {

        const v = parseFloat( slider.value );
        audio.masterVolume = v;
        if ( audio.masterGain ) audio.masterGain.gain.value = v;
        readout.textContent = Math.round( v * 100 );
        localStorage.setItem( 'masterVolume', String( v ) );

    } );

}

// Controller-rumble strength slider. Same row pattern as VOL so it
// inherits the .volume-row CSS (touch-action: auto, thumb styles, etc.).
// Sliding to 0 turns rumble off entirely; persisted to localStorage.
function initRumbleSlider() {

    const infoEl = document.getElementById( 'info' );
    if ( ! infoEl ) return;

    // One-time migration: existing players have a v1 stored value where
    // slider 1.0 mapped to 1.0x output. The new slider includes a 2.5x
    // headroom multiplier, so divide their old value by 2.5 to preserve
    // the same physical sensation. Mark migrated with a flag key.
    const migrated = localStorage.getItem( 'rumbleSliderV2' ) === '1';
    const saved = parseFloat( localStorage.getItem( 'rumbleStrength' ) );
    if ( Number.isFinite( saved ) && saved >= 0 && saved <= 1 ) {

        if ( migrated ) rumble.strength = saved;
        else {

            rumble.strength = Math.min( 1, saved / RUMBLE_MAX_SCALE );
            localStorage.setItem( 'rumbleStrength', String( rumble.strength ) );
            localStorage.setItem( 'rumbleSliderV2', '1' );

        }

    } else {

        // Fresh install — default to 0.4 (= the old "calm" baseline).
        rumble.strength = 0.4;
        localStorage.setItem( 'rumbleSliderV2', '1' );

    }

    const row = document.createElement( 'div' );
    row.className = 'volume-row';

    const label = document.createElement( 'span' );
    label.textContent = 'RUM';
    label.style.opacity = '0.85';

    const slider = document.createElement( 'input' );
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    slider.value = String( rumble.strength );

    const readout = document.createElement( 'span' );
    readout.textContent = Math.round( rumble.strength * 100 );

    row.appendChild( label );
    row.appendChild( slider );
    row.appendChild( readout );
    // Insert right after the existing VOL row (which initVolumeSlider
    // prepended as #info's first child) so RUM sits directly beneath it.
    const volRow = infoEl.querySelector( '.volume-row' );
    if ( volRow && volRow.nextSibling ) infoEl.insertBefore( row, volRow.nextSibling );
    else infoEl.insertBefore( row, infoEl.firstChild );

    slider.addEventListener( 'input', () => {

        const v = parseFloat( slider.value );
        rumble.strength = v;
        readout.textContent = Math.round( v * 100 );
        localStorage.setItem( 'rumbleStrength', String( v ) );
        // If user dragged to zero, kill any active pulse so nothing
        // lingers in the controller motor for the next 140 ms.
        if ( v <= 0 ) {

            rumble.contWeak = 0;
            rumble.contStrong = 0;
            rumble.onceEndsAt = 0;
            // Triggers share the same master — drop them immediately so the
            // adaptive resistance doesn't linger until the next animate tick.
            if ( ds.device && ! ds.disabled ) {

                dsTriggerOff( 'L2' );
                dsTriggerOff( 'R2' );
                dsFlush();

            }

        }

    } );

}

async function startAudio() {

    // Already initialized — just make sure the context is running. Browsers
    // can leave/return AudioContext to 'suspended' even after a successful
    // create (Safari especially), so re-call resume() on every gesture.
    if ( audio.started ) {

        if ( audio.ctx && audio.ctx.state === 'suspended' ) {

            audio.ctx.resume().catch( () => {} );

        }
        return;

    }
    audio.started = true;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if ( ! Ctx ) { audio.started = false; return; }
    const ctx = new Ctx();
    audio.ctx = ctx;
    if ( ctx.state === 'suspended' ) ctx.resume().catch( () => {} );

    audio.masterGain = ctx.createGain();
    audio.masterGain.gain.value = audio.masterVolume;
    audio.masterGain.connect( ctx.destination );

    try {

        [ audio.engineBuffer, audio.squealBuffer ] = await Promise.all( [
            _loadAudio( ctx, currentCar.soundFile ),
            _loadAudio( ctx, AUDIO_PATHS.squeal )
        ] );
        audio.engineBufferCache.set( currentCar.soundFile, audio.engineBuffer );

    } catch ( err ) {

        // Fall back to the generic engine.mp3 if the car-specific file is missing.
        try {

            audio.engineBuffer = await _loadAudio( ctx, AUDIO_PATHS.engine );
            audio.squealBuffer = audio.squealBuffer || await _loadAudio( ctx, AUDIO_PATHS.squeal );
            audio.engineBufferCache.set( AUDIO_PATHS.engine, audio.engineBuffer );

        } catch ( err2 ) {

            console.warn( '[audio] failed to load:', err2 );
            return;

        }

    }

    audio.engineGain = ctx.createGain();
    audio.engineGain.gain.value = 0.2;
    audio.engineGain.connect( audio.masterGain );

    _startEngineNode( audio.engineBuffer, currentCar.soundLoopStart );

    audio.squealNode = ctx.createBufferSource();
    audio.squealNode.buffer = audio.squealBuffer;
    audio.squealNode.loop = true;
    audio.squealGain = ctx.createGain();
    audio.squealGain.gain.value = 0;
    audio.squealNode.connect( audio.squealGain ).connect( audio.masterGain );
    audio.squealNode.start();

}

// Short, punchy synthesized gear-shift sound. Two layers: a low ~180→60 Hz
// thump (square osc) and a 30 ms highpassed noise burst tick on top. Free —
// no asset, < 100 ms total, called every time the gear actually changes.
function playShiftSound() {

    // Calm haptic tick for every shift (manual + auto). Slightly heavier
    // on the strong motor so it feels like a soft mechanical clunk, not
    // an electrical buzz. Pre-checked inside rumblePulse so this is safe
    // before audio is unlocked / on Safari / without a pad.
    rumblePulse( 0.10, 0.18, 70 );

    if ( ! audio.started || ! audio.ctx || ! audio.masterGain ) return;
    const ctx = audio.ctx;
    const now = ctx.currentTime;

    // Thump
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime( 180, now );
    osc.frequency.exponentialRampToValueAtTime( 60, now + 0.06 );
    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime( 0.18, now );
    oscGain.gain.exponentialRampToValueAtTime( 0.001, now + 0.08 );
    osc.connect( oscGain ).connect( audio.masterGain );
    osc.start( now );
    osc.stop( now + 0.1 );

    // Tick (highpassed white-noise burst with linear decay envelope baked in)
    const len = Math.floor( ctx.sampleRate * 0.03 );
    const buf = ctx.createBuffer( 1, len, ctx.sampleRate );
    const d = buf.getChannelData( 0 );
    for ( let i = 0; i < len; i ++ ) d[ i ] = ( Math.random() * 2 - 1 ) * ( 1 - i / len );
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.12;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1800;
    noise.connect( hp ).connect( noiseGain ).connect( audio.masterGain );
    noise.start( now );

}

function updateAudio( dt ) {

    if ( ! audio.started || ! audio.engineGain || ! vehicleController ) return;

    // Engine pitch from RPM. Per-car pitchMin/pitchMax give each engine its
    // own range — F1 ramps higher and steeper than the hatchback.
    const rpmNorm = Math.max( 0, Math.min( 1, ( engine.rpm - engine.idleRpm ) / ( engine.redline - engine.idleRpm ) ) );
    const targetRate = currentCar.pitchMin + rpmNorm * ( currentCar.pitchMax - currentCar.pitchMin );
    // Smooth pitch using setTargetAtTime so abrupt RPM jumps (gear changes)
    // don't click.
    audio.engineNode.playbackRate.setTargetAtTime( targetRate, audio.ctx.currentTime, 0.08 );

    // Engine volume: base idle + throttle contribution. Soft floor so even at
    // 0 throttle you hear a quiet idle.
    const engineVol = 0.15 + input.throttle * 0.5 + rpmNorm * 0.2;
    audio.engineGain.gain.setTargetAtTime( engineVol, audio.ctx.currentTime, 0.05 );

    // Skid: take max abs side impulse across the four wheels, normalize, and
    // smooth so the squeal fades in instead of popping.
    let maxSide = 0;
    for ( let i = 0; i < 4; i ++ ) {

        const s = Math.abs( vehicleController.wheelSideImpulse( i ) );
        if ( s > maxSide ) maxSide = s;

    }
    // Only count squeal when wheels are actually in contact AND we're moving.
    const speed = Math.abs( vehicleController.currentVehicleSpeed() );
    const inAir = ! vehicleController.wheelIsInContact( 0 ) && ! vehicleController.wheelIsInContact( 1 )
        && ! vehicleController.wheelIsInContact( 2 ) && ! vehicleController.wheelIsInContact( 3 );
    let squealRaw = 0;
    if ( ! inAir && speed > 2 ) {

        // Empirical: side impulse of ~6+ on a wheel = strong squeal.
        squealRaw = Math.max( 0, Math.min( 1, ( maxSide - 1.5 ) / 5.0 ) );

    }
    const a = 1 - Math.exp( - 8 * dt );
    audio.smoothedSqueal += ( squealRaw - audio.smoothedSqueal ) * a;
    audio.squealGain.gain.setTargetAtTime( audio.smoothedSqueal * 0.6, audio.ctx.currentTime, 0.03 );

}

// On-screen touch controls. Activated when the device looks touch-only
// (touchscreen present + no hover/fine pointer), or hidden when a gamepad
// connects. Feeds touch.* into updateInput() in the standard merge path.
const touch = {
    enabled: false,
    rootEl: null,
    padEl: null,
    ringEl: null, thumbEl: null,
    throttleBarEl: null, brakeBarEl: null,
    throttleFillEl: null, brakeFillEl: null,
    clusterEl: null,
    steer: 0,
    throttle: 0,
    brake: 0,
    handbrake: 0,
    brakeActive: false,           // mirrors "S key held" for the long-press reverse logic
    dragPointerId: - 1,
    dragOriginX: 0
};

// Device-class detection. `touchOnly` flips to false if we ever observe a
// keystroke (so 2-in-1 laptops with both touchscreens and keyboards stay on
// the desktop UI). `portrait` / `smallScreen` are read from viewport size
// and re-evaluated on every resize / orientationchange.
const device = {
    touchOnly: false,
    portrait: false,
    smallScreen: false,
    keyboardSeen: false,
    mobileBuilt: false,        // set once we've inserted the hamburger + drawer
    drawerOpen: false,
    mpModalOpen: false,
    // DOM handles for the mobile UI we own.
    hamburgerEl: null,
    drawerEl: null,
    drawerBackdropEl: null,
    fpsChipEl: null,
    mpModalEl: null,
    mpChipEl: null
};

function _isTouchOnlyDevice() {

    // Prefer the coarse-pointer + no-hover signal — that's the cleanest mark
    // of a true touch-only handset. Laptops with touchscreens still report
    // hover:hover and pointer:fine because of their trackpad / mouse.
    const coarse = window.matchMedia && window.matchMedia( '(pointer: coarse)' ).matches;
    const noHover = window.matchMedia && window.matchMedia( '(hover: none)' ).matches;
    const hasTouchAPI = ( 'ontouchstart' in window ) || navigator.maxTouchPoints > 0;
    // Conservative: require BOTH coarse pointer AND no-hover AND a touch API.
    if ( coarse && noHover && hasTouchAPI ) return true;
    return false;

}

function _updateDeviceState() {

    const wasTouch = device.touchOnly;
    const wasPortrait = device.portrait;
    device.portrait = window.innerHeight > window.innerWidth;
    device.smallScreen = Math.min( window.innerWidth, window.innerHeight ) < 600;
    // If we've ever seen a keystroke this session, the user has a keyboard —
    // never mark touchOnly even on a touchscreen laptop.
    if ( device.keyboardSeen ) device.touchOnly = false;
    else device.touchOnly = _isTouchOnlyDevice();
    document.body.classList.toggle( 'is-mobile', device.touchOnly );
    document.body.classList.toggle( 'is-portrait', device.touchOnly && device.portrait );
    document.body.classList.toggle( 'is-landscape', device.touchOnly && ! device.portrait );
    return ( wasTouch !== device.touchOnly ) || ( wasPortrait !== device.portrait );

}

// Stats-for-nerds (F3-style) panel.
const statsForNerds = {
    enabled: false,
    panel: null,
    toggleBtn: null,
    fields: {},   // id -> <span>
    graphs: {},   // id -> { canvas, ctx, buffer, capacity }
    lastDelta: 0
};

// Driver input — normalized to [0,1] for pedals / [-1,1] for steer.
// Both keyboard and gamepad feed into this each frame.
const input = {
    throttle: 0,
    brake: 0,
    steer: 0,
    // Pre-curve combined input (keyboard ∪ gamepad ∪ touch), for the joystick
    // map widget and telemetry. `steer` above is the post-curve / post-deadzone
    // value that actually drives the wheel target angle.
    steerRaw: 0,
    handbrake: 0,
    reset: false,
    // raw key states so we can hold + combine
    keyW: false, keyS: false, keyA: false, keyD: false, keyE: false,
    arrowUp: false, arrowDown: false, arrowLeft: false, arrowRight: false,
    keyR: false, keySpace: false,
    // S-held timer for long-press reverse engagement
    sHeldTime: 0,
    // Gamepad LT-held-at-full timer for reverse engagement. Triggers when
    // LT is held at value > 0.95 for > 2 s while the car is essentially
    // stopped — keyboard/touch already have their own faster (0.3 s) path.
    padBrakeFullTime: 0,
    reverseEngaged: false,
    // Initial-spawn / post-R-reset handbrake lock — gravity can roll the
    // chassis on inclined spawns and we don't want the car drifting before
    // the player has even touched a key. Released by updateInput() the
    // first frame _anyInputActive() returns true.
    handbrakeAfterReset: true
};

// Steering tuning — non-linear curve + speed-sensitive max angle + dt-aware
// smoothing. The old pipeline was a flat lerp on a linear input which made
// the car spin out in high-speed corners because the full mechanical angle
// was available at any speed. The settings below are exposed at module
// scope so they can be tweaked live from the console.
const steeringCfg = {
    deadzone: 0.06,             // wider deadzone — small stick wobble no longer steers
    curveExponent: 2.1,         // softer near center → small inputs barely turn (was 1.7)
    // Speed-sensitive reduction. Max steering scales from 1.0 at standstill
    // down to `minFactor` at `vReduceMax` m/s and stays clamped above that.
    // Tighter clamp + earlier ramp → much harder to flick the car into a spin
    // at speed (was minFactor 0.40 / vReduceMax 55).
    minFactor: 0.30,
    vReduceMax: 42,             // m/s ≈ 150 km/h — full reduction reached sooner
    // dt-aware smoothing rates. Return-to-center is faster than steer-in so
    // the car settles back to straight rather than asymptotically lingering.
    // Slower in-rate prevents panic jerks from snapping the rear loose.
    smoothInRate: 10,
    smoothReturnRate: 18,
    // Snap-to-zero threshold (radians) when the target is zero. Catches the
    // long tail of the exponential decay so the wheels actually reach 0.
    zeroSnapRad: 0.001
};

// Traction control — cuts engine force per-driven-wheel when the
// longitudinal slip ratio exceeds the peak-grip threshold. Without this,
// stomping the throttle mid-corner sends the drive tyres past peak slip and
// the car washes wide / spins. Live state is mirrored to `drivetrain.tc`
// for the stats panel. Toggle with N (keyboard) / D-pad down (gamepad).
const tcCfg = {
    enabled: true,
    // Defaults are deliberately lenient — a real production-car TC system
    // never strangles below ~45% throttle, and players who turned TC ON for
    // safety still want the car to *accelerate*. Aggressive per-car TC (with
    // a tighter slipThreshold + lower minMult) is achievable by setting
    // `tc: { ... }` on a car in CARS — that block merges over these defaults
    // inside tractionCutFactor(). High-performance cars (F1, Supercar) get
    // VERY lenient TC; economy cars use the defaults below.
    slipThreshold: 0.16,        // lenient floor — real TC tolerates ~15–20% slip before cutting
    cutGain: 4.0,               // gentle ramp — was 6.0 which slammed to minMult on tiny overshoot
    minMult: 0.45,              // never cut below 45% — was 0.15, which was "limp mode" not TC
    // Low-speed exemption: below this speed TC is fully off. The slip-ratio
    // math is mathematically unstable here (divides by tiny speed) and we
    // don't want to choke launches from a standstill / uphill / sand.
    minActiveSpeed: 1.0,
    // Speed-based fade-in: between minActiveSpeed and fadeInSpeed the TC
    // cut amount scales from 0 → full so it doesn't snap from "no cut" to
    // big cut the moment we cross 1.2 m/s. Without this the player gets
    // stuck at ~4 km/h on any slope — throttle dies on hill starts.
    fadeInSpeed: 4.5,
    // Per-car grip scaling: cars with higher wheelFrictionSlip get
    // proportionally more slip headroom before TC engages.
    gripScale: 0.10
};

// ABS — cuts brake force per-wheel when the longitudinal slip ratio
// exceeds the threshold under braking. Without it, stomping the brake
// locks all four wheels, kills lateral grip, and makes trailbraking
// impossible. Same shape as TC but on the brake side. Toggle with B
// (keyboard) / B-button (gamepad).
const absCfg = {
    enabled: true,
    slipThreshold: 0.15,        // engages sooner (was 0.18) — keeps wheels rolling longer under panic-brake
    cutGain: 6.0,               // (was 5.0)
    minMult: 0.18,              // (was 0.20)
    minActiveSpeed: 1.5         // exempt at crawl so we don't release-pulse the handbrake/parking brake
};

// Per-frame steering-pipeline telemetry — populated by applyVehicleForces,
// consumed by the joystick map widget and the stats-for-nerds diagnostics.
const steeringTelemetry = {
    target: 0,       // desired wheel angle this frame (rad)
    actual: 0,       // smoothed wheel angle written to the controller (rad)
    maxAngle: 0,     // speed-scaled max steering angle (rad)
    speedFactor: 1   // scale applied to maxSteeringAngle by speed reduction
};

// 60-second telemetry recording started by the T key. Snapshots are pushed
// each frame and dumped to a JSON download when the buffer fills, similar
// to Trackmania's input recorder.
const telemetry = {
    recording: false,
    startedAt: 0,
    durationMs: 60_000,
    samples: [],
    sampleHz: 60,
    lastSampleAt: 0,
    lastDownloadedSize: 0
};

// Transmission state. Gear: -1 = R, 0 = N, 1..5 = forward gears.
const transmission = {
    mode: 'auto', // 'auto' | 'manual'
    gear: 1,
    shiftCooldown: 0
};

// Engine model. RPM is computed from wheel speed × gear ratio × final drive.
// idleRpm / redline / autoUpshiftRpm / autoDownshiftRpm are re-synced from the
// current car each time the player swaps via Q.
const engine = {
    rpm: 900,
    idleRpm: 900,
    redline: 7500,
    autoUpshiftRpm: 6200,
    autoDownshiftRpm: 2300
};

// Wheel radius is locked to the visual / collider geometry, so it stays fixed
// across cars. Everything else (mass, gears, redline, friction, suspension,
// brakes, engine sound, visual silhouette) is per-car in CARS below.
const WHEEL_RADIUS = 0.3;

// Per-car configs tuned by the planning subagent against real-world archetypes.
const CARS = [
    // Hatchback — 1300 kg FWD economy car baseline.
    // Beginner-friendly, soft suspension (rolls), mild understeer, ~175 km/h top.
    {
        name: 'Hatchback',
        bodyColor: 0xFFCB47,
        soundFile: 'sounds/engines/hatchback.mp3', soundLoopStart: 3.0,
        pitchMin: 0.55, pitchMax: 2.8,
        mass: 10, chassisFriction: 0.9,
        maxEngineForce: 62, engineIdleRpm: 900, engineRedline: 7000,
        peakTorqueRpm: 4200, torqueCurveWidth: 2300,
        gearRatios: [ 3.5, 2.1, 1.4, 1.0, 0.78 ], reverseRatio: - 3.4, finalDrive: 3.7,
        autoUpshiftRpm: 5900, autoDownshiftRpm: 2200,
        wheelFrictionSlip: 2.7,
        suspensionStiffness: 22, suspensionCompression: 1.9, suspensionRelaxation: 2.3,
        suspensionRestLength: 0.42, wheelConnectionY: - 0.30,
        maxBrakeForce: 1.25, handbrakeMultiplier: 1.6, maxSteeringAngle: Math.PI / 4,
        brakeBias: 0.66,
        camberDeg: [ - 0.5, - 0.5, - 0.3, - 0.3 ], toeDeg: [ 0, 0, 0.1, - 0.1 ],
        engineInertia: 0.14, clutchStiffness: 280, lsdLocking: 0.30,
        Cd: 0.0250, Cl: 0.0000,
        driveType: 'FWD',
        // Cheap-and-cheerful baseline: older 8 Hz ABS, sloppy auto detent,
        // soft suspension swallows kerbs, open diff = brief harmless wheelspin,
        // plastic-fizz rev limiter, firm progressive brake (66% nose bias).
        dsProfile: {
            revLimit:      { forceMin: 70, forceMax:  95, freq: 10, startPos: 70,  holdMs: 220, cooldownMs: 450 },
            shiftTick:     { forceMin: 35, forceMax:  60, startPos: 120, holdMs: 95 },
            wheelspin:     { forceMin: 45, forceMax:  70, freq:  9, startPos: 110, holdMs: 160, cooldownMs: 800, slipThreshold: 0.40 },
            slide:         { forceMin: 30, forceMax:  55, freq:  7, startPos: 85,  holdMs: 200, cooldownMs: 1000, slipThreshold: 0.46, speedKmhMin: 28 },
            abs:           { forceMin: 60, forceMax:  95, freq:  8, startPos: 30,  holdMs: 110, brakeThreshold: 0.32 },
            kerb:          { forceMin: 50, forceMax:  85, startPos: 65,  holdMs: 100, suspThreshold: 26000 },
            brakePressure: { forceMin: 30, forceMax: 100, startPos: 75,  deadzone: 0.50, ramp: 220, trailBonus: 38 }
        }
    },
    // Muscle V8 — 1700 kg Mustang GT class; heavy nose, fat low-end torque.
    // Easy to oversteer on throttle, lazy revs, body-roll, ~230 km/h.
    {
        name: 'Muscle V8',
        bodyColor: 0xB42020,
        soundFile: 'sounds/engines/muscle.mp3', soundLoopStart: 3.0,
        pitchMin: 0.6, pitchMax: 2.2,
        mass: 14, chassisFriction: 0.9,
        maxEngineForce: 130, engineIdleRpm: 750, engineRedline: 6800,
        peakTorqueRpm: 3500, torqueCurveWidth: 3000,
        gearRatios: [ 3.66, 2.43, 1.69, 1.32, 1.0, 0.79 ], reverseRatio: - 3.5, finalDrive: 3.55,
        autoUpshiftRpm: 5700, autoDownshiftRpm: 1900,
        wheelFrictionSlip: 2.55,
        suspensionStiffness: 23, suspensionCompression: 1.95, suspensionRelaxation: 2.35,
        suspensionRestLength: 0.42, wheelConnectionY: - 0.32,
        maxBrakeForce: 1.5, handbrakeMultiplier: 1.7, maxSteeringAngle: Math.PI / 4.2,
        brakeBias: 0.62,
        camberDeg: [ - 1, - 1, - 0.5, - 0.5 ], toeDeg: [ 0, 0, 0.1, - 0.1 ],
        engineInertia: 0.20, clutchStiffness: 340, lsdLocking: 0.55,
        Cd: 0.0235, Cl: 0.0000,
        driveType: 'RWD',
        // Lenient TC — muscle cars want to break the tyres loose on exit;
        // a strict TC would defeat the whole personality. Players who turn
        // TC ON still want it to drive, not strangle.
        tc: { slipThreshold: 0.20, minMult: 0.55, cutGain: 3.5 },
        // Burnout king: 5 Hz pushrod-V8 limiter thud (slowest in fleet),
        // ka-CLUNK shifts (deepest startPos, longest hold), wheelspin is the
        // signature cue (slipThreshold 0.26 + 7 Hz "burning rubber" rumble +
        // 320 ms hold so a sustained burnout reads as one event), long-throw
        // brake pedal with fleet's biggest trail bonus for 1700 kg drama.
        dsProfile: {
            revLimit:      { forceMin: 90, forceMax: 125, freq:  5, startPos: 45,  holdMs: 320, cooldownMs: 450 },
            shiftTick:     { forceMin: 55, forceMax:  95, startPos: 140, holdMs: 95 },
            wheelspin:     { forceMin: 75, forceMax: 108, freq:  7, startPos: 90,  holdMs: 320, cooldownMs: 550, slipThreshold: 0.26 },
            slide:         { forceMin: 45, forceMax:  80, freq:  8, startPos: 75,  holdMs: 260, cooldownMs: 750, slipThreshold: 0.34, speedKmhMin: 20 },
            abs:           { forceMin: 70, forceMax: 105, freq: 11, startPos: 30,  holdMs: 110, brakeThreshold: 0.30 },
            kerb:          { forceMin: 65, forceMax: 110, startPos: 55,  holdMs: 150, suspThreshold: 17000 },
            brakePressure: { forceMin: 25, forceMax: 100, startPos: 70,  deadzone: 0.48, ramp: 175, trailBonus: 45 }
        }
    },
    // Sport Flat-six — 1430 kg 911 GT3 class.
    // The driver's car: high-rev peaky power, sharp turn-in, rear rotation, ~290 km/h.
    {
        name: 'Sport Flat-six',
        bodyColor: 0xC8CDD2,
        soundFile: 'sounds/engines/sport.mp3', soundLoopStart: 3.0,
        pitchMin: 0.7, pitchMax: 3.2,
        mass: 11, chassisFriction: 0.95,
        maxEngineForce: 150, engineIdleRpm: 1100, engineRedline: 9200,
        peakTorqueRpm: 7000, torqueCurveWidth: 1900,
        gearRatios: [ 3.91, 2.29, 1.65, 1.30, 1.08, 0.88 ], reverseRatio: - 3.55, finalDrive: 3.97,
        autoUpshiftRpm: 8700, autoDownshiftRpm: 3400,
        wheelFrictionSlip: 3.5,
        suspensionStiffness: 38, suspensionCompression: 2.8, suspensionRelaxation: 3.0,
        suspensionRestLength: 0.28, wheelConnectionY: - 0.26,
        maxBrakeForce: 2.1, handbrakeMultiplier: 1.8, maxSteeringAngle: Math.PI / 4,
        brakeBias: 0.54,
        camberDeg: [ - 2.2, - 2.2, - 1.2, - 1.2 ], toeDeg: [ - 0.1, 0.1, 0.2, - 0.2 ],
        engineInertia: 0.07, clutchStiffness: 600, lsdLocking: 0.75,
        Cd: 0.0128, Cl: 0.0080,
        driveType: 'RWD',
        // GT3-style PSM — wide slip headroom, soft cuts. Real 911 TC barely
        // intervenes; the car is meant to be driven, the system catches the
        // genuine "about to spin" moment, not every exit oversteer.
        tc: { slipThreshold: 0.22, minMult: 0.60, cutGain: 3.0 },
        // The scalpel: 15 Hz electronic 9200 rpm scream (capped at protocol max),
        // crisp PDK paddle (startPos 150 — deepest, 55 ms hold — shortest),
        // 911 rear-rotation slide cue at low threshold (0.34) and fast 10 Hz
        // onset, carbon-ceramic ABS at protocol max 15 Hz with 80 ms hold,
        // stiff short-travel suspension means every kerb registers (16 kN).
        dsProfile: {
            revLimit:      { forceMin: 90, forceMax: 125, freq: 15, startPos: 70,  holdMs: 200, cooldownMs: 350 },
            shiftTick:     { forceMin: 55, forceMax:  95, startPos: 150, holdMs: 55 },
            wheelspin:     { forceMin: 60, forceMax: 100, freq: 13, startPos: 115, holdMs: 180, cooldownMs: 650, slipThreshold: 0.38 },
            slide:         { forceMin: 35, forceMax:  70, freq: 10, startPos: 85,  holdMs: 190, cooldownMs: 800, slipThreshold: 0.34, speedKmhMin: 25 },
            abs:           { forceMin: 75, forceMax: 110, freq: 15, startPos: 22,  holdMs: 80,  brakeThreshold: 0.28 },
            kerb:          { forceMin: 65, forceMax: 110, startPos: 65,  holdMs: 95,  suspThreshold: 16000 },
            brakePressure: { forceMin: 25, forceMax: 100, startPos: 85,  deadzone: 0.50, ramp: 220, trailBonus: 32 }
        }
    },
    // Rally Turbo — WRX STI class; AWD-feel grip, broad turbo plateau.
    // Strong AWD launch, soft long-travel for bumps, biggest handbrake for Scandi flicks, ~250 km/h.
    {
        name: 'Rally Turbo',
        bodyColor: 0x1F4DFF,
        soundFile: 'sounds/engines/rally.mp3', soundLoopStart: 3.0,
        pitchMin: 0.65, pitchMax: 2.9,
        mass: 11, chassisFriction: 0.95,
        maxEngineForce: 135, engineIdleRpm: 900, engineRedline: 7800,
        peakTorqueRpm: 3400, torqueCurveWidth: 3400,
        gearRatios: [ 3.64, 2.37, 1.76, 1.35, 1.06, 0.84 ], reverseRatio: - 3.55, finalDrive: 3.90,
        autoUpshiftRpm: 6700, autoDownshiftRpm: 2700,
        wheelFrictionSlip: 3.05,
        suspensionStiffness: 26, suspensionCompression: 2.1, suspensionRelaxation: 2.5,
        suspensionRestLength: 0.48, wheelConnectionY: - 0.34,
        maxBrakeForce: 1.8, handbrakeMultiplier: 2.4, maxSteeringAngle: Math.PI / 3.8,
        brakeBias: 0.58,
        camberDeg: [ - 1.2, - 1.2, - 1.0, - 1.0 ], toeDeg: [ 0, 0, 0.1, - 0.1 ],
        engineInertia: 0.12, clutchStiffness: 460, lsdLocking: 0.90,
        Cd: 0.0290, Cl: 0.0030,
        driveType: 'AWD',
        // AWD launch needs throttle — all four wheels share the load and
        // an aggressive TC would defeat the launch advantage. Wide threshold
        // + high floor so the car puts power down hard out of corners.
        tc: { slipThreshold: 0.24, minMult: 0.60, cutGain: 3.0 },
        // Gravel-spec all-rounder: AWD wheelspin is brief 11 Hz "all-four
        // clawing" texture starting at low startPos (felt across pull), slide
        // is the signature (early threshold 0.32 + long 280 ms hold for Scandi
        // flicks), longest-travel suspension absorbs kerbs (32 kN threshold —
        // higher than Hatchback's 26 kN because Rally has 0.48 restLength
        // vs Hatchback's 0.42, genuinely soaks more), gritty 9 Hz ABS like
        // brakes fighting loose surface, strong trail bonus.
        dsProfile: {
            revLimit:      { forceMin: 85, forceMax: 120, freq: 12, startPos: 55,  holdMs: 280, cooldownMs: 420 },
            shiftTick:     { forceMin: 55, forceMax:  95, startPos: 125, holdMs: 85 },
            wheelspin:     { forceMin: 60, forceMax:  95, freq: 11, startPos: 55,  holdMs: 160, cooldownMs: 850, slipThreshold: 0.32 },
            slide:         { forceMin: 45, forceMax:  75, freq:  7, startPos: 65,  holdMs: 280, cooldownMs: 700, slipThreshold: 0.32, speedKmhMin: 20 },
            abs:           { forceMin: 65, forceMax: 105, freq:  9, startPos: 30,  holdMs: 120, brakeThreshold: 0.28 },
            kerb:          { forceMin: 55, forceMax:  95, startPos: 65,  holdMs: 85,  suspThreshold: 32000 },
            brakePressure: { forceMin: 22, forceMax:  90, startPos: 85,  deadzone: 0.50, ramp: 180, trailBonus: 42 }
        }
    },
    // Supercar V12 — Ferrari 812 class.
    // Broad NA V12, lazy spin-up (heavy crank), top-end heavy hitter, ~330 km/h.
    {
        name: 'Supercar V12',
        bodyColor: 0xFF6F1A,
        soundFile: 'sounds/engines/supercar.mp3', soundLoopStart: 3.0,
        pitchMin: 0.7, pitchMax: 3.4,
        mass: 12, chassisFriction: 0.95,
        maxEngineForce: 185, engineIdleRpm: 1000, engineRedline: 9000,
        peakTorqueRpm: 6500, torqueCurveWidth: 3200,
        gearRatios: [ 3.08, 2.19, 1.63, 1.29, 1.03, 0.84, 0.69 ], reverseRatio: - 2.9, finalDrive: 4.10,
        autoUpshiftRpm: 8500, autoDownshiftRpm: 3200,
        wheelFrictionSlip: 3.4,
        suspensionStiffness: 34, suspensionCompression: 2.6, suspensionRelaxation: 2.9,
        suspensionRestLength: 0.28, wheelConnectionY: - 0.25,
        maxBrakeForce: 2.2, handbrakeMultiplier: 1.8, maxSteeringAngle: Math.PI / 4,
        brakeBias: 0.57,
        camberDeg: [ - 1.8, - 1.8, - 1.0, - 1.0 ], toeDeg: [ - 0.1, 0.1, 0.2, - 0.2 ],
        engineInertia: 0.13, clutchStiffness: 620, lsdLocking: 0.80,
        Cd: 0.0182, Cl: 0.0140,
        driveType: 'RWD',
        // Sophisticated TC, similar to 911. The car has the power to break
        // tyres loose on demand but the system catches genuine spin events
        // without choking the player on every throttle blip.
        tc: { slipThreshold: 0.22, minMult: 0.60, cutGain: 3.0 },
        // Italian cathedral: V12 rev limiter is a deliberate 12 Hz "shoulder
        // tap" with long 300 ms hold (heavy crank inertia), dual-clutch shift
        // is sharp at deep startPos (145) with 55 ms snap, broad torque means
        // wheelspin happens at higher slip threshold (0.40) but dramatically,
        // carbon ceramic ABS at 15 Hz crisp, GT3-style controllable slide cue.
        dsProfile: {
            revLimit:      { forceMin: 80, forceMax: 115, freq: 12, startPos: 65,  holdMs: 300, cooldownMs: 420 },
            shiftTick:     { forceMin: 55, forceMax:  95, startPos: 145, holdMs: 55 },
            wheelspin:     { forceMin: 65, forceMax: 105, freq: 11, startPos: 110, holdMs: 240, cooldownMs: 750, slipThreshold: 0.40 },
            slide:         { forceMin: 40, forceMax:  75, freq:  9, startPos: 85,  holdMs: 240, cooldownMs: 850, slipThreshold: 0.42, speedKmhMin: 35 },
            abs:           { forceMin: 70, forceMax: 108, freq: 15, startPos: 22,  holdMs: 90,  brakeThreshold: 0.30 },
            kerb:          { forceMin: 65, forceMax: 108, startPos: 62,  holdMs: 105, suspThreshold: 21000 },
            brakePressure: { forceMin: 25, forceMax:  98, startPos: 82,  deadzone: 0.52, ramp: 205, trailBonus: 28 }
        }
    },
    // F1 — V10-era open-wheeler tuned FOR THIS ENGINE, not for a sim.
    // Rationale: in our physics, mass=5 + force=235 + stiff/low suspension
    // produced ~20g RWD wheelspin on every throttle blip and snap-oversteer
    // off any kerb. Re-targeted to "demanding but drivable" — heaviest car
    // in the fleet by power-to-mass is still F1, but the chassis now has
    // enough suspension travel + forgiving toe/camber + progressive throttle
    // (engineInertia up, torque band wider) that the player can actually
    // attack corners. Aero still dominates above 200 km/h. ~330–345 km/h.
    {
        name: 'F1',
        bodyColor: 0xD11A1A,
        soundFile: 'sounds/engines/f1.mp3', soundLoopStart: 3.0,
        pitchMin: 1.0, pitchMax: 4.0,
        mass: 7, chassisFriction: 0.95,
        maxEngineForce: 200, engineIdleRpm: 4500, engineRedline: 17500,
        peakTorqueRpm: 12000, torqueCurveWidth: 4500,
        gearRatios: [ 2.90, 2.20, 1.75, 1.42, 1.18, 1.0, 0.86, 0.74 ], reverseRatio: - 2.5, finalDrive: 4.0,
        autoUpshiftRpm: 16500, autoDownshiftRpm: 6500,
        wheelFrictionSlip: 4.6,
        suspensionStiffness: 44, suspensionCompression: 3.0, suspensionRelaxation: 3.3,
        suspensionRestLength: 0.22, wheelConnectionY: - 0.22,
        maxBrakeForce: 3.2, handbrakeMultiplier: 1.4, maxSteeringAngle: Math.PI / 5.0,
        brakeBias: 0.62,
        camberDeg: [ - 2.5, - 2.5, - 1.5, - 1.5 ], toeDeg: [ - 0.1, 0.1, 0.15, - 0.15 ],
        engineInertia: 0.07, clutchStiffness: 800, lsdLocking: 1.00,
        Cd: 0.0190, Cl: 0.0420,
        driveType: 'RWD',
        // Real F1 TC (when it existed) was barely perceptible — the system
        // managed wheelspin without the driver feeling it. Very wide slip
        // headroom + high floor so the car launches like an F1 car should.
        tc: { slipThreshold: 0.28, minMult: 0.75, cutGain: 2.5 },
        // Knife-edge: 15 Hz 17,500 rpm electronic scream (protocol-capped),
        // revLimit cooldown 220 ms tucks just under the 200 ms hold so a held
        // redline scream reads as continuous rather than 1.8 Hz on/off pattern.
        // Seamless paddle = near-invisible 35 ms blip at deepest startPos
        // (200), spool diff fires wheelspin at low 0.22 slip (instant on/off),
        // fast 11 Hz slide cue with low 0.30 threshold (milliseconds to react),
        // sharp kerbs through 22 mm travel (22 kN threshold — bumped from 8 kN
        // which was false-firing on any moderate compression in our physics,
        // hard-landing cue covers genuine bottom-outs separately), ferocious
        // 15 Hz ABS at 70 ms, brake bites at 40% deadzone with tall ramp.
        dsProfile: {
            revLimit:      { forceMin: 90, forceMax: 125, freq: 15, startPos: 70,  holdMs: 200, cooldownMs: 220 },
            shiftTick:     { forceMin: 40, forceMax:  60, startPos: 200, holdMs: 35 },
            wheelspin:     { forceMin: 60, forceMax:  95, freq: 13, startPos: 120, holdMs: 160, cooldownMs: 550, slipThreshold: 0.22 },
            slide:         { forceMin: 45, forceMax:  75, freq: 11, startPos: 90,  holdMs: 170, cooldownMs: 550, slipThreshold: 0.30, speedKmhMin: 30 },
            abs:           { forceMin: 75, forceMax: 110, freq: 15, startPos: 30,  holdMs: 70,  brakeThreshold: 0.25 },
            kerb:          { forceMin: 70, forceMax: 120, startPos: 70,  holdMs: 90,  suspThreshold: 22000 },
            brakePressure: { forceMin: 30, forceMax: 100, startPos: 90,  deadzone: 0.40, ramp: 200, trailBonus: 25 }
        }
    },
    // God Car — physically impossible: max grip, 10 gears, flat torque, near-instant stops.
    // Easy-mode tank, forgives every input, ~400+ km/h, perfect balance.
    // De-twitched: was mass 5 + force 300 + engineInertia 0.04 + susp stiffness 48,
    // which produced ~6g longitudinal accel and a knife-edge chassis with zero
    // roll telegraph. Doubled the mass + raised the flywheel + softened the
    // suspension so the player can read what the car is doing and the assists
    // have something to bite into. Top-end perf preserved by raising downforce
    // and trimming engine force only modestly relative to the mass increase.
    {
        name: 'God Car',
        bodyColor: 0xF0F0F8,
        soundFile: 'sounds/engines/god.mp3', soundLoopStart: 3.0,
        pitchMin: 0.4, pitchMax: 4.5,
        mass: 10, chassisFriction: 1.0,
        maxEngineForce: 240, engineIdleRpm: 1000, engineRedline: 20000,
        peakTorqueRpm: 10000, torqueCurveWidth: 9000,
        gearRatios: [ 3.2, 2.6, 2.1, 1.75, 1.45, 1.2, 1.0, 0.85, 0.72, 0.6 ], reverseRatio: - 3.0, finalDrive: 4.0,
        autoUpshiftRpm: 19000, autoDownshiftRpm: 2500,
        wheelFrictionSlip: 5.5,
        suspensionStiffness: 32, suspensionCompression: 2.5, suspensionRelaxation: 2.7,
        suspensionRestLength: 0.32, wheelConnectionY: - 0.28,
        maxBrakeForce: 4.8, handbrakeMultiplier: 2.0, maxSteeringAngle: Math.PI / 4.6,
        brakeBias: 0.55,
        camberDeg: [ - 2, - 2, - 1, - 1 ], toeDeg: [ 0, 0, 0.05, - 0.05 ],
        engineInertia: 0.18, clutchStiffness: 900, lsdLocking: 0.90,
        Cd: 0.0165, Cl: 0.0850,
        driveType: 'AWD',
        // Fantasy car — TC is "smart enough" to never actually limit you.
        // High threshold + 80% floor means the only thing TC ever does is
        // shave a sliver of torque off the genuinely catastrophic moments.
        tc: { slipThreshold: 0.32, minMult: 0.80, cutGain: 2.0 },
        // Fantasy fastest-in-fleet: synthetic + surgical. 15 Hz screams at
        // the protocol ceiling (rev + ABS), 10-speed shifts are 30 ms micro-
        // blips at startPos 175, magic tyres mean wheelspin/slide thresholds
        // sit high (0.50 / 0.52 — "you broke physics" alarms), brake bites at
        // 45% with steep ramp + low 22 trail bonus (perfect balance, no drama).
        dsProfile: {
            revLimit:      { forceMin: 90, forceMax: 125, freq: 15, startPos: 70,  holdMs: 180, cooldownMs: 380 },
            shiftTick:     { forceMin: 35, forceMax:  50, startPos: 175, holdMs: 30 },
            wheelspin:     { forceMin: 55, forceMax:  90, freq: 14, startPos: 120, holdMs: 140, cooldownMs: 1100, slipThreshold: 0.50 },
            slide:         { forceMin: 40, forceMax:  65, freq: 11, startPos: 100, holdMs: 180, cooldownMs: 1200, slipThreshold: 0.52, speedKmhMin: 45 },
            abs:           { forceMin: 75, forceMax: 105, freq: 15, startPos: 20,  holdMs: 60,  brakeThreshold: 0.25 },
            kerb:          { forceMin: 55, forceMax:  95, startPos: 70,  holdMs: 90,  suspThreshold: 28000 },
            brakePressure: { forceMin: 25, forceMax:  95, startPos: 75,  deadzone: 0.45, ramp: 175, trailBonus: 22 }
        }
    }
];

let currentCarIndex = 0;
let currentCar = CARS[ 0 ];
let carVisualsGroup = null;
let carToastEl = null;
let carBadgeEl = null;

// Per-car cockpit / driver-POV configuration (from the planning subagent).
// Each entry maps the car name to:
//   cockpitOffset: chassis-local camera position (driver seat)
//   cockpitLookOffset: chassis-local point the camera looks at
//   steeringWheelOffset: chassis-local mount point of the wheel mesh
//   steeringWheelTilt: x-rotation of the wheel parent group (radians)
//   fov: degrees, used while POV is active (no speed-FOV boost in POV)
//   wheelRotationMultiplier: visual wheel spin per radian of front-tyre steer
const COCKPITS = {
    'Hatchback':      { cockpitOffset:{x:-0.38,y:0.32,z:0.10}, cockpitLookOffset:{x:-0.38,y:0.30,z:-1.10}, steeringWheelOffset:{x:-0.38,y:0.10,z:-0.55}, steeringWheelTilt:0.35, fov:78, wheelRotationMultiplier:7.0 },
    'Muscle V8':      { cockpitOffset:{x:-0.42,y:0.28,z:0.30}, cockpitLookOffset:{x:-0.42,y:0.26,z:-0.95}, steeringWheelOffset:{x:-0.42,y:0.05,z:-0.40}, steeringWheelTilt:0.30, fov:76, wheelRotationMultiplier:6.5 },
    'Sport Flat-six': { cockpitOffset:{x:-0.40,y:0.18,z:0.20}, cockpitLookOffset:{x:-0.40,y:0.16,z:-1.05}, steeringWheelOffset:{x:-0.40,y:-0.02,z:-0.50}, steeringWheelTilt:0.38, fov:77, wheelRotationMultiplier:7.0 },
    'Rally Turbo':    { cockpitOffset:{x:-0.40,y:0.42,z:0.15}, cockpitLookOffset:{x:-0.40,y:0.38,z:-1.20}, steeringWheelOffset:{x:-0.40,y:0.20,z:-0.55}, steeringWheelTilt:0.40, fov:80, wheelRotationMultiplier:7.5 },
    'Supercar V12':   { cockpitOffset:{x:-0.36,y:0.10,z:0.05}, cockpitLookOffset:{x:-0.36,y:0.08,z:-1.30}, steeringWheelOffset:{x:-0.36,y:-0.10,z:-0.55}, steeringWheelTilt:0.45, fov:79, wheelRotationMultiplier:6.0 },
    'F1':             { cockpitOffset:{x:0.00,y:0.08,z:0.40},  cockpitLookOffset:{x:0.00,y:0.05,z:-2.10},  steeringWheelOffset:{x:0.00,y:-0.05,z:-0.20}, steeringWheelTilt:1.22, fov:90, wheelRotationMultiplier:6.0 },
    'God Car':        { cockpitOffset:{x:0.00,y:0.25,z:0.00},  cockpitLookOffset:{x:0.00,y:0.22,z:-1.80},  steeringWheelOffset:{x:0.00,y:0.05,z:-0.65}, steeringWheelTilt:0.52, fov:85, wheelRotationMultiplier:8.0 }
};

let cameraMode = 'chase'; // 'chase' | 'pov' | 'free'
let steeringWheelGroup = null;   // tilted parent (chassis-local)
let steeringWheelMesh = null;    // rotates each frame on Z

const MINIMAP_LAYER = 2; // dedicated three.js layer for objects only the minimap should see
const minimap = {
    enabled: false,
    containerEl: null,
    canvas: null,
    renderer: null,
    camera: null,
    toggleBtn: null,
    marker: null,
    // DOM dot per remote peer, positioned each frame in renderMinimap().
    // Map peerId -> { el, color }. Created in peerJoin / removed in peerLeave.
    peerDots: new Map()
};

// Gamepad state — populated each frame in pollGamepad if one is plugged in.
const gamepad = {
    index: - 1,
    id: '',
    prevButtons: []
};

// Classify the active pad so the cheatsheet can show vendor-correct labels.
// Button wiring (pollGamepad) is the standard Gamepad API mapping for both
// vendors — only the on-screen labels change.
function controllerKind() {

    if ( gamepad.index < 0 ) return 'none';
    const id = ( gamepad.id || '' ).toLowerCase();
    const psHints = [ 'dualsense', 'dualshock', 'playstation', 'ps3', 'ps4', 'ps5', '054c', '0810' ];
    for ( const hint of psHints ) {

        if ( id.includes( hint ) ) return 'ps';

    }
    return 'xbox';

}

// Spawn pose captured live from driving the car onto the road and pressing P.
// Mutated by swapMap() so the chassis-reset code path (input.reset) always
// reads the active map's spawn.
const spawnPoint = new THREE.Vector3( 3147.90, - 80.45, - 2733.54 );
const spawnQuaternion = new THREE.Quaternion( - 0.0046, - 0.5791, 0.0216, 0.8150 );

// Maps the player can hot-swap with the number keys 1 / 2. Each entry owns
// its own glb path + spawn pose; swapMap(id) copies that pose into
// spawnPoint / spawnQuaternion above and reloads the track.
const MAPS = {
    nurburgring: {
        label: 'Nürburgring (Nordschleife)',
        path: 'textures/models/nurburgring.glb',
        spawnPos: { x: 3147.90, y: - 80.45, z: - 2733.54 },
        spawnRot: { x: - 0.0046, y: - 0.5791, z: 0.0216, w: 0.8150 },
        // Asphalt material(s) used by the road-detection raycast. The GLB
        // has only 3 merged materials ("Material" / "default" / "default_1"),
        // and the whole drivable Nordschleife loop shares "Material". Press X
        // in-game to enumerate any extras (e.g. pit lane / GP-link tarmac).
        roadMaterials: [ 'Material' ]
    },
    nurburgring_gp: {
        label: 'Nürburgring GP (2022 layout)',
        path: 'textures/models/nurburgring_gp.glb',
        // 2× — compact GP layout, car feels appropriately sized against it.
        scale: 2,
        // Captured pose from the 5.5× session, rescaled by 2/5.5 so the
        // car still lands on the same on-asphalt point at the new scale.
        // Press P on-track if you want a tighter spawn.
        spawnPos: { x: 26.17, y: 26.07, z: 1219.19 },
        spawnRot: { x: 0.0037, y: - 0.0175, z: 0.0121, w: - 0.9998 },
        // GLB packs 70 atlased materials with cryptic batch names; the main
        // GP racing surface is index 56 ("Esdanurburgring2022681Mtl"). If we
        // need pit lane or off-line tarmac later, X-pick more and append.
        roadMaterials: [ 'Esdanurburgring2022681Mtl' ]
    },
    spa: {
        // Spa-Francorchamps 1992 layout — community GLB with embedded
        // PBR textures (~22 MB). The 14 km × 14 km map has ~5000 chunks
        // so we MUST distance-cull or FPS dies; DoF then hides the cull
        // edge by softening just the far horizon.
        //
        // BokehShader math (see node_modules/three/.../BokehShader.js):
        //   factor   = focus + viewZ              // viewZ = -distance (m)
        //   dofblur  = clamp(factor*aperture, ±maxblur)
        // so blur is symmetric around `focus` metres in front of the
        // camera, ramps linearly with distance-from-focus, and saturates
        // at `maxblur` (a UV-space kernel radius, ~screen fraction).
        //
        // The previous values (focus 800, aperture 3e-5, maxblur 0.008)
        // saturated the kernel for anything closer than ~530 m, so the
        // car (≈10 m), tarmac, and kerbs all rendered at max blur — the
        // entire frame was soft. New values place focus right at the
        // chase-cam distance, then ramp the CoC so 1200 m hits the
        // maxblur clamp just before the 1500 m chunk-cull boundary:
        //   D=10 m  → ~ 0.10 px  (crisp player car)
        //   D=50 m  → ~ 0.10 px  (crisp tarmac)
        //   D=300 m → ~ 1.5 px   (slightly soft buildings)
        //   D=800 m → ~ 4   px   (clearly soft far horizon)
        //   D≥1200 m → maxblur   (hides the cull edge)
        label: 'Spa-Francorchamps (1992)',
        path: 'textures/models/spa.glb',
        spawnPos: { x: - 2881.70, y: 81.22, z: 2612.47 },
        spawnRot: { x: 0.0188, y: - 0.1562, z: - 0.0036, w: - 0.9875 },
        renderRadius: 1500,
        dof: { focus: 30, aperture: 0.0000051, maxblur: 0.006 },
        carScale: 1.5,
        // Spa community GLB splits the track into ~9 asphalt materials.
        // road1x (confirmed via X-pick) is the main racing surface; the
        // rest are pit lane, joining sections, and the old-layout stub.
        // Excluded: "Meshesroadrmblb/c" (rumble strip kerbs) and
        // "Meshesroadroadgrdx" (looks like guard-rail trim, not tarmac).
        roadMaterials: [
            'Meshesroadroad1x0171Mtl',
            'Meshesroadroad2x1Mtl',
            'Meshesroadroad3x0091Mtl',
            'Meshesroadroadjx1Mtl',
            'Meshesroadroadb0021Mtl',
            'Meshesroadroadrold0021Mtl',
            'Meshesroadroadrold20051Mtl',
            'Meshesroadpitroadpit1Mtl',
            'Meshesgrassxroadpitf1Mtl',
            'Meshesgrassxroadl0011Mtl'
        ]
    },
    suzuka: {
        // Suzuka Circuit 2001 layout — community GLB (~95 MB) with
        // embedded textures. Same optimisation profile as Spa: chunk
        // culling + DoF + 1.5× car scale. Spawn pose will be updated
        // after the user captures one with P on the main straight.
        label: 'Suzuka Circuit (2001)',
        path: 'textures/models/suzuka.glb',
        spawnPos: { x: 505.02, y: - 5.37, z: 504.37 },
        spawnRot: { x: 0.0026, y: - 0.9995, z: - 0.0158, w: 0.0257 },
        renderRadius: 1500,
        dof: { focus: 30, aperture: 0.0000051, maxblur: 0.006 },
        carScale: 0.945,
        // Junk meshes baked into the community GLB (debug cubes, leftover
        // placeholders). Any mesh whose centre is within `radius` of one of
        // these world-space points gets hidden + has no trimesh collider.
        excludeMeshesNear: [
            { x: - 135.47, y: 10.35, z: - 152.55, radius: 4 }
        ],
        // Per-material visual overrides applied at load time. The community
        // GLB ships some materials with placeholder / debug textures
        // (NODE.001 = a 128² yellow-bg UV-check card with TOP / no-entry /
        // FRONTAL symbols, mapped onto every grandstand seating section so
        // the stands look like a colour test pattern). We can't delete the
        // geometry (one shared primitive across ~all stands), so we strip
        // its baseColorTexture and force a concrete-grey baseColorFactor.
        materialOverrides: {
            'NODE.001': { removeMap: true, color: 0x707276 }
        },
        // Materials whose meshes should be kept VISUAL but skipped from the
        // trimesh collider. The NODE.001 mesh has a rogue cube on the racing
        // line that survived the GLB strip pass — we leave it visible (still
        // grey) but the car drives through it. Grandstand seats elsewhere
        // also become non-collidable, which is fine — players don't drive
        // into stands and if they do, clipping is better than a wall.
        nonCollidableMaterials: [ 'NODE.001' ],
        // Suzuka GLB splits the track into ROAD01..ROAD07 + variants for the
        // pit lane and pit-line markings. ROAD01 (confirmed via X-pick) is
        // the main straight. Excluded: RMBL* (rumble), SKID* (skid marks
        // overlay), GRVL* (gravel run-off), ROAD_RK_GREEN04 (green kerb).
        roadMaterials: [
            'ROAD01',
            'ROAD02',
            'ROAD03',
            'ROAD04',
            'ROAD05',
            'ROAD06',
            'ROAD07',
            'ROADD',
            'ROADX',
            'PITROAD',
            'RDPITLTA',
            'YLOPITLTA',
            'PITEXITLINE'
        ]
    },
};
let currentMapId = 'nurburgring';
let mapSwapInFlight = false;
// Stored once so we can keep the directional light a fixed offset from the car.
// Values match the original three.js example exactly: light sits 12.5 up and
// 12.5 forward, giving a ~45° sun angle.
const sunOffset = new THREE.Vector3( 0, 12.5, 12.5 );

// FPS lock state. `target` is decided after a brief refresh-rate detection
// (see detectRefreshRate). We render at most once per `frameInterval` ms;
// physics is initialized at the same rate to keep them in lockstep.
const fpsTarget = {
    target: 60,
    frameInterval: 1000 / 60,
    lastRenderTime: 0,
    // adaptive downgrade: if we miss the target for too many frames in a row,
    // drop from 120 → 60 so the player gets a stable, consistent feel
    overBudgetStreak: 0,
    overBudgetThreshold: 60
};

const chaseCam = {
    enabled: true,
    positionOffset: new THREE.Vector3( 0, 2.6, 7.5 ),
    lookOffset: new THREE.Vector3( 0, 1.1, - 3 ),
    positionDamping: 6,
    lookDamping: 9,
    baseFov: 60,
    maxFovBoost: 14,
    speedForMaxFov: 28,
    fovDamping: 4,
    currentLookAt: new THREE.Vector3(),
    initialized: false
};

init();

async function init() {

    scene = new THREE.Scene();
    // Fallback flat colour while the HDR streams in (avoids a black flash).
    scene.background = new THREE.Color( 0xbfd1e5 );

    // Equirectangular HDR — used as visible background only. We deliberately
    // do NOT assign it to scene.environment because that floods every PBR
    // material with indirect lighting and washes out the punchy direct-sun
    // look the hemisphere + DirectionalLight pair was giving.
    new RGBELoader().load( import.meta.env.BASE_URL + 'textures/sky.hdr', ( texture ) => {

        texture.mapping = THREE.EquirectangularReflectionMapping;
        scene.background = texture;
        // HDR comes through brighter than SDR backgrounds — dial it down so the
        // sky doesn't blow out the rest of the scene.
        scene.backgroundIntensity = 0.45;

    } );

    // Far plane bumped from 200 → 12000 because the track is ~6km across.
    camera = new THREE.PerspectiveCamera( chaseCam.baseFov, window.innerWidth / window.innerHeight, 0.1, 12000 );
    camera.position.set( 0, 4, 10 );

    const ambient = new THREE.HemisphereLight( 0x555555, 0xFFFFFF );
    scene.add( ambient );

    // Matches the original three.js example one-for-one, including radius/blurSamples
    // (the user wanted the look back). The light + shadow frustum still follow the
    // car every frame so shadows actually land somewhere on the 6km track.
    sunLight = new THREE.DirectionalLight( 0xffffff, 4 );
    sunLight.position.copy( sunOffset );
    sunLight.castShadow = true;
    sunLight.shadow.radius = 3;
    sunLight.shadow.blurSamples = 8;
    sunLight.shadow.mapSize.width = 2048;
    sunLight.shadow.mapSize.height = 2048;

    const shadowSize = 40;
    sunLight.shadow.camera.left = - shadowSize;
    sunLight.shadow.camera.bottom = - shadowSize;
    sunLight.shadow.camera.right = shadowSize;
    sunLight.shadow.camera.top = shadowSize;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 50;
    scene.add( sunLight );

    sunTarget = new THREE.Object3D();
    scene.add( sunTarget );
    sunLight.target = sunTarget;

    renderer = new THREE.WebGLRenderer( { antialias: true } );
    renderer.setPixelRatio( window.devicePixelRatio );
    renderer.setSize( window.innerWidth, window.innerHeight );
    renderer.shadowMap.enabled = true;
    document.body.appendChild( renderer.domElement );
    renderer.setAnimationLoop( animate );

    controls = new OrbitControls( camera, renderer.domElement );
    controls.target = new THREE.Vector3( 0, 2, 0 );
    controls.enabled = ! chaseCam.enabled;
    controls.update();

    clock = new THREE.Clock();

    stats = new Stats();
    stats.dom.classList.add( 'desktop-only' );
    document.body.appendChild( stats.dom );

    fpsLabel = document.createElement( 'div' );
    fpsLabel.className = 'fps-pill-desktop';
    fpsLabel.style.cssText = 'position:absolute;bottom:10px;left:10px;padding:4px 8px;background:rgba(0,0,0,0.55);color:#fff;font:12px Monospace;border-radius:4px;z-index:1';
    fpsLabel.textContent = 'detecting refresh rate...';
    document.body.appendChild( fpsLabel );

    posLabel = document.createElement( 'div' );
    posLabel.className = 'pos-label-desktop';
    posLabel.style.cssText = 'position:absolute;bottom:10px;right:10px;padding:4px 8px;background:rgba(0,0,0,0.55);color:#fff;font:12px Monospace;border-radius:4px;z-index:1;min-width:220px;text-align:right';
    posLabel.textContent = 'pos: —     (P to copy)';
    document.body.appendChild( posLabel );

    const detectedHz = await detectRefreshRate();
    fpsTarget.target = detectedHz >= 100 ? 120 : 60;
    fpsTarget.frameInterval = 1000 / fpsTarget.target;
    fpsLabel.textContent = `display ~${ detectedHz.toFixed( 0 ) }Hz · locked ${ fpsTarget.target }fps`;

    await initPhysics();

    onWindowResize();

    initSpeedometer();
    initStatsForNerds();
    initTouchControls();
    initCarToast();
    initMinimap();
    initLapTimer();
    initMultiplayer();
    initSkidMarks();
    initVolumeSlider();
    initRumbleSlider();
    initDualsenseButton();
    renderControlsCheatsheet();
    _positionStatsBelowInfo();
    window.addEventListener( 'resize', _positionStatsBelowInfo );
    // Final mobile layout pass — runs even when not touchOnly so the
    // .is-mobile / .is-portrait body classes are correctly absent on
    // desktop. Also wires the hamburger drawer if applicable.
    applyMobileLayout();

    // Audio cannot autoplay without a user gesture — browsers block it. We
    // listen broadly so *any* interaction (key, click, tap, scroll, focus)
    // unlocks the AudioContext without forcing the user to find the slider.
    // startAudio() is idempotent and also re-resumes a suspended context, so
    // we don't use { once: true }.
    const unlockAudio = () => { startAudio(); };
    const unlockEvents = [ 'keydown', 'pointerdown', 'mousedown', 'click', 'touchstart', 'wheel' ];
    for ( const ev of unlockEvents ) window.addEventListener( ev, unlockAudio, { passive: true } );
    window.addEventListener( 'focus', unlockAudio );

    window.addEventListener( 'keydown', ( event ) => {

        if ( event.repeat ) return; // edges only for some actions; held state for pedals tracked below

        // First real keystroke means there's a physical keyboard — flip out
        // of mobile mode on touchscreen laptops where _isTouchOnlyDevice()
        // matched on first paint.
        if ( ! device.keyboardSeen ) {

            device.keyboardSeen = true;
            if ( device.touchOnly ) {

                _updateDeviceState();
                applyMobileLayout();

            }

        }

        const k = event.key;
        if ( k === 'w' || k === 'W' ) input.keyW = true;
        if ( k === 's' || k === 'S' ) input.keyS = true;
        if ( k === 'a' || k === 'A' ) input.keyA = true;
        if ( k === 'd' || k === 'D' ) input.keyD = true;
        if ( k === 'e' || k === 'E' ) input.keyE = true;
        if ( k === 'ArrowUp' ) input.arrowUp = true;
        if ( k === 'ArrowDown' ) input.arrowDown = true;
        if ( k === 'ArrowLeft' ) input.arrowLeft = true;
        if ( k === 'ArrowRight' ) input.arrowRight = true;
        if ( k === 'r' || k === 'R' ) input.keyR = true;
        if ( k === ' ' ) input.keySpace = true;

        // Manual shift edges — Art-of-Rally style: LShift up, LCtrl down.
        if ( k === 'Shift' && transmission.mode === 'manual' ) manualShift( 1 );
        if ( k === 'Control' && transmission.mode === 'manual' ) manualShift( - 1 );

        if ( k === 'm' || k === 'M' ) toggleTransmissionMode();
        if ( k === 'q' || k === 'Q' ) cycleCar( 1 );
        if ( k === '1' ) swapMap( 'nurburgring' );
        if ( k === '2' ) swapMap( 'nurburgring_gp' );
        if ( k === '3' ) swapMap( 'spa' );
        if ( k === '4' ) swapMap( 'suzuka' );
        if ( k === 'F3' ) { event.preventDefault(); toggleStatsForNerds(); }

        if ( k === 'c' || k === 'C' ) cycleCameraMode();

        // X — raycast through the centre of the screen and dump the
        // material name + world position of whatever's hit. Used to
        // identify random junk meshes baked into community track GLBs
        // so they can be added to the per-map excludeMeshesNear list.
        if ( k === 'x' || k === 'X' ) pickMeshAtCrosshair();

        // L — toggle AI drive. Loads the per-map racing line, paints the car
        // purple, draws an F1-style line overlay above the road. Any human
        // input cancels AI mode (handled in aiUpdate).
        if ( k === 'l' || k === 'L' ) toggleAiMode();

        if ( k === 'h' || k === 'H' ) {

            if ( physicsHelper ) physicsHelper.visible = ! physicsHelper.visible;

        }

        if ( k === 't' || k === 'T' ) {

            if ( ! telemetry.recording ) startTelemetryRecording();
            else stopTelemetryRecording( /* download */ true );

        }

        if ( k === 'b' || k === 'B' ) toggleAbs();
        if ( k === 'n' || k === 'N' ) toggleTractionControl();

        if ( k === 'p' || k === 'P' ) {

            if ( ! chassis ) return;
            const t = chassis.translation();
            const r = chassis.rotation();
            const str = `pos ${ t.x.toFixed( 2 ) }, ${ t.y.toFixed( 2 ) }, ${ t.z.toFixed( 2 ) } | rot ${ r.x.toFixed( 4 ) }, ${ r.y.toFixed( 4 ) }, ${ r.z.toFixed( 4 ) }, ${ r.w.toFixed( 4 ) }`;
            console.log( '[snapshot]', str );
            navigator.clipboard?.writeText( str ).then( () => {

                if ( posLabel ) {

                    const prev = posLabel.style.background;
                    posLabel.style.background = 'rgba(40,160,80,0.85)';
                    setTimeout( () => { posLabel.style.background = prev; }, 400 );

                }

            } );

        }

    } );

    window.addEventListener( 'keyup', ( event ) => {

        const k = event.key;
        if ( k === 'w' || k === 'W' ) input.keyW = false;
        if ( k === 's' || k === 'S' ) input.keyS = false;
        if ( k === 'a' || k === 'A' ) input.keyA = false;
        if ( k === 'd' || k === 'D' ) input.keyD = false;
        if ( k === 'e' || k === 'E' ) input.keyE = false;
        if ( k === 'ArrowUp' ) input.arrowUp = false;
        if ( k === 'ArrowDown' ) input.arrowDown = false;
        if ( k === 'ArrowLeft' ) input.arrowLeft = false;
        if ( k === 'ArrowRight' ) input.arrowRight = false;
        if ( k === 'r' || k === 'R' ) input.keyR = false;
        if ( k === ' ' ) input.keySpace = false;

    } );

    window.addEventListener( 'gamepadconnected', ( e ) => {

        gamepad.index = e.gamepad.index;
        gamepad.id = e.gamepad.id;
        if ( speedoControllerEl ) speedoControllerEl.style.display = 'block';
        if ( touch.enabled ) setTouchOverlayVisible( false ); // gamepad wins
        renderControlsCheatsheet();
        _dsUpdateButton();
        console.log( '[gamepad] connected:', e.gamepad.id );

    } );

    window.addEventListener( 'gamepaddisconnected', ( e ) => {

        if ( e.gamepad.index === gamepad.index ) {

            gamepad.index = - 1;
            gamepad.id = '';
            if ( speedoControllerEl ) speedoControllerEl.style.display = 'none';
            if ( touch.enabled ) setTouchOverlayVisible( true );
            renderControlsCheatsheet();
            _dsUpdateButton();

        }

    } );

    window.addEventListener( 'resize', onWindowResize, false );
    // Orientation flips on iOS can fire `orientationchange` BEFORE the
    // window dimensions update, so we also re-run onWindowResize after a
    // short delay. Cheap; idempotent.
    window.addEventListener( 'orientationchange', () => {

        onWindowResize();
        setTimeout( onWindowResize, 200 );

    } );

}

// Probe display refresh rate by averaging ~60 rAF intervals. This also
// implicitly measures whether the system is keeping up: if the page is
// already janking, we'll see ~30Hz here and lock to 60.
function detectRefreshRate() {

    return new Promise( ( resolve ) => {

        let frames = 0;
        let startTime = 0;

        function tick( time ) {

            if ( frames === 0 ) startTime = time;
            frames ++;

            if ( frames > 60 ) {

                const elapsed = time - startTime;
                const avgInterval = elapsed / ( frames - 1 );
                resolve( 1000 / avgInterval );

            } else {

                requestAnimationFrame( tick );

            }

        }

        requestAnimationFrame( tick );

    } );

}

async function initPhysics() {

    // selfStep: false → physics stepping driven by us inside the rAF animate
    // loop with the same delta as updateVehicle, so chassis pose + wheel
    // raycast state are sampled at the same instant. This fixes the chassis
    // flicker that no amount of damping could remove.
    physics = await RapierPhysics( { frameRate: fpsTarget.target, selfStep: false } );

    physicsHelper = new RapierHelper( physics.world );
    physicsHelper.visible = false; // toggle with H — at track scale this is heavy
    scene.add( physicsHelper );

    physics.addScene( scene );

    await loadTrack();

    createCar();

    // Kick off background preloading of every other map's GLB after the
    // initial map is fully driveable. THREE.Cache stores the raw GLB bytes,
    // so when the player presses 2 / 3 / 4 the next loadAsync() reuses the
    // cached buffer — the swap then pays only the parse + chunking cost
    // (~hundreds of ms for big tracks) instead of the network download
    // (5–30 s for the 50–95 MB community files).
    preloadOtherMaps();

}

let _preloadStarted = false;
function preloadOtherMaps() {

    if ( _preloadStarted ) return;
    _preloadStarted = true;
    THREE.Cache.enabled = true;
    // Defer so the initial frame, audio unlock, and any first-input physics
    // tick all win the bandwidth race; preloading then chews quietly behind.
    setTimeout( () => {

        const loader = new GLTFLoader();
        const others = Object.keys( MAPS ).filter( id => id !== currentMapId );
        ( async () => {

            for ( const id of others ) {

                try {

                    const url = import.meta.env.BASE_URL + MAPS[ id ].path;
                    const t0 = performance.now();
                    await loader.loadAsync( url );
                    console.log( `[preload] cached ${ id } (${ ( ( performance.now() - t0 ) / 1000 ).toFixed( 1 ) } s)` );

                } catch ( err ) {

                    console.warn( `[preload] ${ id } failed:`, err.message );

                }

            }

        } )();

    }, 4000 );

}

// Spatially bucket a loaded GLB's triangles into ~tileSize tiles so we can
// dynamically toggle receiveShadow per tile (the shadow camera only covers
// ±60m around the car, so any tile farther than that does pointless PCF
// taps every fragment if receiveShadow stays on). World transforms are baked
// into the chunk geometry so the chunks can be parented to scene directly.
function chunkTrackMeshes( sceneRoot, tileSize ) {

    const buckets = new Map();

    const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
    const n0 = new THREE.Vector3(), n1 = new THREE.Vector3(), n2 = new THREE.Vector3();

    sceneRoot.traverse( ( obj ) => {

        if ( ! obj.isMesh || ! obj.geometry ) return;

        const geom = obj.geometry;
        const posAttr = geom.attributes.position;
        if ( ! posAttr ) return;
        const normalAttr = geom.attributes.normal;
        const uvAttr = geom.attributes.uv;
        const idxAttr = geom.index;
        const material = obj.material;
        const matrixWorld = obj.matrixWorld;
        const normalMat = new THREE.Matrix3().getNormalMatrix( matrixWorld );

        const triCount = idxAttr ? ( idxAttr.count / 3 ) : ( posAttr.count / 3 );

        for ( let t = 0; t < triCount; t ++ ) {

            const i0 = idxAttr ? idxAttr.getX( t * 3 + 0 ) : t * 3 + 0;
            const i1 = idxAttr ? idxAttr.getX( t * 3 + 1 ) : t * 3 + 1;
            const i2 = idxAttr ? idxAttr.getX( t * 3 + 2 ) : t * 3 + 2;

            v0.fromBufferAttribute( posAttr, i0 ).applyMatrix4( matrixWorld );
            v1.fromBufferAttribute( posAttr, i1 ).applyMatrix4( matrixWorld );
            v2.fromBufferAttribute( posAttr, i2 ).applyMatrix4( matrixWorld );

            const cx = ( v0.x + v1.x + v2.x ) / 3;
            const cz = ( v0.z + v1.z + v2.z ) / 3;
            const tileX = Math.floor( cx / tileSize );
            const tileZ = Math.floor( cz / tileSize );
            const key = `${ tileX }_${ tileZ }|${ material.uuid }`;

            let bucket = buckets.get( key );
            if ( ! bucket ) {

                bucket = {
                    positions: [],
                    normals: normalAttr ? [] : null,
                    uvs: uvAttr ? [] : null,
                    material
                };
                buckets.set( key, bucket );

            }

            bucket.positions.push(
                v0.x, v0.y, v0.z,
                v1.x, v1.y, v1.z,
                v2.x, v2.y, v2.z
            );

            if ( normalAttr ) {

                n0.fromBufferAttribute( normalAttr, i0 ).applyMatrix3( normalMat ).normalize();
                n1.fromBufferAttribute( normalAttr, i1 ).applyMatrix3( normalMat ).normalize();
                n2.fromBufferAttribute( normalAttr, i2 ).applyMatrix3( normalMat ).normalize();
                bucket.normals.push(
                    n0.x, n0.y, n0.z,
                    n1.x, n1.y, n1.z,
                    n2.x, n2.y, n2.z
                );

            }

            if ( uvAttr ) {

                bucket.uvs.push(
                    uvAttr.getX( i0 ), uvAttr.getY( i0 ),
                    uvAttr.getX( i1 ), uvAttr.getY( i1 ),
                    uvAttr.getX( i2 ), uvAttr.getY( i2 )
                );

            }

        }

    } );

    const meshes = [];
    for ( const bucket of buckets.values() ) {

        const g = new THREE.BufferGeometry();
        g.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( bucket.positions ), 3 ) );
        if ( bucket.normals ) g.setAttribute( 'normal', new THREE.BufferAttribute( new Float32Array( bucket.normals ), 3 ) );
        if ( bucket.uvs ) g.setAttribute( 'uv', new THREE.BufferAttribute( new Float32Array( bucket.uvs ), 2 ) );
        g.computeBoundingBox();
        g.computeBoundingSphere();

        const mesh = new THREE.Mesh( g, bucket.material );
        mesh.castShadow = false;
        mesh.receiveShadow = false; // toggled per frame in updateTrackShadowReceive()
        meshes.push( mesh );

    }

    return meshes;

}

// Distance-based chunk visibility. For huge maps (Spa is 14 km × 14 km with
// ~5000 chunks) we hide chunks whose XZ AABB is past the per-map
// renderRadius from the car — they'd be invisible behind the horizon anyway,
// and skipping them removes draw calls + frustum tests + the shadow loop's
// per-chunk work below. Default `renderRadius = Infinity` keeps the
// Nordschleife / GP maps drawing everything (those maps run fine).
function updateTrackVisibility() {

    if ( ! track || ! sunTarget ) return;
    const radius = ( MAPS[ currentMapId ] && MAPS[ currentMapId ].renderRadius ) || Infinity;
    if ( ! Number.isFinite( radius ) ) {

        // Fast-path: nothing to cull. Make sure everything stays visible
        // in case we swapped from a culling map back to an uncapped one.
        for ( const child of track.children ) child.visible = true;
        return;

    }
    const cx = sunTarget.position.x;
    const cz = sunTarget.position.z;
    const r2 = radius * radius;
    for ( const child of track.children ) {

        const bb = child.geometry && child.geometry.boundingBox;
        if ( ! bb ) { child.visible = true; continue; }
        // Closest-point distance from car to chunk AABB on XZ — accounts
        // for chunks larger than the cull radius (always-visible if the
        // car is inside their footprint).
        const dx = Math.max( bb.min.x - cx, 0, cx - bb.max.x );
        const dz = Math.max( bb.min.z - cz, 0, cz - bb.max.z );
        child.visible = ( dx * dx + dz * dz ) < r2;

    }

}

// AABB intersection between each track chunk and the sun's shadow camera
// footprint (centered on the car). receiveShadow is only true on chunks that
// can actually contain shadowed fragments — every other chunk skips the PCF
// taps that the shader would otherwise do per fragment. Skips chunks already
// hidden by updateTrackVisibility() since invisible chunks can't shadow.
function updateTrackShadowReceive() {

    if ( ! track || ! sunTarget ) return;

    const sx = sunTarget.position.x;
    const sy = sunTarget.position.y;
    const sz = sunTarget.position.z;
    const margin = 55; // ±40m shadow extent + small slack

    for ( const child of track.children ) {

        if ( ! child.visible ) { child.receiveShadow = false; continue; }
        const bb = child.geometry && child.geometry.boundingBox;
        if ( ! bb ) continue;

        const overlaps =
            bb.max.x >= sx - margin && bb.min.x <= sx + margin &&
            bb.max.z >= sz - margin && bb.min.z <= sz + margin &&
            bb.max.y >= sy - 250 && bb.min.y <= sy + 250;

        child.receiveShadow = overlaps;

    }

}

async function loadTrack() {

    const mapCfg = MAPS[ currentMapId ];
    if ( fpsLabel ) fpsLabel.textContent = `loading ${ mapCfg.label }...`;

    const loader = new GLTFLoader();
    // Use BASE_URL so the path works both at /  (dev) and /race_in_progress/ (GH Pages).
    const gltf = await loader.loadAsync( import.meta.env.BASE_URL + mapCfg.path );

    track = gltf.scene;

    // Optional per-map scale (e.g. the GP layout glb is authored ~1/30 size
    // of the Nordschleife glb). Applied on the root so it flows through to
    // both chunkTrackMeshes and the trimesh collider extraction — both bake
    // matrixWorld into their output vertices.
    if ( mapCfg.scale && mapCfg.scale !== 1 ) track.scale.setScalar( mapCfg.scale );

    // The GLB's root node already bakes in a Z-up→Y-up rotation matrix
    // (verified in the file's JSON chunk). Adding our own would double-rotate
    // and flip the track upside-down — which is exactly what was happening.
    scene.add( track );
    track.updateMatrixWorld( true );

    const excludeList = mapCfg.excludeMeshesNear || [];
    const _excludeCenter = new THREE.Vector3();
    const matOverrides = mapCfg.materialOverrides || {};
    const nonCollidableMats = new Set( mapCfg.nonCollidableMaterials || [] );

    track.traverse( ( obj ) => {

        if ( obj.isMesh ) {

            // Casting shadows from a 6km mesh is pointless and very expensive;
            // the car still casts onto the track because the track receives them.
            obj.castShadow = false;
            obj.receiveShadow = true;

            // Foliage flag: the Suzuka GLB has 12 TREE0*/SHRUB_* materials
            // (alpha-cutout billboards) plus a TREE_SHADOW ground-decal. Tag
            // their meshes so we can (a) raise the alpha-test cutoff at
            // runtime to hide the rectangular card silhouette that the baked
            // 0.08 cutoff was leaving visible, and (b) skip them in the
            // trimesh collider builder below — currently the car physically
            // hits invisible tree cards next to the track.
            const mat = obj.material;
            const matName = mat && mat.name ? mat.name : '';
            if ( /^(TREE|SHRUB)/.test( matName ) ) {

                obj.userData.isFoliage = true;
                // TREE_SHADOW is a flat ground decal (BLEND, low opacity);
                // only bump alphaTest on the cutout billboards.
                if ( matName !== 'TREE_SHADOW' && mat.alphaTest != null ) {

                    mat.alphaTest = 0.4;
                    mat.needsUpdate = true;

                }

            }

            // Per-map material overrides: swap debug textures for plain
            // colour fills. Names matched against the .name field that
            // GLTFLoader copies from the source material.
            const ovName = matName;
            if ( ovName && matOverrides[ ovName ] ) {

                const ov = matOverrides[ ovName ];
                if ( ov.removeMap && obj.material.map ) {

                    obj.material.map.dispose();
                    obj.material.map = null;

                }
                if ( ov.color != null ) obj.material.color.setHex( ov.color );
                obj.material.needsUpdate = true;

            }

            // Per-map non-collidable materials: keep visual, skip collider.
            if ( matName && nonCollidableMats.has( matName ) ) {

                obj.userData.nonCollidable = true;

            }

            // Per-map junk-mesh exclusion: hide + skip-collider any mesh whose
            // centre is within radius of a configured world-space point.
            if ( excludeList.length > 0 && obj.geometry ) {

                if ( ! obj.geometry.boundingBox ) obj.geometry.computeBoundingBox();
                obj.geometry.boundingBox.getCenter( _excludeCenter );
                _excludeCenter.applyMatrix4( obj.matrixWorld );
                for ( const ex of excludeList ) {

                    const dx = _excludeCenter.x - ex.x;
                    const dy = _excludeCenter.y - ex.y;
                    const dz = _excludeCenter.z - ex.z;
                    if ( dx * dx + dy * dy + dz * dz <= ex.radius * ex.radius ) {

                        obj.visible = false;
                        obj.userData.excludedJunk = true;
                        break;

                    }

                }

            }

        }

    } );

    // One static body, one trimesh collider per mesh — no need to merge.
    const RAPIER = physics.RAPIER;
    trackBody = physics.world.createRigidBody( RAPIER.RigidBodyDesc.fixed() );

    let totalTris = 0;
    const vtmp = new THREE.Vector3();

    track.traverse( ( obj ) => {

        if ( ! obj.isMesh || ! obj.geometry ) return;
        // Skip foliage billboards — they're alpha-cutout tree cards. Their
        // bounding quad has no business being a solid wall the car bounces off.
        if ( obj.userData.isFoliage ) return;
        // Skip junk meshes excluded by map config.
        if ( obj.userData.excludedJunk ) return;
        // Skip materials marked non-collidable (debug placeholders, far-away
        // grandstand seats — visual only).
        if ( obj.userData.nonCollidable ) return;

        const geom = obj.geometry;
        const posAttr = geom.attributes.position;
        if ( ! posAttr ) return;

        const vertices = new Float32Array( posAttr.count * 3 );

        for ( let i = 0; i < posAttr.count; i ++ ) {

            vtmp.fromBufferAttribute( posAttr, i ).applyMatrix4( obj.matrixWorld );
            vertices[ i * 3 ] = vtmp.x;
            vertices[ i * 3 + 1 ] = vtmp.y;
            vertices[ i * 3 + 2 ] = vtmp.z;

        }

        let indices;
        if ( geom.index ) {

            indices = geom.index.array instanceof Uint32Array
                ? geom.index.array
                : new Uint32Array( geom.index.array );

        } else {

            // Non-indexed geometry — synthesize sequential indices.
            indices = new Uint32Array( posAttr.count );
            for ( let i = 0; i < posAttr.count; i ++ ) indices[ i ] = i;

        }

        const colliderDesc = RAPIER.ColliderDesc.trimesh( vertices, indices );
        physics.world.createCollider( colliderDesc, trackBody );

        totalTris += indices.length / 3;

    } );

    _trackTris = totalTris;

    // ── chunk the visual track so we can per-tile-cull receiveShadow ──
    // Tile size: 200m. Each tile larger than the shadow camera's 120m extent
    // means we cover the shadow region with 1–4 active tiles at any time.
    const tStart = performance.now();
    const chunkMeshes = chunkTrackMeshes( track, 200 );
    const tEnd = performance.now();

    // Replace the loaded gltf scene (which sits under the Sketchfab_model root
    // matrix) with a flat Group of chunks at identity. We baked world coords
    // into the chunk vertices already.
    scene.remove( track );

    const chunkedTrack = new THREE.Group();
    chunkedTrack.name = 'TrackChunked';
    chunkMeshes.forEach( c => chunkedTrack.add( c ) );
    scene.add( chunkedTrack );
    chunkedTrack.updateMatrixWorld( true );

    // Track is static — three.js doesn't need to walk it every frame.
    chunkedTrack.matrixWorldAutoUpdate = false;
    chunkMeshes.forEach( c => { c.matrixWorldAutoUpdate = false; } );

    track = chunkedTrack;

    console.log( `[track] ${ totalTris.toLocaleString() } triangles, ${ chunkMeshes.length } chunks (${ ( tEnd - tStart ).toFixed( 0 ) } ms), spawn ${ spawnPoint.x.toFixed( 1 ) }, ${ spawnPoint.y.toFixed( 1 ) }, ${ spawnPoint.z.toFixed( 1 ) }` );
    if ( fpsLabel ) fpsLabel.textContent = `display ~${ fpsTarget.target }fps · ${ ( totalTris / 1000 ).toFixed( 0 ) }k tris · ${ chunkMeshes.length } chunks`;

    // Load the per-map racing line for AI drive (L). Failure is non-fatal —
    // L just shows "no line for this map" if the JSON is missing.
    await loadRacingLine( currentMapId );
    disposeAiLineMesh();
    if ( ai.enabled ) buildAiLineMesh();

}

// Hot-swap the active map. Tears down the current track mesh + static
// physics body, loads the requested map, applies its spawn pose to the
// shared spawnPoint/spawnQuaternion, then teleports the car onto it.
async function swapMap( id ) {

    if ( ! MAPS[ id ] || mapSwapInFlight || id === currentMapId ) return;
    mapSwapInFlight = true;

    // 1) Remove the existing visual track and free its geometry.
    if ( track ) {

        scene.remove( track );
        track.traverse( ( obj ) => {

            if ( obj.isMesh && obj.geometry ) obj.geometry.dispose();

        } );
        track = null;

    }

    // 2) Drop the static track rigid body (Rapier removes its colliders too).
    if ( trackBody && physics && physics.world ) {

        physics.world.removeRigidBody( trackBody );
        trackBody = null;

    }

    // 3) Skid marks were stuck to the old surface — wipe them.
    clearSkidMarks();

    // 4) Switch the active map id and copy its spawn pose into the shared
    //    spawnPoint / spawnQuaternion before loading, so the [track] log line
    //    and any reset-during-load read the right values.
    currentMapId = id;
    const cfg = MAPS[ id ];
    spawnPoint.set( cfg.spawnPos.x, cfg.spawnPos.y, cfg.spawnPos.z );
    spawnQuaternion.set( cfg.spawnRot.x, cfg.spawnRot.y, cfg.spawnRot.z, cfg.spawnRot.w );

    // Swap the lap-history bucket — each map has its own best times.
    if ( lapTimer ) { _lapTimerLoadForMap(); _lapTimerRefreshPanel(); }

    // Tell peers we moved (and pull them along if we're authoritative).
    if ( typeof _broadcastLocalMeta === 'function' && multiplayer.room ) _broadcastLocalMeta();

    // 5) Load the new track geometry + collider mesh.
    await loadTrack();

    // 5a) Per-map atmosphere — depth-of-field bokeh softens distance so
    //     the cull edge fades into natural camera blur instead of a hard
    //     cliff. Composer is built lazily on first use and the bokeh pass
    //     is enabled/disabled per map (no DoF = direct renderer.render).
    setupDof( cfg.dof );

    // 5b) Per-map whole-car scale — applied to the chassis root so every
    //     visual child (body, wheels, lights, steering wheel) scales
    //     uniformly. Physics collider + vehicle-controller wheels are
    //     baked at creation and don't read mesh.scale, so handling is
    //     unchanged. Default 1.0 restores original size on other maps.
    if ( car ) {

        const s = cfg.carScale || 1;
        car.scale.setScalar( s );

    }

    // 5c) Match remote cars to the same scale so other players in the
    //     room look the same size as the local player on every map.
    //     Also rebuild each remote's Rapier collider at the new scale —
    //     otherwise the visual mesh grows to 1.5× on Spa/Suzuka but the
    //     collider stays 1×, causing massive penetration on contact and
    //     a violent launch-to-space recovery.
    const remoteScale = cfg.carScale || 1;
    if ( multiplayer && multiplayer.remotes ) {

        for ( const rc of multiplayer.remotes.values() ) {

            if ( rc.group ) rc.group.scale.setScalar( remoteScale );
            if ( typeof rc.rebuildPhysicsForMap === 'function' ) rc.rebuildPhysicsForMap();

        }

    }

    // 6) Teleport the car onto the new spawn — reuses the same reset path
    //    the R key already uses, just inlined because we don't want to wait
    //    for the next physics tick to read input.reset.
    if ( chassis ) {

        chassis.setTranslation( new physics.RAPIER.Vector3( spawnPoint.x, spawnPoint.y, spawnPoint.z ), true );
        chassis.setRotation( new physics.RAPIER.Quaternion( spawnQuaternion.x, spawnQuaternion.y, spawnQuaternion.z, spawnQuaternion.w ), true );
        chassis.setLinvel( new physics.RAPIER.Vector3( 0, 0, 0 ), true );
        chassis.setAngvel( new physics.RAPIER.Vector3( 0, 0, 0 ), true );
        transmission.gear = 1;
        transmission.shiftCooldown = 0;
        engine.rpm = engine.idleRpm;
        input.reverseEngaged = false;
        input.sHeldTime = 0;
        input.padBrakeFullTime = 0;
        input.handbrakeAfterReset = true;
        chaseCam.initialized = false;
        resetTires();
        resetDrivetrain();
        resetDualsenseState();

    }

    mapSwapInFlight = false;

}

function createCar() {

    // Invisible 2×1×4 box: this is what Rapier reads to build the chassis
    // collider via physics.addMesh. Visual car parts are added as children so
    // they inherit the rigid body's transform without affecting physics.
    const chassisGeom = new THREE.BoxGeometry( 2, 1, 4 );
    const chassisMat = new THREE.MeshStandardMaterial();
    chassisMat.visible = false;
    const mesh = new THREE.Mesh( chassisGeom, chassisMat );
    mesh.castShadow = false;
    scene.add( mesh );
    car = mesh;

    mesh.position.copy( spawnPoint );
    mesh.quaternion.copy( spawnQuaternion );

    // Mass baseline = the lightest car so we can only ADD mass dynamically
    // (Rapier setAdditionalMass requires non-negative). All other cars layer
    // additional mass on top in applyCarConfig.
    const baselineMass = Math.min( ...CARS.map( c => c.mass ) );
    physics.addMesh( mesh, baselineMass, currentCar.chassisFriction );
    chassis = mesh.userData.physics.body;
    chassis.setRotation( new physics.RAPIER.Quaternion( spawnQuaternion.x, spawnQuaternion.y, spawnQuaternion.z, spawnQuaternion.w ), true );

    // The shared RapierPhysics helper takes its third arg as "restitution"
    // even though our CARS data labels it chassisFriction — so a 0.9-1.0
    // value was being set as restitution, which made the chassis act like
    // a beach ball when contacted by a remote car (Rapier picks MAX of the
    // two restitutions at a contact). Re-apply the intended meaning: use
    // the value as friction, zero out restitution. Cars scrape instead of
    // ping off each other, and remote-car contact stops launching us.
    chassisCollider = mesh.userData.physics.collider;
    if ( chassisCollider ) {

        chassisCollider.setFriction( currentCar.chassisFriction );
        chassisCollider.setRestitution( 0.0 );

    }

    carVisualsGroup = new THREE.Group();
    mesh.add( carVisualsGroup );
    buildCarVisuals( carVisualsGroup, currentCar );

    vehicleController = physics.world.createVehicleController( chassis );

    wheels = [];

    const wy = currentCar.wheelConnectionY;
    addWheel( 0, { x: - 1, y: wy, z: - 1.5 }, mesh );
    addWheel( 1, { x: 1, y: wy, z: - 1.5 }, mesh );
    addWheel( 2, { x: - 1, y: wy, z: 1.5 }, mesh );
    addWheel( 3, { x: 1, y: wy, z: 1.5 }, mesh );

    // Toe baked into steering channel; driver input adds an offset on top
    // each frame in applyVehicleForces.
    applySuspensionGeometry();

    buildAndMountSteeringWheel( currentCar );

    // Sync runtime engine settings + per-wheel params for the starting car.
    applyCarConfig( currentCar, /* skipVisuals */ true );

    // Engine RPM defaults already match the hatchback; if a non-default car
    // becomes the starter later this guarantees idle.
    engine.idleRpm = currentCar.engineIdleRpm;
    engine.redline = currentCar.engineRedline;
    engine.autoUpshiftRpm = currentCar.autoUpshiftRpm;
    engine.autoDownshiftRpm = currentCar.autoDownshiftRpm;
    engine.rpm = engine.idleRpm;

}

function initSpeedometer() {

    speedoEl = document.createElement( 'div' );
    speedoEl.style.cssText = [
        'position:absolute', 'bottom:18px', 'left:50%', 'transform:translateX(-50%)',
        'padding:10px 16px', 'background:rgba(0,0,0,0.62)', 'border-radius:10px',
        'color:#fff', 'font-family:Monospace', 'z-index:2',
        'display:flex', 'align-items:center', 'gap:18px',
        'box-shadow:0 4px 18px rgba(0,0,0,0.35)', 'pointer-events:none'
    ].join( ';' );

    speedoGearEl = document.createElement( 'div' );
    speedoGearEl.style.cssText = 'font-size:42px;font-weight:700;line-height:1;min-width:48px;text-align:center;color:#FFCB47';
    speedoGearEl.textContent = '1';
    speedoEl.appendChild( speedoGearEl );

    const speedCol = document.createElement( 'div' );
    speedCol.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:120px';

    speedoNumEl = document.createElement( 'div' );
    speedoNumEl.style.cssText = 'font-size:36px;font-weight:700;line-height:1';
    speedoNumEl.textContent = '0';
    speedCol.appendChild( speedoNumEl );

    const unit = document.createElement( 'div' );
    unit.style.cssText = 'font-size:10px;opacity:0.75;letter-spacing:1.5px';
    unit.textContent = 'KM / H';
    speedCol.appendChild( unit );

    // RPM bar
    const rpmTrack = document.createElement( 'div' );
    rpmTrack.style.cssText = 'width:140px;height:6px;background:rgba(255,255,255,0.12);border-radius:3px;position:relative;overflow:hidden';
    speedoRpmFillEl = document.createElement( 'div' );
    speedoRpmFillEl.style.cssText = 'height:100%;width:0%;background:linear-gradient(90deg,#7BD37F 0%,#F5D04A 65%,#E04141 100%);transition:width 60ms linear';
    rpmTrack.appendChild( speedoRpmFillEl );
    // Redline marker (last ~15% of bar)
    const redline = document.createElement( 'div' );
    redline.style.cssText = 'position:absolute;left:85%;top:-2px;width:2px;height:10px;background:#E04141';
    rpmTrack.appendChild( redline );
    speedCol.appendChild( rpmTrack );

    speedoEl.appendChild( speedCol );

    speedoModeEl = document.createElement( 'div' );
    speedoModeEl.style.cssText = 'font-size:10px;letter-spacing:1.5px;padding:4px 8px;border:1px solid rgba(255,255,255,0.45);border-radius:4px;opacity:0.9';
    speedoModeEl.textContent = 'AUTO';
    speedoEl.appendChild( speedoModeEl );

    speedoControllerEl = document.createElement( 'div' );
    speedoControllerEl.style.cssText = 'display:none;color:#fff;opacity:0.9';
    speedoControllerEl.innerHTML = iconHTML( 'gamepad-2', 18 );
    speedoControllerEl.title = 'Gamepad connected';
    speedoEl.appendChild( speedoControllerEl );

    document.body.appendChild( speedoEl );

}

function updateSpeedometer( speed ) {

    const kmh = Math.abs( speed ) * 3.6;
    speedoNumEl.textContent = Math.round( kmh ).toString();

    const gear = transmission.gear;
    speedoGearEl.textContent = gear === - 1 ? 'R' : gear === 0 ? 'N' : gear.toString();

    const pct = Math.max( 0, Math.min( 100, ( engine.rpm / engine.redline ) * 100 ) );
    speedoRpmFillEl.style.width = pct.toFixed( 1 ) + '%';

}

// ---------------- touch controls ----------------

function shouldShowTouch() {

    // Re-checks the current device class — `device.touchOnly` is kept up to
    // date on every resize / first-keystroke, and we never want to render
    // the touch overlay on a real desktop with a keyboard.
    _updateDeviceState();
    return device.touchOnly;

}

function _touchHoldBtn( label, fontSize, onDown, onUp ) {

    const b = document.createElement( 'div' );
    b.textContent = label;
    // 56×56 default — comfortably above the 44pt iOS / 48dp Android minima.
    b.style.cssText = [
        'width:56px', 'height:56px', 'border-radius:14px',
        'background:rgba(0,0,0,0.55)', 'color:#fff', 'font-family:Monospace',
        'display:flex', 'align-items:center', 'justify-content:center',
        `font-size:${ fontSize }px`, 'pointer-events:auto', 'user-select:none',
        '-webkit-user-select:none', 'touch-action:none',
        'border:1px solid rgba(255,255,255,0.18)',
        'box-shadow:0 4px 12px rgba(0,0,0,0.35)',
        'transition:transform 60ms,background 60ms'
    ].join( ';' );
    let pid = - 1;
    b.addEventListener( 'pointerdown', ( e ) => {

        if ( pid !== - 1 ) return;
        pid = e.pointerId;
        b.setPointerCapture( pid );
        b.style.background = 'rgba(255,203,71,0.6)';
        b.style.transform = 'scale(0.94)';
        if ( onDown ) onDown();

    } );
    const release = ( e ) => {

        if ( e.pointerId !== pid ) return;
        pid = - 1;
        b.style.background = 'rgba(0,0,0,0.5)';
        b.style.transform = 'scale(1)';
        if ( onUp ) onUp();

    };
    b.addEventListener( 'pointerup', release );
    b.addEventListener( 'pointercancel', release );
    b.addEventListener( 'pointerleave', release );
    return b;

}

function _touchTapBtn( label, fontSize, onTap ) {

    return _touchHoldBtn( label, fontSize, onTap, null );

}

function _touchPedal( color ) {

    const bar = document.createElement( 'div' );
    bar.style.cssText = [
        'position:absolute', 'width:88px', 'height:240px',
        'background:rgba(0,0,0,0.42)', 'border-radius:14px',
        'border:1px solid rgba(255,255,255,0.15)',
        'pointer-events:auto', 'touch-action:none', 'overflow:hidden'
    ].join( ';' );
    const fill = document.createElement( 'div' );
    fill.style.cssText = [
        'position:absolute', 'left:0', 'right:0', 'bottom:0',
        `background:${ color }`, 'height:0%', 'transition:height 60ms linear', 'opacity:0.85'
    ].join( ';' );
    bar.appendChild( fill );
    return { bar, fill };

}

function _bindPedal( bar, fill, kindKey ) {

    let pid = - 1;
    const setFromEvent = ( e ) => {

        const rect = bar.getBoundingClientRect();
        const y = e.clientY - rect.top;
        const v = 1 - Math.max( 0, Math.min( 1, y / rect.height ) ); // top = max
        touch[ kindKey ] = v;
        fill.style.height = ( v * 100 ).toFixed( 1 ) + '%';
        if ( kindKey === 'brake' ) touch.brakeActive = v > 0.05;

    };
    bar.addEventListener( 'pointerdown', ( e ) => {

        if ( pid !== - 1 ) return;
        pid = e.pointerId;
        bar.setPointerCapture( pid );
        setFromEvent( e );

    } );
    bar.addEventListener( 'pointermove', ( e ) => {

        if ( e.pointerId !== pid ) return;
        setFromEvent( e );

    } );
    const release = ( e ) => {

        if ( e.pointerId !== pid ) return;
        pid = - 1;
        touch[ kindKey ] = 0;
        if ( kindKey === 'brake' ) touch.brakeActive = false;
        fill.style.height = '0%';

    };
    bar.addEventListener( 'pointerup', release );
    bar.addEventListener( 'pointercancel', release );
    bar.addEventListener( 'pointerleave', release );

}

function initTouchControls() {

    // Always update device state first so applyMobileLayout reads fresh
    // dimensions, even on a desktop browser (no-op there).
    _updateDeviceState();
    if ( ! shouldShowTouch() ) {

        // Still build the mobile UI scaffolding if the device classes
        // demand it later (e.g., user shrinks a touch laptop). For now,
        // just bail — the overlay is gated on touchOnly anyway.
        return;

    }
    touch.enabled = true;

    const root = document.createElement( 'div' );
    root.id = 'touch-overlay';
    root.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:5;user-select:none;-webkit-user-select:none';
    document.body.appendChild( root );
    touch.rootEl = root;

    // ── floating drag-pad ── covers the bottom-left zone (where the left
    // thumb naturally lands). Its exact rect is set in applyMobileLayout
    // depending on orientation.
    const pad = document.createElement( 'div' );
    pad.style.cssText = 'position:absolute;pointer-events:auto;touch-action:none';
    root.appendChild( pad );
    touch.padEl = pad;

    const ring = document.createElement( 'div' );
    ring.style.cssText = 'position:absolute;width:130px;height:130px;border-radius:50%;border:2px solid rgba(255,255,255,0.55);background:rgba(0,0,0,0.18);display:none;pointer-events:none;transform:translate(-50%,-50%)';
    root.appendChild( ring );
    touch.ringEl = ring;

    const thumb = document.createElement( 'div' );
    thumb.style.cssText = 'position:absolute;width:60px;height:60px;border-radius:50%;background:rgba(255,255,255,0.88);display:none;pointer-events:none;transform:translate(-50%,-50%);box-shadow:0 2px 10px rgba(0,0,0,0.4)';
    root.appendChild( thumb );
    touch.thumbEl = thumb;

    pad.addEventListener( 'pointerdown', ( e ) => {

        if ( touch.dragPointerId !== - 1 ) return;
        touch.dragPointerId = e.pointerId;
        pad.setPointerCapture( e.pointerId );
        touch.dragOriginX = e.clientX;
        ring.style.left = e.clientX + 'px';
        ring.style.top = e.clientY + 'px';
        ring.style.display = 'block';
        thumb.style.left = e.clientX + 'px';
        thumb.style.top = e.clientY + 'px';
        thumb.style.display = 'block';
        touch.steer = 0;

    } );
    pad.addEventListener( 'pointermove', ( e ) => {

        if ( e.pointerId !== touch.dragPointerId ) return;
        const dx = e.clientX - touch.dragOriginX;
        const dead = 6;
        const max = 90;
        let v = 0;
        if ( Math.abs( dx ) > dead ) {

            const s = Math.sign( dx );
            v = s * Math.min( 1, ( Math.abs( dx ) - dead ) / max );

        }
        // negate because in our control convention +1 = LEFT (matches keyA) and
        // we want dragging right on screen to steer right (-1).
        touch.steer = - v;
        const clampedDx = Math.max( - max, Math.min( max, dx ) );
        thumb.style.left = ( touch.dragOriginX + clampedDx ) + 'px';
        thumb.style.top = e.clientY + 'px';

    } );
    const padRelease = ( e ) => {

        if ( e.pointerId !== touch.dragPointerId ) return;
        touch.dragPointerId = - 1;
        touch.steer = 0;
        ring.style.display = 'none';
        thumb.style.display = 'none';

    };
    pad.addEventListener( 'pointerup', padRelease );
    pad.addEventListener( 'pointercancel', padRelease );

    // ── pedals ── positions set in applyMobileLayout.
    const throttle = _touchPedal( '#FFCB47' );
    root.appendChild( throttle.bar );
    _bindPedal( throttle.bar, throttle.fill, 'throttle' );
    touch.throttleBarEl = throttle.bar;
    touch.throttleFillEl = throttle.fill;

    const brake = _touchPedal( '#E04141' );
    root.appendChild( brake.bar );
    _bindPedal( brake.bar, brake.fill, 'brake' );
    touch.brakeBarEl = brake.bar;
    touch.brakeFillEl = brake.fill;

    // ── vertical cluster of HB / ↑ / ↓ — sits between pedals and steer pad
    // along the right edge. Position set in applyMobileLayout.
    const cluster = document.createElement( 'div' );
    cluster.style.cssText = 'position:absolute;display:flex;flex-direction:column;gap:10px;pointer-events:none';
    root.appendChild( cluster );
    touch.clusterEl = cluster;

    const hb = _touchHoldBtn( 'HB', 14,
        () => { touch.handbrake = 1; },
        () => { touch.handbrake = 0; } );
    const shiftUp = _touchTapBtn( '↑', 24, () => { if ( transmission.mode === 'manual' ) manualShift( 1 ); } );
    const shiftDn = _touchTapBtn( '↓', 24, () => { if ( transmission.mode === 'manual' ) manualShift( - 1 ); } );
    cluster.append( shiftUp, hb, shiftDn );

    // First-time layout pass so positions are correct on initial paint.
    applyMobileLayout();

}

function setTouchOverlayVisible( v ) {

    if ( touch.rootEl ) touch.rootEl.style.display = v ? 'block' : 'none';

}

// ---------------- mobile layout (hamburger / drawer / fps chip / MP modal) ----------------
//
// applyMobileLayout() is the single entry-point for switching the HUD
// between desktop and mobile, AND between portrait and landscape. It is
// safe to call repeatedly (idempotent) and runs on every resize /
// orientationchange / first-keystroke. DOM for the mobile-only widgets is
// lazily built once on first need then re-positioned on each call.

function _ensureMobileChrome() {

    if ( device.mobileBuilt ) return;
    device.mobileBuilt = true;

    // Tiny FPS chip top-left. Mirrors fpsLabel.textContent every 500ms when
    // the chip is visible — cheap, keeps the "X fps · Yk tris" string the
    // game writes to the desktop pill visible on mobile too.
    const fps = document.createElement( 'div' );
    fps.className = 'm-fps mobile-only';
    fps.textContent = '...';
    document.body.appendChild( fps );
    device.fpsChipEl = fps;
    setInterval( () => {

        if ( ! device.fpsChipEl || ! device.touchOnly ) return;
        const src = ( typeof fpsLabel !== 'undefined' && fpsLabel ) ? fpsLabel.textContent : '';
        device.fpsChipEl.textContent = src || '';

    }, 500 );

    // Hamburger button top-right.
    const ham = document.createElement( 'div' );
    ham.className = 'm-hamburger mobile-only';
    ham.textContent = '≡';
    ham.setAttribute( 'aria-label', 'menu' );
    ham.addEventListener( 'click', () => _toggleMobileDrawer( true ) );
    document.body.appendChild( ham );
    device.hamburgerEl = ham;

    // Backdrop + drawer.
    const backdrop = document.createElement( 'div' );
    backdrop.className = 'm-drawer-backdrop';
    backdrop.addEventListener( 'click', () => _toggleMobileDrawer( false ) );
    document.body.appendChild( backdrop );
    device.drawerBackdropEl = backdrop;

    const drawer = document.createElement( 'div' );
    drawer.className = 'm-drawer';
    document.body.appendChild( drawer );
    device.drawerEl = drawer;

    _renderMobileDrawer();

    // MP modal (full-width sheet from bottom). Built once, rendered on
    // demand via _renderMobileMpModal.
    const mpModal = document.createElement( 'div' );
    mpModal.className = 'm-mp-modal';
    mpModal.addEventListener( 'click', ( e ) => {

        if ( e.target === mpModal ) _toggleMobileMpModal( false );

    } );
    const mpSheet = document.createElement( 'div' );
    mpSheet.className = 'm-mp-sheet';
    mpModal.appendChild( mpSheet );
    document.body.appendChild( mpModal );
    device.mpModalEl = mpModal;
    device.mpModalSheetEl = mpSheet;

}

function _toggleMobileDrawer( open ) {

    if ( ! device.drawerEl ) return;
    device.drawerOpen = open;
    device.drawerEl.classList.toggle( 'open', open );
    device.drawerBackdropEl.classList.toggle( 'open', open );
    if ( open ) _renderMobileDrawer(); // refresh dynamic state (room code, etc.)

}

function _toggleMobileMpModal( open ) {

    if ( ! device.mpModalEl ) return;
    device.mpModalOpen = open;
    device.mpModalEl.classList.toggle( 'open', open );
    if ( open ) _renderMobileMpModal();

}

function _renderMobileDrawer() {

    if ( ! device.drawerEl ) return;
    const d = device.drawerEl;
    d.innerHTML = '';

    const close = document.createElement( 'div' );
    close.className = 'm-close';
    close.textContent = '×';
    close.addEventListener( 'click', () => _toggleMobileDrawer( false ) );
    d.appendChild( close );

    const title = document.createElement( 'div' );
    title.style.cssText = 'font-size:14px;color:#FFCB47;letter-spacing:2px;font-weight:700;margin-bottom:6px';
    title.textContent = 'MENU';
    d.appendChild( title );

    // ── Car / car cycle ──
    const carH = document.createElement( 'h4' ); carH.textContent = 'Car'; d.appendChild( carH );
    const carRow = document.createElement( 'div' );
    carRow.className = 'm-row';
    const carName = document.createElement( 'span' );
    carName.style.cssText = 'color:#FFCB47;font-weight:700;letter-spacing:1.5px';
    carName.textContent = ( typeof currentCar !== 'undefined' && currentCar ) ? currentCar.name.toUpperCase() : '—';
    const carBtns = document.createElement( 'div' );
    carBtns.style.cssText = 'display:flex;gap:8px';
    const prevCar = _drawerBtn( '←', () => { cycleCar( - 1 ); _renderMobileDrawer(); } );
    prevCar.style.minWidth = '44px';
    const nextCar = _drawerBtn( '→', () => { cycleCar( 1 ); _renderMobileDrawer(); } );
    nextCar.style.minWidth = '44px';
    carBtns.append( prevCar, nextCar );
    carRow.append( carName, carBtns );
    d.appendChild( carRow );

    // ── Transmission ──
    const txH = document.createElement( 'h4' ); txH.textContent = 'Transmission'; d.appendChild( txH );
    const txRow = document.createElement( 'div' );
    txRow.className = 'm-btn-row';
    const isAuto = typeof transmission !== 'undefined' && transmission.mode === 'automatic';
    const autoBtn = _drawerBtn( 'AUTO', () => {

        if ( typeof transmission !== 'undefined' && transmission.mode !== 'automatic' ) toggleTransmissionMode();
        _renderMobileDrawer();

    }, isAuto );
    const manBtn = _drawerBtn( 'MANUAL', () => {

        if ( typeof transmission !== 'undefined' && transmission.mode !== 'manual' ) toggleTransmissionMode();
        _renderMobileDrawer();

    }, ! isAuto );
    txRow.append( autoBtn, manBtn );
    d.appendChild( txRow );

    // ── Map ──
    const mapH = document.createElement( 'h4' ); mapH.textContent = 'Map'; d.appendChild( mapH );
    const mapGrid = document.createElement( 'div' );
    mapGrid.className = 'm-btn-row';
    const maps = [
        [ 'Nordschleife', 'nurburgring' ],
        [ 'GP', 'nurburgring_gp' ],
        [ 'Spa', 'spa' ],
        [ 'Suzuka', 'suzuka' ]
    ];
    for ( const [ label, id ] of maps ) {

        const active = ( typeof currentMapId !== 'undefined' ) && currentMapId === id;
        mapGrid.appendChild( _drawerBtn( label, () => {

            if ( typeof swapMap === 'function' ) swapMap( id );
            _toggleMobileDrawer( false );

        }, active ) );

    }
    d.appendChild( mapGrid );

    // ── Camera + Reset ──
    const carH2 = document.createElement( 'h4' ); carH2.textContent = 'View'; d.appendChild( carH2 );
    const vRow = document.createElement( 'div' );
    vRow.className = 'm-btn-row';
    vRow.appendChild( _drawerBtn( 'CAMERA', () => { if ( typeof cycleCameraMode === 'function' ) cycleCameraMode(); } ) );
    vRow.appendChild( _drawerBtn( 'RESET CAR', () => {

        input.keyR = true;
        setTimeout( () => { input.keyR = false; }, 80 );
        _toggleMobileDrawer( false );

    } ) );
    d.appendChild( vRow );

    const tRow = document.createElement( 'div' );
    tRow.className = 'm-btn-row';
    const mmOn = typeof minimap !== 'undefined' && !! minimap.enabled;
    tRow.appendChild( _drawerBtn( mmOn ? 'MINIMAP ON' : 'MINIMAP OFF', () => {

        if ( typeof toggleMinimap === 'function' ) toggleMinimap();
        _renderMobileDrawer();

    }, mmOn ) );
    const snOn = typeof statsForNerds !== 'undefined' && !! statsForNerds.enabled;
    tRow.appendChild( _drawerBtn( snOn ? 'STATS ON' : 'STATS OFF', () => {

        if ( typeof toggleStatsForNerds === 'function' ) toggleStatsForNerds();
        _renderMobileDrawer();

    }, snOn ) );
    d.appendChild( tRow );

    // ── Audio + rumble ──
    const audH = document.createElement( 'h4' ); audH.textContent = 'Audio'; d.appendChild( audH );
    const volRow = document.createElement( 'div' );
    volRow.className = 'm-row';
    const volLbl = document.createElement( 'span' ); volLbl.textContent = 'Volume';
    const vol = document.createElement( 'input' );
    vol.type = 'range'; vol.min = '0'; vol.max = '1'; vol.step = '0.01';
    vol.className = 'm-slider';
    vol.value = String( ( typeof audio !== 'undefined' && audio.masterVolume ) || 0 );
    vol.addEventListener( 'input', () => {

        const v = parseFloat( vol.value );
        if ( typeof audio !== 'undefined' ) {

            audio.masterVolume = v;
            if ( audio.masterGain ) audio.masterGain.gain.value = v;

        }
        try { localStorage.setItem( 'masterVolume', String( v ) ); } catch ( _ ) {}

    } );
    volRow.append( volLbl, vol );
    d.appendChild( volRow );

    // ── Multiplayer chip ──
    const mpH = document.createElement( 'h4' ); mpH.textContent = 'Multiplayer'; d.appendChild( mpH );
    const mpRow = document.createElement( 'div' );
    mpRow.className = 'm-btn-row';
    if ( typeof multiplayer !== 'undefined' && multiplayer.room ) {

        const peers = multiplayer.room.peers ? multiplayer.room.peers() : [];
        mpRow.appendChild( _drawerBtn( `ROOM ${ multiplayer.room.roomCode }`, () => {

            _toggleMobileDrawer( false );
            _toggleMobileMpModal( true );

        }, true ) );
        mpRow.appendChild( _drawerBtn( `${ peers.length + 1 } PLAYER${ peers.length === 0 ? '' : 'S' }`, () => {

            _toggleMobileDrawer( false );
            _toggleMobileMpModal( true );

        } ) );

    } else {

        mpRow.appendChild( _drawerBtn( 'MAKE ROOM', () => {

            if ( typeof _createRoom === 'function' ) _createRoom();
            _renderMobileDrawer();

        }, true ) );
        mpRow.appendChild( _drawerBtn( 'JOIN ROOM', () => {

            _toggleMobileDrawer( false );
            _toggleMobileMpModal( true );
            _renderMobileMpModal( /* showJoinForm */ true );

        } ) );

    }
    d.appendChild( mpRow );

    // Footer hint.
    const foot = document.createElement( 'div' );
    foot.style.cssText = 'margin-top:18px;opacity:0.45;font-size:10px;line-height:1.5;letter-spacing:0.5px';
    foot.textContent = 'Tap outside to close. Settings persist locally.';
    d.appendChild( foot );

}

function _drawerBtn( label, onTap, active ) {

    const b = document.createElement( 'div' );
    b.className = 'm-btn' + ( active ? ' primary' : '' );
    b.textContent = label;
    b.addEventListener( 'click', ( e ) => { e.stopPropagation(); onTap(); } );
    return b;

}

function _renderMobileMpModal( showJoinForm ) {

    if ( ! device.mpModalSheetEl ) return;
    const sheet = device.mpModalSheetEl;
    sheet.innerHTML = '';

    const header = document.createElement( 'div' );
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:14px';
    const ttl = document.createElement( 'div' );
    ttl.style.cssText = 'font-size:14px;color:#FFCB47;letter-spacing:2px;font-weight:700';
    ttl.textContent = 'MULTIPLAYER';
    const cls = document.createElement( 'div' );
    cls.textContent = '×';
    cls.style.cssText = 'width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:rgba(255,255,255,0.06);font-size:20px;cursor:pointer';
    cls.addEventListener( 'click', () => _toggleMobileMpModal( false ) );
    header.append( ttl, cls );
    sheet.appendChild( header );

    if ( typeof multiplayer === 'undefined' ) {

        const m = document.createElement( 'div' );
        m.style.opacity = '0.6';
        m.textContent = 'multiplayer not initialized';
        sheet.appendChild( m );
        return;

    }

    if ( ! multiplayer.room ) {

        // Make / join controls + join code input.
        const row = document.createElement( 'div' );
        row.className = 'm-btn-row';
        row.style.gap = '10px';
        const make = _drawerBtn( 'MAKE ROOM', () => {

            if ( typeof _createRoom === 'function' ) _createRoom();
            setTimeout( _renderMobileMpModal, 50 );

        }, true );
        const join = _drawerBtn( 'JOIN', () => { /* handled by input */ } );
        row.append( make );
        sheet.appendChild( row );

        const joinWrap = document.createElement( 'div' );
        joinWrap.style.cssText = 'display:flex;gap:8px;margin-top:14px';
        const inp = document.createElement( 'input' );
        inp.type = 'text';
        inp.placeholder = 'room code';
        inp.maxLength = 5;
        inp.style.cssText = 'flex:1;padding:14px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:10px;color:#fff;font:14px Monospace;text-transform:uppercase;letter-spacing:2px;min-height:44px;box-sizing:border-box';
        inp.addEventListener( 'keydown', ( e ) => e.stopPropagation() );
        inp.addEventListener( 'keyup', ( e ) => e.stopPropagation() );
        const submit = () => {

            const code = inp.value.trim().toUpperCase();
            if ( code.length < 3 ) return;
            if ( typeof _joinRoom === 'function' ) _joinRoom( code );
            setTimeout( _renderMobileMpModal, 50 );

        };
        join.addEventListener( 'click', submit );
        joinWrap.append( inp, join );
        sheet.appendChild( joinWrap );
        if ( showJoinForm ) setTimeout( () => inp.focus(), 50 );
        return;

    }

    // In-room view.
    const peers = multiplayer.room.peers();

    const codeRow = document.createElement( 'div' );
    codeRow.style.cssText = 'display:flex;align-items:center;gap:10px;padding:14px;background:rgba(255,203,71,0.08);border:1px solid rgba(255,203,71,0.35);border-radius:12px;margin-bottom:12px';
    const codeLbl = document.createElement( 'span' );
    codeLbl.style.cssText = 'opacity:0.7;font-size:11px;letter-spacing:1.5px';
    codeLbl.textContent = 'ROOM';
    const codeVal = document.createElement( 'span' );
    codeVal.style.cssText = 'color:#FFCB47;font-weight:700;font-size:22px;letter-spacing:3px;flex:1';
    codeVal.textContent = multiplayer.room.roomCode;
    const copy = document.createElement( 'div' );
    copy.className = 'm-btn primary';
    copy.style.flex = '0 0 auto';
    copy.style.padding = '10px 14px';
    copy.textContent = 'COPY LINK';
    copy.addEventListener( 'click', () => {

        const url = ( typeof _shareUrl === 'function' ) ? _shareUrl( multiplayer.room.roomCode ) : multiplayer.room.roomCode;
        try {

            navigator.clipboard?.writeText( url ).then( () => {

                copy.textContent = 'COPIED';
                setTimeout( () => { copy.textContent = 'COPY LINK'; }, 1100 );

            } );

        } catch ( _ ) {}

    } );
    codeRow.append( codeLbl, codeVal, copy );
    sheet.appendChild( codeRow );

    // Status line.
    const stat = document.createElement( 'div' );
    stat.style.cssText = 'font-size:13px;margin:10px 0';
    if ( multiplayer.raceState === 'lobby' ) stat.textContent = `Players: ${ peers.length + 1 }` + ( peers.length === 0 ? ' · waiting for friends...' : '' );
    else if ( multiplayer.raceState === 'ready_check' ) {

        let readyCount = multiplayer.localReady ? 1 : 0;
        for ( const p of peers ) if ( multiplayer.readyMap.get( p )?.ready ) readyCount ++;
        stat.textContent = `${ readyCount }/${ peers.length + 1 } ready`;

    } else if ( multiplayer.raceState === 'countdown' ) stat.textContent = 'Starting...';
    else if ( multiplayer.raceState === 'racing' ) stat.innerHTML = '<span style="color:#5DD68F">● RACING</span>';
    else if ( multiplayer.raceState === 'finished' ) stat.innerHTML = `<span style="color:#FFCB47">★ ${ multiplayer.raceWinnerName } wins</span>`;
    sheet.appendChild( stat );

    // Player list.
    const list = document.createElement( 'div' );
    list.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-bottom:14px';
    const youRow = document.createElement( 'div' );
    youRow.style.cssText = 'display:flex;justify-content:space-between;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:12px';
    youRow.innerHTML = `<span style="color:#FFCB47">you</span><span style="opacity:0.7">${ ( typeof currentCar !== 'undefined' && currentCar ) ? currentCar.name : '' }</span>`;
    list.appendChild( youRow );
    for ( const p of peers ) {

        const meta = multiplayer.metaByPeer && multiplayer.metaByPeer.get( p );
        const nm = ( meta && meta.name ) || p.slice( 0, 6 );
        const car = ( meta && typeof CARS !== 'undefined' && CARS[ meta.carIdx ] ) ? CARS[ meta.carIdx ].name : '?';
        const row = document.createElement( 'div' );
        row.style.cssText = 'display:flex;justify-content:space-between;padding:10px 12px;background:rgba(255,255,255,0.04);border-radius:8px;font-size:12px';
        row.innerHTML = `<span>${ nm }</span><span style="opacity:0.6">${ car }</span>`;
        list.appendChild( row );

    }
    sheet.appendChild( list );

    // Action buttons.
    const actions = document.createElement( 'div' );
    actions.className = 'm-btn-row';

    if ( multiplayer.raceState === 'lobby' || multiplayer.raceState === 'finished' ) {

        actions.appendChild( _drawerBtn(
            multiplayer.raceState === 'finished' ? 'RACE AGAIN' : 'START RACE',
            () => { if ( typeof _startRace === 'function' ) _startRace(); setTimeout( _renderMobileMpModal, 50 ); },
            true
        ) );

    } else if ( multiplayer.raceState === 'ready_check' && ! multiplayer.localReady ) {

        const ready = _drawerBtn( 'READY', () => { if ( typeof _toggleReady === 'function' ) _toggleReady(); setTimeout( _renderMobileMpModal, 50 ); }, true );
        ready.style.background = 'rgba(93,214,143,0.2)';
        ready.style.borderColor = 'rgba(93,214,143,0.6)';
        ready.style.color = '#5DD68F';
        actions.appendChild( ready );

    }

    const leave = _drawerBtn( 'LEAVE ROOM', () => {

        if ( typeof _leaveRoom === 'function' ) _leaveRoom();
        _toggleMobileMpModal( false );

    } );
    leave.classList.add( 'danger' );
    actions.appendChild( leave );

    sheet.appendChild( actions );

}

function applyMobileLayout() {

    // Always keep the body classes in sync; cheap if unchanged.
    _updateDeviceState();
    const isMobile = device.touchOnly;

    if ( isMobile ) _ensureMobileChrome();

    // Toggle mobile-only chrome visibility (in case state flipped).
    if ( device.hamburgerEl ) device.hamburgerEl.style.display = isMobile ? 'flex' : 'none';
    if ( device.fpsChipEl ) device.fpsChipEl.style.display = isMobile ? 'block' : 'none';

    // If we just flipped to desktop, close any open mobile sheets.
    if ( ! isMobile ) {

        _toggleMobileDrawer( false );
        _toggleMobileMpModal( false );

    }

    // Re-layout the touch overlay if it exists.
    if ( ! touch.enabled || ! touch.rootEl ) return;

    const W = window.innerWidth;
    const H = window.innerHeight;
    const safeBottom = parseInt( getComputedStyle( document.documentElement ).getPropertyValue( '--sa-bottom' ) ) || 0;
    const safeRight  = parseInt( getComputedStyle( document.documentElement ).getPropertyValue( '--sa-right' ) ) || 0;
    const safeLeft   = parseInt( getComputedStyle( document.documentElement ).getPropertyValue( '--sa-left' ) ) || 0;

    const portrait = device.portrait;
    if ( touch.rootEl ) {

        touch.rootEl.classList.toggle( 'is-portrait', portrait );
        touch.rootEl.classList.toggle( 'is-landscape', ! portrait );

    }

    // Pedals — portrait: tall thin bars stacked vertically (throttle on top
    // of brake) on the right edge for the right thumb. Landscape: same idea,
    // a touch wider, side-by-side throttle+brake on the right edge.
    const pedalW = portrait ? 80 : 96;
    const pedalH = portrait ? Math.min( 220, Math.floor( H * 0.42 ) ) : Math.min( 200, H - 140 );

    if ( touch.throttleBarEl && touch.brakeBarEl ) {

        const tBar = touch.throttleBarEl;
        const bBar = touch.brakeBarEl;
        tBar.style.position = 'absolute';
        bBar.style.position = 'absolute';
        tBar.style.width = pedalW + 'px';
        bBar.style.width = pedalW + 'px';
        tBar.style.height = pedalH + 'px';
        bBar.style.height = pedalH + 'px';

        if ( portrait ) {

            // Throttle on top, brake below; both flush to right edge.
            const right = 14 + safeRight;
            const bottomBrake = 14 + safeBottom;
            const bottomThrottle = bottomBrake + pedalH + 10;
            tBar.style.right = right + 'px'; tBar.style.left = '';
            tBar.style.bottom = bottomThrottle + 'px'; tBar.style.top = '';
            bBar.style.right = right + 'px'; bBar.style.left = '';
            bBar.style.bottom = bottomBrake + 'px'; bBar.style.top = '';

        } else {

            // Landscape: side-by-side on right edge — throttle outer, brake inner.
            const baseRight = 14 + safeRight;
            const bottom = 14 + safeBottom;
            tBar.style.right = baseRight + 'px'; tBar.style.left = '';
            tBar.style.bottom = bottom + 'px'; tBar.style.top = '';
            bBar.style.right = ( baseRight + pedalW + 10 ) + 'px'; bBar.style.left = '';
            bBar.style.bottom = bottom + 'px'; bBar.style.top = '';

        }

    }

    // HB / shift cluster — vertical stack to the left of the pedals.
    if ( touch.clusterEl ) {

        const cl = touch.clusterEl;
        if ( portrait ) {

            // Sit above the brake (which is the lower pedal) on the right edge.
            const right = 14 + safeRight + pedalW + 12;
            const bottom = 14 + safeBottom; // align with brake bottom roughly
            cl.style.right = right + 'px'; cl.style.left = '';
            cl.style.bottom = bottom + 'px'; cl.style.top = '';

        } else {

            // Landscape: between the inner brake column and the steer pad.
            const right = 14 + safeRight + ( pedalW * 2 + 20 ) + 12;
            const bottom = 14 + safeBottom;
            cl.style.right = right + 'px'; cl.style.left = '';
            cl.style.bottom = bottom + 'px'; cl.style.top = '';

        }

    }

    // Steer pad — bottom-left zone, sized to half the screen height-ish.
    if ( touch.padEl ) {

        const pad = touch.padEl;
        if ( portrait ) {

            pad.style.left = ( safeLeft ) + 'px';
            pad.style.right = '';
            pad.style.bottom = '0';
            pad.style.top = '';
            pad.style.width = Math.floor( W * 0.55 ) + 'px';
            pad.style.height = Math.floor( H * 0.45 ) + 'px';

        } else {

            pad.style.left = ( safeLeft ) + 'px';
            pad.style.right = '';
            pad.style.bottom = '0';
            pad.style.top = '';
            pad.style.width = Math.floor( W * 0.45 ) + 'px';
            pad.style.height = Math.floor( H * 0.6 ) + 'px';

        }

    }

    // Speedometer — recenter & nudge above pedal level so it never gets
    // covered by them. We mutate the inline styles set in initSpeedometer.
    if ( typeof speedoEl !== 'undefined' && speedoEl ) {

        if ( isMobile ) {

            const spdBottom = portrait
                ? ( safeBottom + pedalH * 2 + 30 ) // above the stacked pedals
                : ( safeBottom + 14 ); // landscape: sit at bottom-center, narrow row
            speedoEl.style.setProperty( 'bottom', spdBottom + 'px', 'important' );
            speedoEl.style.setProperty( 'left', '50%', 'important' );
            speedoEl.style.setProperty( 'transform', 'translateX(-50%)', 'important' );
            speedoEl.style.setProperty( 'padding', '6px 10px', 'important' );
            speedoEl.style.setProperty( 'gap', '10px', 'important' );
            speedoEl.style.setProperty( 'max-width', portrait ? `calc(100vw - ${ pedalW * 2 + 40 }px)` : '60vw', 'important' );
            // Shrink children for portrait — the gear digit + RPM bar both
            // dominate horizontally otherwise.
            if ( speedoGearEl ) speedoGearEl.style.setProperty( 'font-size', '24px', 'important' );
            if ( speedoNumEl ) speedoNumEl.style.setProperty( 'font-size', '22px', 'important' );
            if ( speedoRpmFillEl && speedoRpmFillEl.parentElement ) {

                speedoRpmFillEl.parentElement.style.setProperty( 'width', portrait ? '80px' : '120px', 'important' );

            }

        } else {

            // Restore defaults by removing our overrides.
            speedoEl.style.removeProperty( 'max-width' );
            // Other overrides simply re-apply if applyMobileLayout runs in
            // mobile mode again; they don't need clearing on desktop.

        }

    }

    // Lap timer — keep at bottom-left, but lift above safe area + pad.
    if ( typeof lapTimer !== 'undefined' && lapTimer && lapTimer.root ) {

        if ( isMobile ) {

            const lapBottom = portrait
                ? ( safeBottom + pedalH * 2 + 80 )
                : ( safeBottom + 80 );
            lapTimer.root.style.setProperty( 'bottom', lapBottom + 'px', 'important' );
            lapTimer.root.style.setProperty( 'left', ( safeLeft + 10 ) + 'px', 'important' );
            lapTimer.root.style.setProperty( 'z-index', '20', 'important' );

        } else {

            lapTimer.root.style.removeProperty( 'bottom' );
            lapTimer.root.style.removeProperty( 'left' );

        }

    }

    // Minimap — on mobile, anchor top-left below the FPS chip (so it doesn't
    // collide with the steer pad). Shrink for portrait small screens.
    if ( typeof minimap !== 'undefined' && minimap && minimap.containerEl ) {

        const wrap = minimap.containerEl;
        if ( isMobile ) {

            const size = portrait ? 120 : 140;
            wrap.style.setProperty( 'width', size + 'px', 'important' );
            wrap.style.setProperty( 'height', size + 'px', 'important' );
            wrap.style.setProperty( 'top', ( safeBottom + 40 ) + 'px', 'important' );
            wrap.style.setProperty( 'bottom', 'auto', 'important' );
            wrap.style.setProperty( 'left', ( safeLeft + 8 ) + 'px', 'important' );
            wrap.style.setProperty( 'right', 'auto', 'important' );
            // The internal canvas still renders at its original 200×200 buffer;
            // it'll just scale down via CSS — keeps the projection correct.
            if ( minimap.canvas ) {

                minimap.canvas.style.setProperty( 'width', size + 'px', 'important' );
                minimap.canvas.style.setProperty( 'height', size + 'px', 'important' );

            }

        } else {

            wrap.style.removeProperty( 'width' );
            wrap.style.removeProperty( 'height' );
            wrap.style.removeProperty( 'top' );
            wrap.style.removeProperty( 'bottom' );
            wrap.style.removeProperty( 'left' );
            wrap.style.removeProperty( 'right' );
            if ( minimap.canvas ) {

                minimap.canvas.style.removeProperty( 'width' );
                minimap.canvas.style.removeProperty( 'height' );

            }

        }

    }

}

// ---------------- stats-for-nerds (F3 / button toggle) ----------------

function _sStat( section, label, id, hint ) {

    const row = document.createElement( 'div' );
    row.style.cssText = 'display:flex;justify-content:space-between;gap:10px;font-size:11px;line-height:1.55';
    const lbl = document.createElement( 'span' );
    lbl.textContent = label;
    lbl.style.cssText = 'opacity:0.62';
    if ( hint ) lbl.title = hint;
    const val = document.createElement( 'span' );
    val.style.cssText = 'font-weight:600;text-align:right;font-variant-numeric:tabular-nums';
    val.textContent = '—';
    statsForNerds.fields[ id ] = val;
    row.appendChild( lbl );
    row.appendChild( val );
    section.appendChild( row );

}

function _sSection( panel, title ) {

    const h = document.createElement( 'div' );
    h.textContent = title;
    h.style.cssText = 'margin:10px 0 4px;font-size:10px;letter-spacing:1.5px;color:#FFCB47;border-bottom:1px solid rgba(255,203,71,0.25);padding-bottom:2px';
    panel.appendChild( h );
    const sec = document.createElement( 'div' );
    panel.appendChild( sec );
    return sec;

}

function _sGraph( panel, label, id, w, h, color, min, max ) {

    const wrap = document.createElement( 'div' );
    wrap.style.cssText = 'margin-top:6px';
    const lab = document.createElement( 'div' );
    lab.textContent = label;
    lab.style.cssText = 'font-size:10px;opacity:0.62;margin-bottom:2px;display:flex;justify-content:space-between';
    const labRange = document.createElement( 'span' );
    labRange.textContent = `${ min }–${ max }`;
    labRange.style.opacity = '0.5';
    lab.appendChild( labRange );
    wrap.appendChild( lab );

    const canvas = document.createElement( 'canvas' );
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = `width:${ w }px;height:${ h }px;background:rgba(255,255,255,0.05);border-radius:3px;display:block`;
    wrap.appendChild( canvas );
    panel.appendChild( wrap );

    statsForNerds.graphs[ id ] = { canvas, ctx: canvas.getContext( '2d' ), buffer: [], capacity: w, color, min, max };

}

function pushAndDrawGraph( id, v ) {

    const g = statsForNerds.graphs[ id ];
    if ( ! g ) return;
    g.buffer.push( v );
    if ( g.buffer.length > g.capacity ) g.buffer.shift();
    if ( ! statsForNerds.enabled ) return;

    const { ctx, canvas, buffer, color, min, max } = g;
    const w = canvas.width;
    const hh = canvas.height;
    ctx.clearRect( 0, 0, w, hh );

    // baseline mid-line for zero-ish reference
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect( 0, hh - 1, w, 1 );

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for ( let i = 0; i < buffer.length; i ++ ) {

        const x = w - buffer.length + i;
        const t = ( buffer[ i ] - min ) / ( max - min );
        const y = hh - Math.max( 0, Math.min( 1, t ) ) * hh;
        if ( i === 0 ) ctx.moveTo( x, y ); else ctx.lineTo( x, y );

    }
    ctx.stroke();

}

// Top-down rectangle of the four tires. Each tire shows its temperature, wear
// %, and a background colour ramped from blue (cold) → green (optimal 80 °C)
// → red (overheated 140 °C).
function _sTireWidget( panel ) {

    const wrap = document.createElement( 'div' );
    wrap.style.cssText = 'margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:6px';
    panel.appendChild( wrap );

    const labels = [ 'FL', 'FR', 'RL', 'RR' ];
    statsForNerds.tireBoxes = [];

    for ( let i = 0; i < 4; i ++ ) {

        const tire = document.createElement( 'div' );
        tire.style.cssText = [
            'padding:6px 8px', 'border-radius:5px',
            'background:hsl(220,65%,42%)', 'color:#fff',
            'display:flex', 'flex-direction:column', 'gap:1px',
            'transition:background 120ms linear',
            'box-shadow:inset 0 0 0 1px rgba(255,255,255,0.08)'
        ].join( ';' );

        const labelEl = document.createElement( 'div' );
        labelEl.textContent = labels[ i ];
        labelEl.style.cssText = 'font-size:9px;opacity:0.78;letter-spacing:1.8px;font-weight:600';

        const heatEl = document.createElement( 'div' );
        heatEl.style.cssText = 'font-size:16px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums';
        heatEl.textContent = '40°';

        const wearEl = document.createElement( 'div' );
        wearEl.style.cssText = 'font-size:11px;opacity:0.92;font-variant-numeric:tabular-nums';
        wearEl.textContent = '100%';

        tire.appendChild( labelEl );
        tire.appendChild( heatEl );
        tire.appendChild( wearEl );
        wrap.appendChild( tire );

        statsForNerds.tireBoxes.push( { el: tire, heatEl, wearEl } );

    }

}

function _heatToColor( heat ) {

    // 20 °C → hue 220 (deep blue, cold) · 80 °C → hue 120 (green, optimal)
    // 140 °C → hue 0 (red, overheated). Smooth HSL interpolation.
    const t = Math.max( 0, Math.min( 1, ( heat - 20 ) / 120 ) );
    const hue = 220 - t * 220;
    // Pull saturation up at the extremes so cold/hot read more strongly.
    const sat = 60 + Math.abs( t - 0.5 ) * 30;
    return `hsl(${ hue.toFixed( 0 ) },${ sat.toFixed( 0 ) }%,42%)`;

}

function updateTireWidget() {

    if ( ! statsForNerds.enabled || ! statsForNerds.tireBoxes ) return;
    for ( let i = 0; i < 4; i ++ ) {

        const box = statsForNerds.tireBoxes[ i ];
        const heat = tires.heat[ i ];
        const wear = tires.wear[ i ];
        box.heatEl.textContent = heat.toFixed( 0 ) + '°';
        box.wearEl.textContent = ( wear * 100 ).toFixed( 0 ) + '%';
        box.el.style.background = _heatToColor( heat );

    }

}

// 4-line graph for per-tire metrics. Each tire has its own colour line.
function _sMultiGraph( panel, label, id, w, h, colors, legendLabels, min, max ) {

    const wrap = document.createElement( 'div' );
    wrap.style.cssText = 'margin-top:6px';

    const lab = document.createElement( 'div' );
    lab.style.cssText = 'font-size:10px;opacity:0.62;margin-bottom:2px;display:flex;justify-content:space-between;align-items:center';
    const labTitle = document.createElement( 'span' );
    labTitle.textContent = label;
    lab.appendChild( labTitle );

    // Tiny inline legend on the right of the header — 4 colour dots + labels.
    const legend = document.createElement( 'span' );
    legend.style.cssText = 'display:inline-flex;gap:6px';
    for ( let i = 0; i < colors.length; i ++ ) {

        const item = document.createElement( 'span' );
        item.style.cssText = 'display:inline-flex;align-items:center;gap:3px;opacity:0.85';
        const dot = document.createElement( 'span' );
        dot.style.cssText = `display:inline-block;width:7px;height:7px;border-radius:2px;background:${ colors[ i ] }`;
        item.appendChild( dot );
        const lbl = document.createElement( 'span' );
        lbl.textContent = legendLabels[ i ];
        lbl.style.fontSize = '9px';
        item.appendChild( lbl );
        legend.appendChild( item );

    }
    lab.appendChild( legend );

    wrap.appendChild( lab );

    const canvas = document.createElement( 'canvas' );
    canvas.width = w;
    canvas.height = h;
    canvas.style.cssText = `width:${ w }px;height:${ h }px;background:rgba(255,255,255,0.05);border-radius:3px;display:block`;
    wrap.appendChild( canvas );
    panel.appendChild( wrap );

    statsForNerds.graphs[ id ] = {
        canvas, ctx: canvas.getContext( '2d' ),
        buffers: colors.map( () => [] ),
        capacity: w, colors, min, max, multi: true
    };

}

function pushAndDrawMultiGraph( id, values ) {

    const g = statsForNerds.graphs[ id ];
    if ( ! g || ! g.multi ) return;
    for ( let i = 0; i < g.buffers.length; i ++ ) {

        g.buffers[ i ].push( values[ i ] );
        if ( g.buffers[ i ].length > g.capacity ) g.buffers[ i ].shift();

    }
    if ( ! statsForNerds.enabled ) return;

    const { ctx, canvas, buffers, colors, min, max } = g;
    const w = canvas.width;
    const hh = canvas.height;
    ctx.clearRect( 0, 0, w, hh );
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect( 0, hh - 1, w, 1 );

    ctx.lineWidth = 1.2;
    for ( let line = 0; line < buffers.length; line ++ ) {

        const buf = buffers[ line ];
        if ( buf.length === 0 ) continue;
        ctx.strokeStyle = colors[ line ];
        ctx.beginPath();
        for ( let i = 0; i < buf.length; i ++ ) {

            const x = w - buf.length + i;
            const t = ( buf[ i ] - min ) / ( max - min );
            const y = hh - Math.max( 0, Math.min( 1, t ) ) * hh;
            if ( i === 0 ) ctx.moveTo( x, y ); else ctx.lineTo( x, y );

        }
        ctx.stroke();

    }

}

// ---------------- joystick directional map ----------------
//
// Embedded inside the stats-for-nerds panel — 108×108 canvas centered in a
// dedicated section. X axis = steering (left = left, right = right), Y axis
// = throttle (up) / brake (down). Two dots overlap: a faint dot for the raw
// merged input (pre-shape) and a bright dot for the shaped value that the
// physics actually uses. Useful for spotting controller drift, asymmetric
// inputs, and the steering curve's reshaping at a glance.

const joystickMap = {
    canvas: null,
    ctx: null,
    subEl: null
};

function initJoystickMap( parent ) {

    const wrap = document.createElement( 'div' );
    wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;margin-top:6px';

    const canvas = document.createElement( 'canvas' );
    canvas.width = 108;
    canvas.height = 108;
    canvas.style.cssText = 'display:block;background:rgba(255,255,255,0.04);border-radius:4px';
    wrap.appendChild( canvas );

    const sub = document.createElement( 'div' );
    sub.style.cssText = 'margin-top:3px;font-size:9px;opacity:0.7;font-variant-numeric:tabular-nums;letter-spacing:0.3px';
    sub.textContent = 'S 0.00 · T 0.00';
    wrap.appendChild( sub );

    parent.appendChild( wrap );
    joystickMap.canvas = canvas;
    joystickMap.ctx = canvas.getContext( '2d' );
    joystickMap.subEl = sub;

}

function renderJoystickMap() {

    if ( ! joystickMap.ctx ) return;
    const ctx = joystickMap.ctx;
    const w = joystickMap.canvas.width;
    const h = joystickMap.canvas.height;
    const cx = w * 0.5;
    const cy = h * 0.5;
    const r = w * 0.5 - 6;

    ctx.clearRect( 0, 0, w, h );

    // Crosshair axes.
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo( 0, cy ); ctx.lineTo( w, cy );
    ctx.moveTo( cx, 0 ); ctx.lineTo( cx, h );
    ctx.stroke();

    // Outer ring + deadzone ring (matches steeringCfg.deadzone visually).
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.beginPath();
    ctx.arc( cx, cy, r, 0, Math.PI * 2 );
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    ctx.arc( cx, cy, r * steeringCfg.deadzone, 0, Math.PI * 2 );
    ctx.stroke();

    // Vertical axis is throttle (up) and brake (down). We map their
    // difference so the dot sits at the dominant pedal — brake-only goes
    // down, throttle-only goes up, both pressed cancels toward center.
    // X axis is negated because the keyboard convention is A → +steer
    // (engine turns left), but on a stick map we want left input → left dot.
    const sx = cx - input.steer * r;
    const verticalAxis = input.throttle - input.brake;
    const sy = cy - verticalAxis * r;

    // Raw merged input (pre-shape) — faint dot. When the wheel curve is
    // softening the input, this dot sits further from center than the
    // bright one, making the curve visible at a glance.
    const rx = cx - input.steerRaw * r;
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.beginPath();
    ctx.arc( rx, sy, 3, 0, Math.PI * 2 );
    ctx.fill();

    // Shaped input — bright dot + trail from center.
    ctx.strokeStyle = 'rgba(255,203,71,0.45)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo( cx, cy );
    ctx.lineTo( sx, sy );
    ctx.stroke();
    ctx.fillStyle = '#FFCB47';
    ctx.beginPath();
    ctx.arc( sx, sy, 4.5, 0, Math.PI * 2 );
    ctx.fill();

    // Status badges. Top-right column: TC (red engaged / grey OFF) above
    // ABS (cyan engaged / grey OFF). Top-left: HB (cyan) when handbrake is
    // pulled. Bottom-left: REC + countdown when telemetry is recording.
    ctx.font = 'bold 9px Monospace';
    ctx.textAlign = 'right';
    if ( ! tcCfg.enabled ) {

        ctx.fillStyle = 'rgba(200,200,200,0.55)';
        ctx.fillText( 'TC OFF', w - 4, 11 );

    } else if ( drivetrain.tc.engaged ) {

        ctx.fillStyle = 'rgba(255,90,90,0.90)';
        ctx.fillText( 'TC', w - 4, 11 );

    }
    if ( ! absCfg.enabled ) {

        ctx.fillStyle = 'rgba(200,200,200,0.55)';
        ctx.fillText( 'ABS OFF', w - 4, 22 );

    } else if ( drivetrain.abs.engaged ) {

        ctx.fillStyle = 'rgba(120,200,255,0.90)';
        ctx.fillText( 'ABS', w - 4, 22 );

    }
    if ( input.handbrake > 0.5 ) {

        ctx.fillStyle = 'rgba(120,200,255,0.90)';
        ctx.textAlign = 'left';
        ctx.fillText( 'HB', 4, 11 );

    }
    if ( telemetry.recording ) {

        const remaining = Math.max( 0, ( telemetry.startedAt + telemetry.durationMs - performance.now() ) / 1000 );
        ctx.fillStyle = 'rgba(255,90,90,0.95)';
        ctx.textAlign = 'left';
        ctx.fillText( `● REC ${ remaining.toFixed( 0 ) }s`, 4, h - 4 );

    }

    if ( joystickMap.subEl ) {

        joystickMap.subEl.textContent = `S ${ input.steerRaw.toFixed( 2 ) } · T ${ verticalAxis.toFixed( 2 ) }`;

    }

}

// ---------------- T-key telemetry recorder (Trackmania-style) ----------------
//
// Press T to capture 60 s of per-frame input + output vectors at ~60 Hz.
// At the end (or on second T press) the buffer is downloaded as a single
// JSON file with header metadata + a samples array. Designed for offline
// inspection / replay tooling, not for live broadcast.

function startTelemetryRecording() {

    telemetry.recording = true;
    telemetry.startedAt = performance.now();
    telemetry.lastSampleAt = 0;
    telemetry.samples = [];
    console.log( '[telemetry] recording started — 60s' );

}

function stopTelemetryRecording( download ) {

    if ( ! telemetry.recording ) return;
    telemetry.recording = false;
    const sampleCount = telemetry.samples.length;
    if ( ! download ) {

        console.log( `[telemetry] aborted (${ sampleCount } samples discarded)` );
        telemetry.samples = [];
        return;

    }
    const elapsedMs = performance.now() - telemetry.startedAt;
    const payload = {
        format: 'race_in_progress.telemetry.v1',
        recordedAt: new Date().toISOString(),
        car: currentCar.name,
        driveType: currentCar.driveType,
        brakeBias: currentCar.brakeBias != null ? currentCar.brakeBias : 0.5,
        map: currentMapId,
        durationMs: Math.round( elapsedMs ),
        sampleCount,
        steeringCfg: { ...steeringCfg },
        tcCfg: { ...tcCfg },
        absCfg: { ...absCfg },
        samples: telemetry.samples
    };
    const blob = new Blob( [ JSON.stringify( payload ) ], { type: 'application/json' } );
    const url = URL.createObjectURL( blob );
    const a = document.createElement( 'a' );
    const stamp = new Date().toISOString().replace( /[:.]/g, '-' );
    a.href = url;
    a.download = `telemetry_${ currentCar.name.replace( /\s+/g, '' ) }_${ stamp }.json`;
    document.body.appendChild( a );
    a.click();
    document.body.removeChild( a );
    setTimeout( () => URL.revokeObjectURL( url ), 1000 );
    telemetry.lastDownloadedSize = blob.size;
    console.log( `[telemetry] recorded ${ sampleCount } samples (${ ( elapsedMs / 1000 ).toFixed( 1 ) } s, ${ ( blob.size / 1024 ).toFixed( 1 ) } KiB) → downloaded` );
    telemetry.samples = [];

}

function captureTelemetrySample( now ) {

    if ( ! telemetry.recording || ! chassis || ! vehicleController ) return;

    // Auto-stop at the 60 s mark.
    if ( now - telemetry.startedAt >= telemetry.durationMs ) {

        stopTelemetryRecording( true );
        return;

    }

    // Throttle to the nominal sample rate so we don't bloat the buffer on
    // high-refresh displays. At 60 Hz this still gives ~3600 samples / minute.
    const minIntervalMs = 1000 / telemetry.sampleHz;
    if ( telemetry.lastSampleAt && now - telemetry.lastSampleAt < minIntervalMs ) return;
    telemetry.lastSampleAt = now;

    const t = chassis.translation();
    const v = chassis.linvel();
    const av = chassis.angvel();
    const q = chassis.rotation();
    const wheels = [];
    for ( let i = 0; i < 4; i ++ ) {

        wheels.push( {
            slipR: tires.slipRatio[ i ],
            slipA: tires.slipAngle[ i ],
            fwdI: vehicleController.wheelForwardImpulse( i ),
            sideI: vehicleController.wheelSideImpulse( i ),
            engineF: vehicleController.wheelEngineForce( i ),
            brake: vehicleController.wheelBrake( i ),
            contact: vehicleController.wheelIsInContact( i ) ? 1 : 0
        } );

    }
    telemetry.samples.push( {
        t: Math.round( now - telemetry.startedAt ),
        input: {
            steerRaw: input.steerRaw,
            steer: input.steer,
            throttle: input.throttle,
            brake: input.brake,
            handbrake: input.handbrake,
            reverse: input.reverseEngaged ? 1 : 0
        },
        output: {
            steerTarget: steeringTelemetry.target,
            steerActual: steeringTelemetry.actual,
            speedMs: vehicleController.currentVehicleSpeed(),
            gear: transmission.gear,
            rpm: engine.rpm,
            tcCutPct: drivetrain.tc.cutPct,
            absCutPct: drivetrain.abs.cutPct,
            pos: [ t.x, t.y, t.z ],
            rot: [ q.x, q.y, q.z, q.w ],
            vel: [ v.x, v.y, v.z ],
            angVel: [ av.x, av.y, av.z ],
            wheels
        }
    } );

}

function initStatsForNerds() {

    // Toggle button — small pill below the three.js Stats overlay. Top is
    // set dynamically in _positionStatsBelowInfo() so it tracks #info's
    // height as that panel grows (volume slider, minimap toggle, etc.).
    statsForNerds.toggleBtn = document.createElement( 'div' );
    statsForNerds.toggleBtn.className = 'stats-nerds-toggle';
    statsForNerds.toggleBtn.style.cssText = [
        'position:absolute', 'top:240px', 'right:10px',
        'padding:5px 9px', 'background:rgba(0,0,0,0.55)', 'color:#fff',
        'font:11px Monospace', 'border-radius:4px', 'z-index:3',
        'cursor:pointer', 'user-select:none',
        'border:1px solid rgba(255,255,255,0.15)'
    ].join( ';' );
    statsForNerds.toggleBtn.innerHTML = `${ iconHTML( 'bar-chart-3', 13 ) } <span style="margin-left:6px">stats for nerds</span>`;
    statsForNerds.toggleBtn.style.display = 'inline-flex';
    statsForNerds.toggleBtn.style.alignItems = 'center';
    statsForNerds.toggleBtn.title = 'F3';
    statsForNerds.toggleBtn.addEventListener( 'click', toggleStatsForNerds );
    document.body.appendChild( statsForNerds.toggleBtn );

    // Panel. Anchored top-and-bottom so it always leaves room for the
    // speedometer / pos-pill at the bottom and content scrolls within.
    const panel = document.createElement( 'div' );
    panel.className = 'stats-nerds-panel';
    panel.style.cssText = [
        'position:absolute', 'top:240px', 'right:10px', 'bottom:110px',
        'padding:10px 12px 12px', 'background:rgba(0,0,0,0.72)', 'color:#fff',
        'font:11px Monospace', 'border-radius:6px', 'z-index:3',
        'min-width:300px', 'max-width:340px', 'overflow-y:auto',
        'display:none', 'border:1px solid rgba(255,255,255,0.18)',
        'box-shadow:0 6px 28px rgba(0,0,0,0.45)'
    ].join( ';' );

    // header with close button
    const header = document.createElement( 'div' );
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;margin-bottom:4px';
    const title = document.createElement( 'div' );
    title.innerHTML = `${ iconHTML( 'bar-chart-3', 13 ) } <span style="margin-left:6px">STATS FOR NERDS</span>`;
    title.style.cssText = 'font-size:11px;letter-spacing:1.5px;opacity:0.85;display:inline-flex;align-items:center';
    header.appendChild( title );
    const close = document.createElement( 'div' );
    close.innerHTML = iconHTML( 'x', 14 );
    close.style.cssText = 'cursor:pointer;padding:0 4px;opacity:0.7;display:inline-flex';
    close.addEventListener( 'click', toggleStatsForNerds );
    header.appendChild( close );
    panel.appendChild( header );

    // --- sections ---
    const drive = _sSection( panel, 'DRIVER INPUT' );
    _sStat( drive, 'throttle', 's_throttle' );
    _sStat( drive, 'brake', 's_brake' );
    _sStat( drive, 'steer (raw)', 's_steer_raw', 'pre-curve merged input from keyboard / gamepad / touch' );
    _sStat( drive, 'steer (shaped)', 's_steer', 'after deadzone + curve — drives the wheel target' );
    _sStat( drive, 'deadzone state', 's_deadzone', 'IN means raw input is inside the deadzone and snapped to 0' );
    _sStat( drive, 'handbrake', 's_handbrake' );
    _sStat( drive, 'reverse engaged', 's_reverse' );
    initJoystickMap( drive );

    const steer = _sSection( panel, 'STEERING PIPELINE' );
    _sStat( steer, 'max angle', 's_maxAngle', 'speed-scaled mechanical max steering angle' );
    _sStat( steer, 'speed factor', 's_speedFactor', '1.0 at standstill, drops to minFactor at vReduceMax' );
    _sStat( steer, 'target angle', 's_steerTarget', 'desired wheel angle this frame' );
    _sStat( steer, 'actual angle', 's_steerActual', 'smoothed angle written to the controller' );
    _sStat( steer, 'residual drift', 's_residual', 'absolute wheel offset when input is centered (should be ≈0)' );
    _sStat( steer, 'curve · dz', 's_curveCfg', 'live curve exponent · deadzone' );
    _sMultiGraph( panel, 'steer', 'g_steer', 280, 36,
        [ '#FFFFFFAA', '#FFCB47', '#7BD37F' ],
        [ 'raw', 'shaped', 'actual' ],
        - 1.1, 1.1 );

    const tc = _sSection( panel, 'TRACTION CONTROL (N)' );
    _sStat( tc, 'status', 's_tc_status', 'ON / OFF / ENGAGED — engaged is sticky for ~120ms' );
    _sStat( tc, 'cut %', 's_tc_cut', 'largest fractional torque cut across driven wheels this frame' );
    _sStat( tc, 'events', 's_tc_count', 'number of distinct TC engagements since session start' );
    _sStat( tc, 'thresholds', 's_tc_cfg', 'slip threshold · cut gain · min mult' );
    _sGraph( panel, 'TC cut %', 'g_tc', 280, 28, '#FF6464', 0, 1 );

    const ab = _sSection( panel, 'ABS (B)' );
    _sStat( ab, 'status', 's_abs_status', 'ON / OFF / ENGAGED — engaged is sticky for ~120ms' );
    _sStat( ab, 'cut %', 's_abs_cut', 'largest fractional brake cut across the four wheels this frame' );
    _sStat( ab, 'events', 's_abs_count', 'number of distinct ABS engagements since session start' );
    _sStat( ab, 'brake bias', 's_abs_bias', 'fraction of total brake force routed to the front axle' );
    _sGraph( panel, 'ABS cut %', 'g_abs', 280, 28, '#64C8FF', 0, 1 );

    const rec = _sSection( panel, 'TELEMETRY RECORDER (T)' );
    _sStat( rec, 'state', 's_rec_state' );
    _sStat( rec, 'remaining', 's_rec_remaining' );
    _sStat( rec, 'samples', 's_rec_samples' );
    _sStat( rec, 'last dump', 's_rec_last' );

    const drv = _sSection( panel, 'DRIVETRAIN' );
    _sStat( drv, 'mode', 's_mode' );
    _sStat( drv, 'layout', 's_layout', 'drivetrain layout: FWD / RWD / AWD' );
    _sStat( drv, 'gear', 's_gear' );
    _sStat( drv, 'engine RPM', 's_rpm' );
    _sStat( drv, 'norm. torque', 's_torque', 'torque curve value at current RPM' );
    _sStat( drv, 'wheel engine F', 's_engineF', 'total engine force summed across all driven wheels' );
    _sStat( drv, 'clutch', 's_clutch', 'open during shifts / neutral, otherwise closed with slip torque' );
    _sStat( drv, 'axle bias', 's_lsdbias', 'engine force split front : rear (FWD=100:0, RWD=0:100, AWD≈50:50)' );
    _sStat( drv, 'speed', 's_speed' );

    _sGraph( panel, 'RPM', 'g_rpm', 280, 36, '#F5D04A', 0, 7500 );
    _sGraph( panel, 'speed (km/h)', 'g_speed', 280, 36, '#7BD37F', 0, 220 );

    const wh = _sSection( panel, 'WHEELS · FL · FR · RL · RR' );
    _sStat( wh, 'contact', 's_w_contact' );
    _sStat( wh, 'susp. len', 's_w_susp' );
    _sStat( wh, 'susp. force', 's_w_suspF' );
    _sStat( wh, 'fwd impulse', 's_w_fwdI' );
    _sStat( wh, 'side impulse', 's_w_sideI' );
    _sStat( wh, 'slip ratio', 's_w_slipR', 'longitudinal slip — peak grip near ±0.14' );
    _sStat( wh, 'slip angle °', 's_w_slipA', 'lateral slip in degrees — peak grip near ±7°' );
    _sStat( wh, 'grip mult', 's_w_gripm', 'pacejka × heat × pressure × wear' );
    _sStat( wh, 'pressure kPa', 's_w_press', 'cold 200 kPa → optimal 230 kPa' );
    _sStat( wh, 'carcass °C', 's_w_carc', 'slow thermal reservoir' );
    _sStat( wh, 'brake', 's_w_brake' );
    _sTireWidget( wh );

    const aero = _sSection( panel, 'AERO' );
    _sStat( aero, 'downforce N', 's_downf', 'Cl × v² applied -Y' );
    _sStat( aero, 'drag N', 's_drag', 'Cd × v² opposite velocity' );
    _sStat( aero, 'Cd · Cl', 's_aerocoef' );

    const susp = _sSection( panel, 'SUSPENSION GEOMETRY' );
    _sStat( susp, 'camber FL/FR/RL/RR', 's_camber' );
    _sStat( susp, 'toe FL/FR/RL/RR', 's_toe' );

    const ch = _sSection( panel, 'CHASSIS' );
    _sStat( ch, 'pos', 's_pos' );
    _sStat( ch, 'velocity (m/s)', 's_vel' );
    _sStat( ch, 'ang. velocity', 's_angvel' );
    _sStat( ch, 'pitch · yaw · roll', 's_pyr' );

    const sim = _sSection( panel, 'SIM' );
    _sStat( sim, 'Δt frame', 's_dt' );
    _sStat( sim, 'target fps', 's_targetfps' );
    _sStat( sim, 'gamepad', 's_pad' );
    _sStat( sim, 'track triangles', 's_tris' );

    document.body.appendChild( panel );
    statsForNerds.panel = panel;

}

function _positionStatsBelowInfo() {

    const infoEl = document.getElementById( 'info' );
    if ( ! infoEl || ! statsForNerds.toggleBtn ) return;
    const top = Math.round( infoEl.getBoundingClientRect().bottom + 10 ) + 'px';
    // setProperty with 'important' beats the mobile media query rule that
    // pins the toggle to top:175px.
    statsForNerds.toggleBtn.style.setProperty( 'top', top, 'important' );
    if ( statsForNerds.panel ) statsForNerds.panel.style.setProperty( 'top', top, 'important' );

}

function toggleStatsForNerds() {

    statsForNerds.enabled = ! statsForNerds.enabled;
    if ( statsForNerds.enabled ) {

        statsForNerds.panel.style.display = 'block';
        statsForNerds.toggleBtn.style.display = 'none';

    } else {

        statsForNerds.panel.style.display = 'none';
        statsForNerds.toggleBtn.style.display = 'inline-flex';

    }

}

function _sset( id, txt ) {

    const el = statsForNerds.fields[ id ];
    if ( el ) el.textContent = txt;

}

const _eulerTmp = new THREE.Euler();
const _quatTmp = new THREE.Quaternion();

function updateStatsForNerds( speed ) {

    // Always push graph data even when hidden so opening the panel shows
    // recent history rather than starting from a flat line.
    pushAndDrawGraph( 'g_rpm', engine.rpm );
    pushAndDrawGraph( 'g_speed', Math.abs( speed ) * 3.6 );
    // Steering pipeline + TC traces always log so the graph carries history.
    // Normalize the actual wheel angle by the per-car mechanical max so
    // raw / shaped / actual all share the same -1..+1 axis.
    const carMax = currentCar ? currentCar.maxSteeringAngle : 1;
    pushAndDrawMultiGraph( 'g_steer', [
        input.steerRaw,
        input.steer,
        carMax > 0 ? steeringTelemetry.actual / carMax : 0
    ] );
    pushAndDrawGraph( 'g_tc', drivetrain.tc.cutPct );
    pushAndDrawGraph( 'g_abs', drivetrain.abs.cutPct );
    updateTireWidget();

    if ( ! statsForNerds.enabled || ! chassis ) return;

    _sset( 's_throttle', input.throttle.toFixed( 2 ) );
    _sset( 's_brake', input.brake.toFixed( 2 ) );
    _sset( 's_steer_raw', input.steerRaw.toFixed( 3 ) );
    _sset( 's_steer', input.steer.toFixed( 3 ) );
    const inDeadzone = Math.abs( input.steerRaw ) > 0 && Math.abs( input.steerRaw ) <= steeringCfg.deadzone;
    _sset( 's_deadzone', inDeadzone ? 'IN (snapped)' : ( input.steerRaw === 0 ? '—' : 'out' ) );
    _sset( 's_handbrake', input.handbrake.toFixed( 2 ) );
    _sset( 's_reverse', input.reverseEngaged ? 'YES' : 'no' );

    // Steering pipeline diagnostics.
    _sset( 's_maxAngle', `${ ( steeringTelemetry.maxAngle * 180 / Math.PI ).toFixed( 1 ) }°` );
    _sset( 's_speedFactor', steeringTelemetry.speedFactor.toFixed( 2 ) );
    _sset( 's_steerTarget', `${ ( steeringTelemetry.target * 180 / Math.PI ).toFixed( 1 ) }°` );
    _sset( 's_steerActual', `${ ( steeringTelemetry.actual * 180 / Math.PI ).toFixed( 1 ) }°` );
    // Residual drift: how far the wheel is from 0 when the input is centered.
    // Anything below ~0.05° is effectively zero; we colour the value if it lingers.
    const residualDeg = input.steerRaw === 0 ? Math.abs( steeringTelemetry.actual * 180 / Math.PI ) : 0;
    _sset( 's_residual', input.steerRaw === 0 ? `${ residualDeg.toFixed( 3 ) }°` : '— (input active)' );
    _sset( 's_curveCfg', `${ steeringCfg.curveExponent.toFixed( 2 ) } · ${ steeringCfg.deadzone.toFixed( 3 ) }` );

    // Traction control diagnostics.
    const tcStatus = ! tcCfg.enabled ? 'OFF'
        : drivetrain.tc.engaged ? 'ENGAGED'
        : 'armed';
    _sset( 's_tc_status', tcStatus );
    _sset( 's_tc_cut', `${ ( drivetrain.tc.cutPct * 100 ).toFixed( 1 ) }%` );
    _sset( 's_tc_count', String( drivetrain.tc.eventCount ) );
    _sset( 's_tc_cfg', `${ tcCfg.slipThreshold.toFixed( 2 ) } · ${ tcCfg.cutGain.toFixed( 1 ) } · ${ tcCfg.minMult.toFixed( 2 ) }` );

    // ABS diagnostics.
    const absStatus = ! absCfg.enabled ? 'OFF'
        : drivetrain.abs.engaged ? 'ENGAGED'
        : 'armed';
    _sset( 's_abs_status', absStatus );
    _sset( 's_abs_cut', `${ ( drivetrain.abs.cutPct * 100 ).toFixed( 1 ) }%` );
    _sset( 's_abs_count', String( drivetrain.abs.eventCount ) );
    const bias = currentCar.brakeBias != null ? currentCar.brakeBias : 0.5;
    _sset( 's_abs_bias', `F ${ ( bias * 100 ).toFixed( 0 ) } : R ${ ( ( 1 - bias ) * 100 ).toFixed( 0 ) }` );

    // Telemetry recorder.
    if ( telemetry.recording ) {

        const remaining = Math.max( 0, ( telemetry.startedAt + telemetry.durationMs - performance.now() ) / 1000 );
        _sset( 's_rec_state', '● RECORDING' );
        _sset( 's_rec_remaining', `${ remaining.toFixed( 1 ) } s` );

    } else {

        _sset( 's_rec_state', 'idle (press T)' );
        _sset( 's_rec_remaining', '—' );

    }
    _sset( 's_rec_samples', telemetry.samples.length.toString() );
    _sset( 's_rec_last', telemetry.lastDownloadedSize > 0
        ? `${ ( telemetry.lastDownloadedSize / 1024 ).toFixed( 1 ) } KiB`
        : '—' );

    _sset( 's_mode', transmission.mode.toUpperCase() );
    _sset( 's_layout', currentCar.driveType || 'FWD' );
    const g = transmission.gear;
    _sset( 's_gear', g === - 1 ? 'R' : g === 0 ? 'N' : g.toString() );
    _sset( 's_rpm', engine.rpm.toFixed( 0 ) );
    _sset( 's_torque', torqueAt( engine.rpm ).toFixed( 3 ) );
    // Total chassis engine force = sum across all wheels (zero on non-driven).
    let eTotal = 0;
    for ( let i = 0; i < 4; i ++ ) eTotal += Math.abs( vehicleController.wheelEngineForce( i ) );
    _sset( 's_engineF', eTotal.toFixed( 1 ) + ' N' );
    _sset( 's_speed', `${ ( Math.abs( speed ) * 3.6 ).toFixed( 1 ) } km/h · ${ Math.abs( speed ).toFixed( 2 ) } m/s` );

    // Clutch state + per-axle bias (display only — we use an even AWD split,
    // so AWD will show roughly 50:50 front:rear; FWD = 100:0, RWD = 0:100).
    _sset( 's_clutch', drivetrain.clutchOpen ? 'OPEN' : `slip ${ drivetrain.clutchTorque.toFixed( 1 ) }` );
    const eFront = Math.abs( vehicleController.wheelEngineForce( 0 ) ) + Math.abs( vehicleController.wheelEngineForce( 1 ) );
    const eRear  = Math.abs( vehicleController.wheelEngineForce( 2 ) ) + Math.abs( vehicleController.wheelEngineForce( 3 ) );
    const eAxle = Math.max( 0.01, eFront + eRear );
    _sset( 's_lsdbias', `F ${ ( eFront / eAxle * 100 ).toFixed( 0 ) } : R ${ ( eRear / eAxle * 100 ).toFixed( 0 ) }` );

    // Wheels — FL=0, FR=1, RL=2, RR=3 in our addWheel order.
    const wContact = [], wSusp = [], wSuspF = [], wFwdI = [], wSideI = [], wBrake = [];
    const wSlipR = [], wSlipA = [], wGripM = [], wPress = [], wCarc = [];
    for ( let i = 0; i < 4; i ++ ) {

        wContact.push( vehicleController.wheelIsInContact( i ) ? '✓' : '·' );
        wSusp.push( vehicleController.wheelSuspensionLength( i ).toFixed( 2 ) );
        wSuspF.push( vehicleController.wheelSuspensionForce( i ).toFixed( 0 ) );
        wFwdI.push( vehicleController.wheelForwardImpulse( i ).toFixed( 1 ) );
        wSideI.push( vehicleController.wheelSideImpulse( i ).toFixed( 1 ) );
        wBrake.push( vehicleController.wheelBrake( i ).toFixed( 2 ) );
        wSlipR.push( tires.slipRatio[ i ].toFixed( 2 ) );
        wSlipA.push( ( tires.slipAngle[ i ] * 180 / Math.PI ).toFixed( 1 ) );
        wGripM.push( tires.gripMult[ i ].toFixed( 2 ) );
        wPress.push( tires.pressure[ i ].toFixed( 0 ) );
        wCarc.push( tires.carcass[ i ].toFixed( 0 ) );

    }
    _sset( 's_w_contact', wContact.join( ' · ' ) );
    _sset( 's_w_susp', wSusp.join( ' · ' ) );
    _sset( 's_w_suspF', wSuspF.join( ' · ' ) );
    _sset( 's_w_fwdI', wFwdI.join( ' · ' ) );
    _sset( 's_w_sideI', wSideI.join( ' · ' ) );
    _sset( 's_w_slipR', wSlipR.join( ' · ' ) );
    _sset( 's_w_slipA', wSlipA.join( ' · ' ) );
    _sset( 's_w_gripm', wGripM.join( ' · ' ) );
    _sset( 's_w_press', wPress.join( ' · ' ) );
    _sset( 's_w_carc', wCarc.join( ' · ' ) );
    _sset( 's_w_brake', wBrake.join( ' · ' ) );

    // Aero + suspension geometry.
    const linv = chassis.linvel();
    const speed2 = linv.x * linv.x + linv.y * linv.y + linv.z * linv.z;
    const cd = currentCar.Cd || 0;
    const cl = currentCar.Cl || 0;
    _sset( 's_downf', ( cl * speed2 ).toFixed( 0 ) + ' N' );
    _sset( 's_drag', ( cd * speed2 ).toFixed( 0 ) + ' N' );
    _sset( 's_aerocoef', `${ cd.toFixed( 4 ) } · ${ cl.toFixed( 4 ) }` );
    const cm = currentCar.camberDeg || [ 0, 0, 0, 0 ];
    const tt = currentCar.toeDeg || [ 0, 0, 0, 0 ];
    _sset( 's_camber', cm.map( v => v.toFixed( 1 ) + '°' ).join( ' · ' ) );
    _sset( 's_toe', tt.map( v => v.toFixed( 2 ) + '°' ).join( ' · ' ) );

    const t = chassis.translation();
    const v = chassis.linvel();
    const av = chassis.angvel();
    const q = chassis.rotation();
    _quatTmp.set( q.x, q.y, q.z, q.w );
    _eulerTmp.setFromQuaternion( _quatTmp, 'YXZ' );

    _sset( 's_pos', `${ t.x.toFixed( 1 ) } · ${ t.y.toFixed( 1 ) } · ${ t.z.toFixed( 1 ) }` );
    _sset( 's_vel', `${ v.x.toFixed( 1 ) } · ${ v.y.toFixed( 1 ) } · ${ v.z.toFixed( 1 ) }` );
    _sset( 's_angvel', `${ av.x.toFixed( 2 ) } · ${ av.y.toFixed( 2 ) } · ${ av.z.toFixed( 2 ) }` );
    _sset( 's_pyr', `${ ( _eulerTmp.x * 180 / Math.PI ).toFixed( 1 ) }° · ${ ( _eulerTmp.y * 180 / Math.PI ).toFixed( 1 ) }° · ${ ( _eulerTmp.z * 180 / Math.PI ).toFixed( 1 ) }°` );

    _sset( 's_dt', `${ ( statsForNerds.lastDelta * 1000 ).toFixed( 2 ) } ms` );
    _sset( 's_targetfps', String( fpsTarget.target ) );
    _sset( 's_pad', gamepad.index >= 0 ? gamepad.id.slice( 0, 28 ) : '—' );
    _sset( 's_tris', _trackTris ? _trackTris.toLocaleString() : '?' );

}

let _trackTris = 0;

// ── seven low-poly car silhouettes (from the design subagent) ─────────────
const _visLightGeom = new THREE.BoxGeometry( 0.35, 0.18, 0.08 );

function _addCarMesh( parent, geom, mat, pos, rot ) {

    const m = new THREE.Mesh( geom, mat );
    if ( pos ) m.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
    if ( rot ) m.rotation.set( rot[ 0 ] || 0, rot[ 1 ] || 0, rot[ 2 ] || 0 );
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add( m );
    return m;

}

// Tag a taillight so the per-frame brake-light updater can find it. When
// `isReverse` is true we ALSO clone the material so we can swap that one
// taillight's colour to white in reverse without affecting the other.
function _addTaillight( parent, geom, mat, pos, isReverse ) {

    const material = isReverse ? mat.clone() : mat;
    const m = _addCarMesh( parent, geom, material, pos );
    m.userData.taillight = true;
    m.userData.baseEmissiveIntensity = material.emissiveIntensity;
    if ( isReverse ) {

        m.userData.reverseLight = true;
        m.userData.baseColor = material.color.getHex();
        m.userData.baseEmissiveColor = material.emissive.getHex();

    }
    return m;

}

function _buildHatchback( parent ) {

    // Stylized hot-hatch — Golf MkII / EG6 / 205 GTI vibe.
    // Layered body (lower tub + upper shoulder), sloped windshield + rear hatch glass,
    // 2-piece tapered cabin, short bonnet, distinct bumpers and corner chamfers.
    const bodyMat = new THREE.MeshStandardMaterial( { color: 0xFFCB47, roughness: 0.55, metalness: 0.15 } );
    const cabinMat = new THREE.MeshStandardMaterial( { color: 0x000000, roughness: 0.2, metalness: 0.6 } );
    const trimMat = new THREE.MeshStandardMaterial( { color: 0x2A2A2A, roughness: 0.7, metalness: 0.1 } );
    const bumperMat = new THREE.MeshStandardMaterial( { color: 0x1E1E1E, roughness: 0.75, metalness: 0.1 } );
    const headlightMat = new THREE.MeshStandardMaterial( { color: 0xFFEEC0, emissive: 0xFFCC55, emissiveIntensity: 0.6 } );
    const taillightMat = new THREE.MeshStandardMaterial( { color: 0xCC1818, emissive: 0xFF2222, emissiveIntensity: 0.7 } );

    // ── Body layer 1: lower tub (wider, lower section — sills) ────────────
    _addCarMesh( parent, new THREE.BoxGeometry( 1.78, 0.34, 3.5 ), bodyMat, [ 0, - 0.18, 0 ] );
    // Dark side-skirt strips (push out 5mm from tub side at x=±0.89)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.12, 2.6 ), trimMat, [ - 0.905, - 0.32, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.12, 2.6 ), trimMat, [ 0.905, - 0.32, 0 ] );

    // ── Body layer 2: upper body / shoulder (narrower than tub) ───────────
    // Top of tub at y=-0.01; sit upper body from y=0 → y=0.34 (height 0.34)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.34, 3.45 ), bodyMat, [ 0, 0.17, 0 ] );
    // Belt-line trim — thin dark strip where upper meets lower (pushed out 5mm)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.025, 0.04, 3.3 ), trimMat, [ - 0.855, 0.005, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.025, 0.04, 3.3 ), trimMat, [ 0.855, 0.005, 0 ] );

    // ── Bonnet — short, slight forward pitch (tilted nose-down ~5°) ───────
    // Sits on top of upper body (y≈0.34), centred at z≈-1.25, length ~0.9
    _addCarMesh( parent, new THREE.BoxGeometry( 1.6, 0.06, 0.95 ), bodyMat, [ 0, 0.36, - 1.25 ], [ - 0.09, 0, 0 ] );
    // Hood lip at the very front (small raised ridge above grille)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.55, 0.05, 0.06 ), bodyMat, [ 0, 0.345, - 1.72 ] );

    // ── Cabin — 2 piece tapered greenhouse ────────────────────────────────
    // Front cabin (wider, slightly taller — A-pillar / windshield base zone)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.55, 0.36, 0.85 ), cabinMat, [ 0, 0.52, - 0.3 ] );
    // Rear cabin (narrower, slightly lower — C-pillar / hatch zone)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.42, 0.32, 1.0 ), cabinMat, [ 0, 0.50, 0.7 ] );
    // Yellow roof skin (narrower than shoulders, lifted 3mm above cabin)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.42, 0.05, 1.7 ), bodyMat, [ 0, 0.715, 0.18 ] );

    // ── Windshield — sloped forward (~18° from vertical, leans back) ──────
    // Positioned between bonnet rear and front cabin top
    _addCarMesh( parent, new THREE.BoxGeometry( 1.5, 0.5, 0.04 ), cabinMat, [ 0, 0.5, - 0.76 ], [ - 0.32, 0, 0 ] );

    // ── Rear hatch glass — sloped backward (~22°, descending into trunk) ──
    _addCarMesh( parent, new THREE.BoxGeometry( 1.4, 0.55, 0.04 ), cabinMat, [ 0, 0.43, 1.27 ], [ 0.38, 0, 0 ] );
    // Rear trunk-lip spoiler (small ledge above tail)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.45, 0.04, 0.18 ), bodyMat, [ 0, 0.36, 1.55 ] );

    // ── Front bumper + grille recess ──────────────────────────────────────
    _addCarMesh( parent, new THREE.BoxGeometry( 1.78, 0.22, 0.14 ), bumperMat, [ 0, - 0.26, - 1.78 ] );
    // Grille (thin dark recess between headlights, push out 5mm)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.9, 0.09, 0.04 ), trimMat, [ 0, - 0.06, - 1.755 ] );

    // ── Rear bumper ───────────────────────────────────────────────────────
    _addCarMesh( parent, new THREE.BoxGeometry( 1.78, 0.22, 0.14 ), bumperMat, [ 0, - 0.26, 1.78 ] );

    // ── Corner chamfers — small angled boxes to break 90° corners ─────────
    // Front L/R (rotated ~25° around Y to fake a chamfer at the nose)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.32, 0.32 ), bodyMat, [ - 0.78, - 0.15, - 1.66 ], [ 0, - 0.45, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.32, 0.32 ), bodyMat, [ 0.78, - 0.15, - 1.66 ], [ 0, 0.45, 0 ] );
    // Rear L/R
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.32, 0.32 ), bodyMat, [ - 0.78, - 0.15, 1.66 ], [ 0, 0.45, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.32, 0.32 ), bodyMat, [ 0.78, - 0.15, 1.66 ], [ 0, - 0.45, 0 ] );

    // ── Headlights — small cluster pair on bumper top ─────────────────────
    _addCarMesh( parent, new THREE.BoxGeometry( 0.34, 0.1, 0.06 ), headlightMat, [ - 0.55, - 0.07, - 1.755 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.34, 0.1, 0.06 ), headlightMat, [ 0.55, - 0.07, - 1.755 ] );

    // ── Taillights — small red pair (via _addTaillight) ───────────────────
    _addTaillight( parent, new THREE.BoxGeometry( 0.32, 0.12, 0.06 ), taillightMat, [ - 0.6, - 0.05, 1.755 ], true );
    _addTaillight( parent, new THREE.BoxGeometry( 0.32, 0.12, 0.06 ), taillightMat, [ 0.6, - 0.05, 1.755 ], true );

    // ── Side mirrors — stalk + housing each side ──────────────────────────
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.08 ), trimMat, [ - 0.86, 0.36, - 0.62 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.14, 0.09, 0.08 ), bodyMat, [ - 0.95, 0.38, - 0.62 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.08 ), trimMat, [ 0.86, 0.36, - 0.62 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.14, 0.09, 0.08 ), bodyMat, [ 0.95, 0.38, - 0.62 ] );

    // ── Thin roof antenna ─────────────────────────────────────────────────
    _addCarMesh( parent, new THREE.BoxGeometry( 0.03, 0.22, 0.03 ), trimMat, [ - 0.5, 0.85, 0.85 ] );

}

function _buildMuscleV8( parent ) {

    // Late-60s American fastback — Charger / Mustang vibe.
    // Long bonnet, fastback roofline, twin stripes, scoop, dual exhaust, wide haunches.
    const bodyMat = new THREE.MeshStandardMaterial( { color: 0xB42020, roughness: 0.45, metalness: 0.25 } );
    const cabinMat = new THREE.MeshStandardMaterial( { color: 0x000000, roughness: 0.2, metalness: 0.6 } );
    const stripeMat = new THREE.MeshStandardMaterial( { color: 0x0A0A0A, roughness: 0.5, metalness: 0.3 } );
    const bumperMat = new THREE.MeshStandardMaterial( { color: 0xB0B4B8, roughness: 0.3, metalness: 0.9 } );
    const grilleMat = new THREE.MeshStandardMaterial( { color: 0x111111, roughness: 0.6, metalness: 0.4 } );
    const exhaustMat = new THREE.MeshStandardMaterial( { color: 0x4A4A4A, roughness: 0.45, metalness: 0.85 } );
    const chromeMat = new THREE.MeshStandardMaterial( { color: 0xCCD0D4, roughness: 0.2, metalness: 0.95 } );
    const headlightMat = new THREE.MeshStandardMaterial( { color: 0xFFEEB0, emissive: 0xFFCC55, emissiveIntensity: 0.7 } );
    const taillightMat = new THREE.MeshStandardMaterial( { color: 0xCC1818, emissive: 0xFF2222, emissiveIntensity: 0.8 } );

    // Main lower body
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.55, 3.7 ), bodyMat, [ 0, - 0.15, 0 ] );
    // Wide rear haunches (extend body sides at rear)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.45, 1.4 ), bodyMat, [ - 0.96, - 0.18, 0.9 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.45, 1.4 ), bodyMat, [ 0.96, - 0.18, 0.9 ] );
    // Upper body / shoulder
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.25, 3.7 ), bodyMat, [ 0, 0.22, 0 ] );

    // Long bonnet — extends forward
    _addCarMesh( parent, new THREE.BoxGeometry( 1.65, 0.1, 1.45 ), bodyMat, [ 0, 0.4, - 1.05 ] );
    // Bonnet scoop (raised)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.55, 0.12, 0.6 ), bodyMat, [ 0, 0.5, - 1.0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.45, 0.04, 0.08 ), cabinMat, [ 0, 0.55, - 1.22 ] );

    // Fastback roof — tilted sloping down to rear
    _addCarMesh( parent, new THREE.BoxGeometry( 1.5, 0.4, 2.0 ), cabinMat, [ 0, 0.52, 0.4 ], [ - 0.14, 0, 0 ] );
    // Steel roof skin
    _addCarMesh( parent, new THREE.BoxGeometry( 1.52, 0.08, 1.6 ), bodyMat, [ 0, 0.78, 0.0 ], [ - 0.14, 0, 0 ] );

    // Twin lengthwise racing stripes on bonnet + roof + boot (lifted 3mm above bonnet top)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.22, 0.02, 3.7 ), stripeMat, [ - 0.3, 0.463, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.22, 0.02, 3.7 ), stripeMat, [ 0.3, 0.463, 0 ] );
    // Stripes continuing on the angled roof
    _addCarMesh( parent, new THREE.BoxGeometry( 0.22, 0.02, 1.6 ), stripeMat, [ - 0.3, 0.82, 0.0 ], [ - 0.14, 0, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.22, 0.02, 1.6 ), stripeMat, [ 0.3, 0.82, 0.0 ], [ - 0.14, 0, 0 ] );

    // Front chrome bumper
    _addCarMesh( parent, new THREE.BoxGeometry( 1.95, 0.18, 0.2 ), bumperMat, [ 0, - 0.05, - 1.85 ] );
    // Rear chrome bumper
    _addCarMesh( parent, new THREE.BoxGeometry( 1.95, 0.18, 0.2 ), bumperMat, [ 0, - 0.05, 1.85 ] );

    // Grille (wide, dark, recessed)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.4, 0.22, 0.08 ), grilleMat, [ 0, 0.15, - 1.84 ] );
    // Chrome grille slats
    for ( const sy of [ 0.2, 0.13, 0.08 ] ) _addCarMesh( parent, new THREE.BoxGeometry( 1.35, 0.02, 0.09 ), chromeMat, [ 0, sy, - 1.85 ] );
    // Center grille emblem (pushed out 5mm so its front face clears the slats / grille box)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.16, 0.16, 0.04 ), chromeMat, [ 0, 0.14, - 1.875 ] );

    // Quad low-mounted headlights (2 per side)
    for ( const x of [ - 0.7, - 0.45, 0.45, 0.7 ] ) {

        _addCarMesh( parent, new THREE.BoxGeometry( 0.22, 0.18, 0.08 ), headlightMat, [ x, - 0.05, - 1.86 ] );

    }

    // Rear horizontal taillight bar with red segments
    for ( const x of [ - 0.7, - 0.35, 0, 0.35, 0.7 ] ) {

        _addTaillight( parent, new THREE.BoxGeometry( 0.28, 0.16, 0.08 ), taillightMat, [ x, 0.13, 1.86 ], true );

    }

    // Dual exhaust tips
    _addCarMesh( parent, new THREE.BoxGeometry( 0.2, 0.18, 0.18 ), exhaustMat, [ - 0.55, - 0.3, 1.94 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.2, 0.18, 0.18 ), exhaustMat, [ 0.55, - 0.3, 1.94 ] );

    // Side mirrors on stalks (mirror housings nudged outboard 3mm to avoid coplanar face with stalk)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.1 ), stripeMat, [ - 0.88, 0.32, - 0.5 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.16, 0.1, 0.08 ), bodyMat, [ - 0.983, 0.34, - 0.5 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.1 ), stripeMat, [ 0.88, 0.32, - 0.5 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.16, 0.1, 0.08 ), bodyMat, [ 0.983, 0.34, - 0.5 ] );

    // Door handles
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.2 ), chromeMat, [ - 0.94, 0.12, - 0.05 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.2 ), chromeMat, [ 0.94, 0.12, - 0.05 ] );

    // Fuel cap badge on rear quarter
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.12, 0.12 ), chromeMat, [ - 0.97, 0.15, 1.4 ] );

}

function _buildSportFlatSix( parent ) {

    // Rear-engined coupe — 911 silhouette.
    // Short overhangs, low cabin, sloped fastback rear, ducktail spoiler, round-cluster headlight bumps, side intakes.
    const bodyMat = new THREE.MeshStandardMaterial( { color: 0xC8CDD2, roughness: 0.4, metalness: 0.55 } );
    const cabinMat = new THREE.MeshStandardMaterial( { color: 0x000000, roughness: 0.2, metalness: 0.6 } );
    const trimMat = new THREE.MeshStandardMaterial( { color: 0x1A1A1A, roughness: 0.7, metalness: 0.2 } );
    const chromeMat = new THREE.MeshStandardMaterial( { color: 0xC8CCD0, roughness: 0.25, metalness: 0.9 } );
    const headlightMat = new THREE.MeshStandardMaterial( { color: 0xFFEEB0, emissive: 0xFFCC55, emissiveIntensity: 0.7 } );
    const taillightMat = new THREE.MeshStandardMaterial( { color: 0xCC1818, emissive: 0xFF2222, emissiveIntensity: 0.8 } );
    const indicatorMat = new THREE.MeshStandardMaterial( { color: 0xFFAA22, emissive: 0xFF9900, emissiveIntensity: 0.5 } );

    // Lower body — low, slim
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.4, 3.6 ), bodyMat, [ 0, - 0.3, 0 ] );
    // Belt line / shoulder
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.18, 3.5 ), bodyMat, [ 0, - 0.0, 0 ] );

    // Front fender humps (round-headlight bumps signature)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.42, 0.32, 1.1 ), bodyMat, [ - 0.7, 0.08, - 1.1 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.42, 0.32, 1.1 ), bodyMat, [ 0.7, 0.08, - 1.1 ] );

    // Front bonnet (lower than fenders, classic 911 dip) — lifted 3mm to clear belt-line top
    _addCarMesh( parent, new THREE.BoxGeometry( 1.0, 0.08, 1.1 ), bodyMat, [ 0, 0.133, - 1.1 ] );

    // Cabin glass
    _addCarMesh( parent, new THREE.BoxGeometry( 1.5, 0.4, 1.5 ), cabinMat, [ 0, 0.3, - 0.1 ] );
    // Steel roof
    _addCarMesh( parent, new THREE.BoxGeometry( 1.45, 0.06, 1.3 ), bodyMat, [ 0, 0.52, - 0.15 ] );

    // Sloped fastback rear glass / body — angled down
    _addCarMesh( parent, new THREE.BoxGeometry( 1.5, 0.06, 1.4 ), bodyMat, [ 0, 0.35, 0.9 ], [ - 0.35, 0, 0 ] );
    // Rear engine cover (slatted look) — lifted 3mm to clear belt-line top
    _addCarMesh( parent, new THREE.BoxGeometry( 1.4, 0.08, 1.2 ), trimMat, [ 0, 0.133, 1.2 ] );
    for ( const sx of [ - 0.4, - 0.2, 0, 0.2, 0.4 ] ) _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 1.1 ), chromeMat, [ sx, 0.18, 1.2 ] );

    // Rear haunches (wide hips)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.15, 0.35, 1.3 ), bodyMat, [ - 0.96, - 0.05, 1.0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.15, 0.35, 1.3 ), bodyMat, [ 0.96, - 0.05, 1.0 ] );

    // Ducktail spoiler (lip + small wing on edge)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.5, 0.05, 0.3 ), bodyMat, [ 0, 0.22, 1.78 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 1.55, 0.04, 0.12 ), trimMat, [ 0, 0.26, 1.85 ] );

    // Side air intakes ahead of rear wheels
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.16, 0.5 ), trimMat, [ - 0.96, - 0.05, 0.4 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.16, 0.5 ), trimMat, [ 0.96, - 0.05, 0.4 ] );

    // Front bumper / chin spoiler
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.16, 0.18 ), trimMat, [ 0, - 0.42, - 1.82 ] );
    // Front splitter lip
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.04, 0.3 ), trimMat, [ 0, - 0.5, - 1.78 ] );

    // Headlights (rounded but boxed — two stacked boxes per side for the "bump" look)
    // Inner lens pushed forward 3mm so its back face doesn't coplanar-share with outer lens front face
    for ( const x of [ - 0.7, 0.7 ] ) {

        _addCarMesh( parent, new THREE.BoxGeometry( 0.32, 0.22, 0.1 ), headlightMat, [ x, 0.13, - 1.62 ] );
        _addCarMesh( parent, new THREE.BoxGeometry( 0.28, 0.18, 0.06 ), headlightMat, [ x, 0.13, - 1.703 ] );
        // Front amber indicator
        _addCarMesh( parent, new THREE.BoxGeometry( 0.16, 0.08, 0.06 ), indicatorMat, [ x * 0.5, - 0.18, - 1.86 ] );

    }
    // Full-width rear taillight strip (broken into segments tagged as taillights)
    for ( const x of [ - 0.7, - 0.35, 0, 0.35, 0.7 ] ) {

        _addTaillight( parent, new THREE.BoxGeometry( 0.3, 0.1, 0.08 ), taillightMat, [ x, 0.05, 1.86 ], true );

    }

    // Centre exhaust tip (twin pipes close together)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.14, 0.16 ), chromeMat, [ - 0.12, - 0.42, 1.92 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.14, 0.16 ), chromeMat, [ 0.12, - 0.42, 1.92 ] );

    // Side mirrors
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.1 ), trimMat, [ - 0.86, 0.16, - 0.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.16, 0.1, 0.08 ), bodyMat, [ - 0.96, 0.18, - 0.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.1 ), trimMat, [ 0.86, 0.16, - 0.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.16, 0.1, 0.08 ), bodyMat, [ 0.96, 0.18, - 0.7 ] );

    // Door handles
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.16 ), chromeMat, [ - 0.94, 0.0, - 0.2 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.16 ), chromeMat, [ 0.94, 0.0, - 0.2 ] );

}

function _buildRallyTurbo( parent ) {

    // 90s WRC 4-door rally hatch — Subaru Impreza WRC.
    // Blue body, gold accents, flared arches, big wing, 4 roof spotlights, bonnet vent, mud flaps, side livery.
    const bodyMat = new THREE.MeshStandardMaterial( { color: 0x1F4DFF, roughness: 0.5, metalness: 0.2 } );
    const cabinMat = new THREE.MeshStandardMaterial( { color: 0x000000, roughness: 0.2, metalness: 0.6 } );
    const goldMat = new THREE.MeshStandardMaterial( { color: 0xD4A52A, roughness: 0.4, metalness: 0.7 } );
    const liveryMat = new THREE.MeshStandardMaterial( { color: 0xF8F8F8, roughness: 0.6, metalness: 0.1 } );
    const trimMat = new THREE.MeshStandardMaterial( { color: 0x101010, roughness: 0.7, metalness: 0.15 } );
    const grilleMat = new THREE.MeshStandardMaterial( { color: 0x080808, roughness: 0.6, metalness: 0.3 } );
    const chromeMat = new THREE.MeshStandardMaterial( { color: 0xC8CCD0, roughness: 0.3, metalness: 0.9 } );
    const headlightMat = new THREE.MeshStandardMaterial( { color: 0xFFEEB0, emissive: 0xFFCC55, emissiveIntensity: 0.7 } );
    const taillightMat = new THREE.MeshStandardMaterial( { color: 0xCC1818, emissive: 0xFF2222, emissiveIntensity: 0.8 } );
    const roofLightMat = new THREE.MeshStandardMaterial( { color: 0xFFF4B0, emissive: 0xFFEE55, emissiveIntensity: 1.0 } );

    // Main body
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.7, 3.6 ), bodyMat, [ 0, - 0.1, 0 ] );

    // Flared arches (front and rear, each side)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.5, 0.95 ), bodyMat, [ - 0.96, - 0.18, - 1.05 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.5, 0.95 ), bodyMat, [ 0.96, - 0.18, - 1.05 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.5, 0.95 ), bodyMat, [ - 0.96, - 0.18, 1.05 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.5, 0.95 ), bodyMat, [ 0.96, - 0.18, 1.05 ] );

    // Side livery bars (white + gold horizontal stripes along doors)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.08, 1.9 ), liveryMat, [ - 0.96, 0.1, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.08, 1.9 ), liveryMat, [ 0.96, 0.1, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 1.9 ), goldMat, [ - 0.96, 0.02, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 1.9 ), goldMat, [ 0.96, 0.02, 0 ] );

    // Cabin (greenhouse) — taller, 4-door so wider B-pillar area (lifted 3mm above body top)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.6, 0.5, 1.95 ), cabinMat, [ 0, 0.503, 0.05 ] );
    // Steel roof
    _addCarMesh( parent, new THREE.BoxGeometry( 1.62, 0.08, 2.0 ), bodyMat, [ 0, 0.78, 0.05 ] );
    // A/B/C pillars (lifted 3mm above body top, matches cabin lift)
    for ( const x of [ - 0.78, 0.78 ] ) {

        _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.5, 0.1 ), bodyMat, [ x, 0.503, - 0.88 ] );
        _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.5, 0.1 ), bodyMat, [ x, 0.503, 0.1 ] );
        _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.5, 0.1 ), bodyMat, [ x, 0.503, 0.98 ] );

    }

    // Bonnet (lifted 3mm above body top)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.06, 1.1 ), bodyMat, [ 0, 0.283, - 1.2 ] );
    // Bonnet vent (raised scoop)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.6, 0.08, 0.4 ), bodyMat, [ 0, 0.34, - 1.05 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.5, 0.04, 0.12 ), trimMat, [ 0, 0.4, - 1.18 ] );

    // Rear hatch (lifted 3mm above body top)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.06, 1.1 ), bodyMat, [ 0, 0.283, 1.2 ] );

    // Big rear wing — wide blade on 2 vertical stanchions
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.3, 0.06 ), trimMat, [ - 0.55, 0.45, 1.78 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.3, 0.06 ), trimMat, [ 0.55, 0.45, 1.78 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.08, 0.4 ), bodyMat, [ 0, 0.62, 1.78 ] );
    // Wing endplates
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.18, 0.45 ), trimMat, [ - 0.85, 0.62, 1.78 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.18, 0.45 ), trimMat, [ 0.85, 0.62, 1.78 ] );
    // Wing gold accent stripe (lifted 3mm above main wing blade top)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.02, 0.08 ), goldMat, [ 0, 0.673, 1.6 ] );

    // 4 roof-mounted spot light pod (mounting bar + 4 lights) — lifted 3mm above roof top
    _addCarMesh( parent, new THREE.BoxGeometry( 1.4, 0.04, 0.08 ), trimMat, [ 0, 0.843, - 0.6 ] );
    const roofLightGeom = new THREE.BoxGeometry( 0.24, 0.2, 0.2 );
    for ( const x of [ - 0.6, - 0.2, 0.2, 0.6 ] ) _addCarMesh( parent, roofLightGeom, roofLightMat, [ x, 0.923, - 0.62 ] );
    // Light pod chrome rims
    for ( const x of [ - 0.6, - 0.2, 0.2, 0.6 ] ) _addCarMesh( parent, new THREE.BoxGeometry( 0.26, 0.22, 0.04 ), chromeMat, [ x, 0.92, - 0.72 ] );

    // Mud flaps behind front + rear wheels
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.3, 0.18 ), trimMat, [ - 0.96, - 0.42, - 0.68 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.3, 0.18 ), trimMat, [ 0.96, - 0.42, - 0.68 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.3, 0.18 ), trimMat, [ - 0.96, - 0.42, 1.42 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.3, 0.18 ), trimMat, [ 0.96, - 0.42, 1.42 ] );

    // Front bumper / splitter
    _addCarMesh( parent, new THREE.BoxGeometry( 1.9, 0.22, 0.2 ), trimMat, [ 0, - 0.32, - 1.82 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.04, 0.35 ), trimMat, [ 0, - 0.42, - 1.75 ] );
    // Grille
    _addCarMesh( parent, new THREE.BoxGeometry( 1.1, 0.18, 0.06 ), grilleMat, [ 0, - 0.1, - 1.84 ] );
    // Centre rally number disc area (large white square on door)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.4, 0.5 ), liveryMat, [ - 0.97, 0.2, - 0.1 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.4, 0.5 ), liveryMat, [ 0.97, 0.2, - 0.1 ] );

    // Headlights (rectangular pair each side)
    for ( const x of [ - 0.7, 0.7 ] ) {

        _addCarMesh( parent, new THREE.BoxGeometry( 0.36, 0.2, 0.08 ), headlightMat, [ x, 0.05, - 1.86 ] );

    }
    // Taillight cluster across boot
    for ( const x of [ - 0.7, - 0.35, 0.35, 0.7 ] ) {

        _addTaillight( parent, new THREE.BoxGeometry( 0.3, 0.18, 0.08 ), taillightMat, [ x, 0.05, 1.86 ], true );

    }

    // Exhaust tip (single big rally cannon)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.22, 0.18, 0.2 ), chromeMat, [ 0.45, - 0.32, 1.94 ] );

    // Side mirrors
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.1 ), trimMat, [ - 0.86, 0.32, - 0.65 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.12, 0.08 ), bodyMat, [ - 0.97, 0.34, - 0.65 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.1 ), trimMat, [ 0.86, 0.32, - 0.65 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.12, 0.08 ), bodyMat, [ 0.97, 0.34, - 0.65 ] );

    // Door handles
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.16 ), chromeMat, [ - 0.99, 0.16, - 0.4 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.16 ), chromeMat, [ 0.99, 0.16, - 0.4 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.16 ), chromeMat, [ - 0.99, 0.16, 0.5 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.16 ), chromeMat, [ 0.99, 0.16, 0.5 ] );

    // Roof antenna (rally radio)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.32, 0.04 ), trimMat, [ - 0.4, 0.98, 0.85 ] );

}

function _buildSupercarV12( parent ) {

    // Wedge-profile mid-engined supercar — Aventador / Diablo.
    // Low, wide, sharp angles, scissor cut lines visible, side intakes, diffuser strakes, central exhaust, splitter.
    const bodyMat = new THREE.MeshStandardMaterial( { color: 0xFF6F1A, roughness: 0.4, metalness: 0.45 } );
    const cabinMat = new THREE.MeshStandardMaterial( { color: 0x000000, roughness: 0.15, metalness: 0.7 } );
    const darkMat = new THREE.MeshStandardMaterial( { color: 0x080808, roughness: 0.6, metalness: 0.3 } );
    const carbonMat = new THREE.MeshStandardMaterial( { color: 0x141414, roughness: 0.55, metalness: 0.4 } );
    const exhaustMat = new THREE.MeshStandardMaterial( { color: 0x4A4A4A, roughness: 0.4, metalness: 0.9 } );
    const chromeMat = new THREE.MeshStandardMaterial( { color: 0xC8CCD0, roughness: 0.25, metalness: 0.95 } );
    const headlightMat = new THREE.MeshStandardMaterial( { color: 0xFFEEB0, emissive: 0xFFCC55, emissiveIntensity: 0.8 } );
    const drlMat = new THREE.MeshStandardMaterial( { color: 0xC8E8FF, emissive: 0x66AAFF, emissiveIntensity: 0.8 } );
    const taillightMat = new THREE.MeshStandardMaterial( { color: 0xCC1818, emissive: 0xFF2222, emissiveIntensity: 0.9 } );

    // Lower body — flat, low wedge
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.3, 3.7 ), bodyMat, [ 0, - 0.3, 0 ] );
    // Front nose wedge (lower, sloped via thin slab)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.1, 0.9 ), bodyMat, [ 0, - 0.22, - 1.3 ] );
    // Upper wedge slab lifted 3mm above lower-body top
    _addCarMesh( parent, new THREE.BoxGeometry( 1.6, 0.06, 0.6 ), bodyMat, [ 0, - 0.117, - 1.0 ] );

    // Side haunches (wide rear hips)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.2, 0.4, 1.6 ), bodyMat, [ - 0.95, - 0.2, 0.8 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.2, 0.4, 1.6 ), bodyMat, [ 0.95, - 0.2, 0.8 ] );

    // Cabin (very low, sloped forward like Aventador)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.5, 0.45, 1.8 ), cabinMat, [ 0, 0.05, - 0.2 ], [ - 0.18, 0, 0 ] );
    // Roof spine
    _addCarMesh( parent, new THREE.BoxGeometry( 0.5, 0.06, 1.6 ), bodyMat, [ 0, 0.32, - 0.3 ], [ - 0.18, 0, 0 ] );

    // Scissor door cut lines (engraved into side as thin dark strips)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.4, 0.04 ), darkMat, [ - 0.92, - 0.1, - 0.5 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.4, 0.04 ), darkMat, [ 0.92, - 0.1, - 0.5 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 1.1 ), darkMat, [ - 0.92, - 0.1, 0.0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 1.1 ), darkMat, [ 0.92, - 0.1, 0.0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.4, 0.04 ), darkMat, [ - 0.92, - 0.1, 0.5 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.4, 0.04 ), darkMat, [ 0.92, - 0.1, 0.5 ] );

    // Side intakes feeding rear engine — large slatted scoops
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.28, 0.8 ), darkMat, [ - 0.96, 0.05, 0.6 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.28, 0.8 ), darkMat, [ 0.96, 0.05, 0.6 ] );
    for ( const sz of [ 0.4, 0.6, 0.8 ] ) {

        _addCarMesh( parent, new THREE.BoxGeometry( 0.05, 0.04, 0.05 ), chromeMat, [ - 0.97, 0.1, sz ] );
        _addCarMesh( parent, new THREE.BoxGeometry( 0.05, 0.04, 0.05 ), chromeMat, [ 0.97, 0.1, sz ] );

    }

    // Rear engine deck (with glass louvres)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.4, 0.08, 1.0 ), darkMat, [ 0, 0.05, 1.15 ] );
    for ( const sx of [ - 0.5, - 0.25, 0, 0.25, 0.5 ] ) _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.06, 0.9 ), chromeMat, [ sx, 0.1, 1.15 ] );

    // Rear deck spoiler lip (small active wing look) — blade lifted 3mm above strut tops
    _addCarMesh( parent, new THREE.BoxGeometry( 1.6, 0.06, 0.2 ), bodyMat, [ 0, 0.183, 1.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.18, 0.18 ), darkMat, [ - 0.55, 0.06, 1.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.18, 0.18 ), darkMat, [ 0.55, 0.06, 1.7 ] );

    // Rear diffuser strakes (4 vertical fins under rear)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.95, 0.1, 0.35 ), carbonMat, [ 0, - 0.48, 1.75 ] );
    for ( const sx of [ - 0.6, - 0.2, 0.2, 0.6 ] ) _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.18, 0.35 ), carbonMat, [ sx, - 0.4, 1.78 ] );

    // Front splitter — dropped 3mm so its top face clears the body underside
    _addCarMesh( parent, new THREE.BoxGeometry( 1.9, 0.06, 0.4 ), carbonMat, [ 0, - 0.423, - 1.75 ] );
    // Front canards (small wings on outer corners)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.22, 0.04, 0.16 ), carbonMat, [ - 0.84, - 0.32, - 1.75 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.22, 0.04, 0.16 ), carbonMat, [ 0.84, - 0.32, - 1.75 ] );

    // Y-shape angular headlight + DRL signature (each side)
    // DRL strips pushed forward 5mm so their front face no longer coplanar-fights with the main headlight front face
    for ( const x of [ - 0.6, 0.6 ] ) {

        _addCarMesh( parent, new THREE.BoxGeometry( 0.4, 0.1, 0.08 ), headlightMat, [ x, - 0.05, - 1.86 ] );
        _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.04, 0.06 ), drlMat, [ x + ( x > 0 ? - 0.08 : 0.08 ), - 0.13, - 1.875 ] );
        _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.12, 0.06 ), drlMat, [ x + ( x > 0 ? - 0.15 : 0.15 ), - 0.0, - 1.875 ] );

    }

    // Rear taillight strip — Y-shaped, segmented
    for ( const x of [ - 0.65, - 0.4, 0.4, 0.65 ] ) {

        _addTaillight( parent, new THREE.BoxGeometry( 0.22, 0.1, 0.08 ), taillightMat, [ x, 0.0, 1.86 ], true );

    }

    // Large central exhaust tip (quad)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.6, 0.16, 0.16 ), exhaustMat, [ 0, - 0.22, 1.92 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.12, 0.04 ), darkMat, [ - 0.18, - 0.22, 1.96 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.12, 0.04 ), darkMat, [ 0.18, - 0.22, 1.96 ] );

    // Side mirrors (small angular)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.08 ), darkMat, [ - 0.88, 0.12, - 0.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.16, 0.08, 0.08 ), bodyMat, [ - 0.97, 0.14, - 0.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.08 ), darkMat, [ 0.88, 0.12, - 0.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.16, 0.08, 0.08 ), bodyMat, [ 0.97, 0.14, - 0.7 ] );

}

function _buildF1( parent ) {

    // Modern F1 — cigar monocoque, sidepods, front wing assembly, rear wing, halo, airbox, barge boards, diffuser.
    const bodyMat = new THREE.MeshStandardMaterial( { color: 0xD11A1A, roughness: 0.4, metalness: 0.4 } );
    const darkMat = new THREE.MeshStandardMaterial( { color: 0x080808, roughness: 0.5, metalness: 0.4 } );
    const cockpitMat = new THREE.MeshStandardMaterial( { color: 0x000000, roughness: 0.6, metalness: 0.2 } );
    const carbonMat = new THREE.MeshStandardMaterial( { color: 0x101010, roughness: 0.55, metalness: 0.5 } );
    const accentMat = new THREE.MeshStandardMaterial( { color: 0xF8F8F8, roughness: 0.6, metalness: 0.1 } );
    const exhaustMat = new THREE.MeshStandardMaterial( { color: 0x6A6A6A, roughness: 0.35, metalness: 0.95 } );
    const taillightMat = new THREE.MeshStandardMaterial( { color: 0xCC1818, emissive: 0xFF2222, emissiveIntensity: 1.0 } );
    const camMat = new THREE.MeshStandardMaterial( { color: 0x202020, roughness: 0.6, metalness: 0.3 } );

    // Central monocoque tub (long cigar)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.55, 0.28, 2.4 ), bodyMat, [ 0, - 0.18, 0 ] );
    // Nose cone — long thin pointed nose forward
    _addCarMesh( parent, new THREE.BoxGeometry( 0.32, 0.18, 1.1 ), bodyMat, [ 0, - 0.22, - 1.6 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.2, 0.12, 0.3 ), bodyMat, [ 0, - 0.22, - 2.1 ] );

    // Front wing — main plane + flap on pylons (pylons lifted 3mm so their bottom face clears plane top)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.08, 0.3 ), carbonMat, [ - 0.1, - 0.337, - 2.15 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.08, 0.3 ), carbonMat, [ 0.1, - 0.337, - 2.15 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 1.95, 0.04, 0.32 ), bodyMat, [ 0, - 0.4, - 2.05 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 1.95, 0.03, 0.18 ), bodyMat, [ 0, - 0.36, - 1.92 ] );
    // Front wing endplates (lifted 3mm so bottom face clears main-plane bottom)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.2, 0.45 ), carbonMat, [ - 0.97, - 0.317, - 2.0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.2, 0.45 ), carbonMat, [ 0.97, - 0.317, - 2.0 ] );
    // Front wing accent stripe
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.02, 0.06 ), accentMat, [ 0, - 0.38, - 2.0 ] );

    // Sidepods (left/right, around mid-rear of car)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.45, 0.32, 1.4 ), bodyMat, [ - 0.55, - 0.18, 0.4 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.45, 0.32, 1.4 ), bodyMat, [ 0.55, - 0.18, 0.4 ] );
    // Sidepod intakes (dark mouth at front)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.32, 0.18, 0.12 ), darkMat, [ - 0.55, - 0.14, - 0.25 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.32, 0.18, 0.12 ), darkMat, [ 0.55, - 0.14, - 0.25 ] );

    // Barge boards (vertical fins ahead of sidepods)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.22, 0.5 ), carbonMat, [ - 0.45, - 0.18, - 0.55 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.22, 0.5 ), carbonMat, [ 0.45, - 0.18, - 0.55 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.18, 0.3 ), carbonMat, [ - 0.6, - 0.2, - 0.4 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.18, 0.3 ), carbonMat, [ 0.6, - 0.2, - 0.4 ] );

    // Floor / bargeboard floor extensions
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.03, 1.6 ), carbonMat, [ 0, - 0.36, 0.3 ] );

    // Cockpit opening
    _addCarMesh( parent, new THREE.BoxGeometry( 0.5, 0.32, 0.5 ), cockpitMat, [ 0, - 0.04, - 0.05 ] );
    // Driver helmet (small box poking up)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.3, 0.22, 0.3 ), darkMat, [ 0, 0.16, - 0.1 ] );
    // Halo (front pillar + two side bows — simplified as 3 boxes forming a halo over cockpit)
    // Rear hoop slightly shrunk in width + depth so its faces don't coplanar-share with the side bows
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.4, 0.06 ), carbonMat, [ 0, 0.18, - 0.4 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.06, 0.7 ), carbonMat, [ - 0.27, 0.32, - 0.05 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.06, 0.7 ), carbonMat, [ 0.27, 0.32, - 0.05 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.594, 0.06, 0.054 ), carbonMat, [ 0, 0.32, 0.273 ] );

    // Airbox above driver feeding rear engine (pushed back 3mm so its front face clears cockpit back face)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.36, 0.32, 0.5 ), bodyMat, [ 0, 0.2, 0.453 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.28, 0.22, 0.08 ), darkMat, [ 0, 0.24, 0.22 ] );
    // On-board camera pod (T-cam)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.08, 0.16 ), camMat, [ 0, 0.42, 0.45 ] );

    // Engine cover / shark fin tapering to rear wing
    _addCarMesh( parent, new THREE.BoxGeometry( 0.36, 0.18, 1.0 ), bodyMat, [ 0, 0.08, 1.0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.32, 0.9 ), bodyMat, [ 0, 0.32, 1.0 ] );

    // Rear wing — main plane + flap, on two side struts with endplates
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.45, 0.1 ), carbonMat, [ - 0.4, 0.3, 1.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.45, 0.1 ), carbonMat, [ 0.4, 0.3, 1.7 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 1.95, 0.06, 0.35 ), bodyMat, [ 0, 0.52, 1.78 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.04, 0.18 ), bodyMat, [ 0, 0.6, 1.7 ] );
    // Rear wing endplates
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.42, 0.45 ), carbonMat, [ - 0.97, 0.42, 1.75 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.42, 0.45 ), carbonMat, [ 0.97, 0.42, 1.75 ] );
    // Rear wing accent
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.02, 0.05 ), accentMat, [ 0, 0.55, 1.62 ] );

    // Rear crash structure / diffuser strakes
    _addCarMesh( parent, new THREE.BoxGeometry( 1.4, 0.12, 0.4 ), carbonMat, [ 0, - 0.32, 1.75 ] );
    for ( const sx of [ - 0.5, - 0.25, 0, 0.25, 0.5 ] ) _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.22, 0.35 ), carbonMat, [ sx, - 0.22, 1.78 ] );

    // Single rear exhaust pipe poking out high above diffuser
    _addCarMesh( parent, new THREE.BoxGeometry( 0.14, 0.14, 0.2 ), exhaustMat, [ 0, 0.04, 1.74 ] );

    // Rear rain light (FIA red — single tagged taillight)
    _addTaillight( parent, new THREE.BoxGeometry( 0.18, 0.18, 0.08 ), taillightMat, [ 0, 0.18, 1.86 ], true );
    // Endplate rear pos-lights (red flashing on each endplate)
    _addTaillight( parent, new THREE.BoxGeometry( 0.06, 0.1, 0.04 ), taillightMat, [ - 0.97, 0.25, 1.95 ], true );
    _addTaillight( parent, new THREE.BoxGeometry( 0.06, 0.1, 0.04 ), taillightMat, [ 0.97, 0.25, 1.95 ], true );

}

function _buildGodCar( parent ) {

    // Cyberpunk hypercar — very low, very wide, hard angles, neon underglow + seams, full LED strips, dorsal fin.
    const bodyMat = new THREE.MeshStandardMaterial( { color: 0xF0F0F8, roughness: 0.12, metalness: 0.9 } );
    const accentMat = new THREE.MeshStandardMaterial( { color: 0x222228, roughness: 0.2, metalness: 0.85 } );
    const cabinMat = new THREE.MeshStandardMaterial( { color: 0x000000, roughness: 0.1, metalness: 0.7 } );
    const darkMat = new THREE.MeshStandardMaterial( { color: 0x080808, roughness: 0.4, metalness: 0.5 } );
    const carbonMat = new THREE.MeshStandardMaterial( { color: 0x101012, roughness: 0.45, metalness: 0.55 } );
    const headlightMat = new THREE.MeshStandardMaterial( { color: 0xFFFFFF, emissive: 0xFFFFFF, emissiveIntensity: 1.5 } );
    const taillightMat = new THREE.MeshStandardMaterial( { color: 0xCC1818, emissive: 0xFF2222, emissiveIntensity: 1.2 } );
    const roofLightMat = new THREE.MeshStandardMaterial( { color: 0xFFF4B0, emissive: 0xFFEE55, emissiveIntensity: 1.2 } );
    const neonCyanMat = new THREE.MeshStandardMaterial( { color: 0x00FFFF, emissive: 0x00FFFF, emissiveIntensity: 2.0 } );
    const neonMagentaMat = new THREE.MeshStandardMaterial( { color: 0xFF00FF, emissive: 0xFF00FF, emissiveIntensity: 1.8 } );

    // Main body — very flat, very wide
    _addCarMesh( parent, new THREE.BoxGeometry( 1.95, 0.28, 3.6 ), bodyMat, [ 0, - 0.28, 0 ] );
    // Front wedge nose
    _addCarMesh( parent, new THREE.BoxGeometry( 1.85, 0.12, 1.0 ), bodyMat, [ 0, - 0.22, - 1.25 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.06, 0.5 ), bodyMat, [ 0, - 0.16, - 1.65 ] );

    // Dark accent shoulder strip running length of car
    _addCarMesh( parent, new THREE.BoxGeometry( 1.95, 0.06, 3.4 ), accentMat, [ 0, - 0.1, 0 ] );

    // Cabin (very low, sloped, dark glass)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.55, 0.4, 1.8 ), cabinMat, [ 0, 0.12, - 0.15 ], [ - 0.16, 0, 0 ] );
    // Roof spine / dorsal fin
    _addCarMesh( parent, new THREE.BoxGeometry( 0.4, 0.08, 1.8 ), bodyMat, [ 0, 0.35, - 0.2 ], [ - 0.16, 0, 0 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.25, 1.2 ), accentMat, [ 0, 0.4, 0.6 ] );

    // Wide rear haunches
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.4, 1.6 ), bodyMat, [ - 0.99, - 0.2, 0.9 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.18, 0.4, 1.6 ), bodyMat, [ 0.99, - 0.2, 0.9 ] );

    // Rear deck with glowing engine block visible (cyan core lifted 3mm above deck top)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.4, 0.06, 1.0 ), accentMat, [ 0, 0.08, 1.2 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.8, 0.04, 0.6 ), neonCyanMat, [ 0, 0.143, 1.2 ] );

    // Rear active wing
    _addCarMesh( parent, new THREE.BoxGeometry( 2.0, 0.06, 0.4 ), bodyMat, [ 0, 0.5, 1.78 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.32, 0.4 ), accentMat, [ - 0.55, 0.32, 1.78 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.08, 0.32, 0.4 ), accentMat, [ 0.55, 0.32, 1.78 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.4, 0.45 ), accentMat, [ - 0.99, 0.36, 1.78 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.4, 0.45 ), accentMat, [ 0.99, 0.36, 1.78 ] );

    // Front splitter + canards (splitter shrunk 8mm in width so its X side faces don't share plane with body sides)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.942, 0.06, 0.4 ), carbonMat, [ 0, - 0.38, - 1.75 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.24, 0.04, 0.18 ), carbonMat, [ - 0.86, - 0.28, - 1.75 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.24, 0.04, 0.18 ), carbonMat, [ 0.86, - 0.28, - 1.75 ] );

    // Rear diffuser strakes (diffuser pan dropped 3mm so its top face clears body underside; shrunk 8mm width so side faces don't share plane with body)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.942, 0.08, 0.35 ), carbonMat, [ 0, - 0.463, 1.75 ] );
    for ( const sx of [ - 0.7, - 0.35, 0, 0.35, 0.7 ] ) _addCarMesh( parent, new THREE.BoxGeometry( 0.06, 0.18, 0.35 ), carbonMat, [ sx, - 0.38, 1.78 ] );

    // ── FLUID RGB UNDERGLOW + ROAD LIGHT ───────────────────────────────
    // Each neon mesh gets per-instance material (not shared) so the
    // per-frame hue cycler can drive each one independently. Tag with
    // userData.godNeon + hueOffset (radians) so seam strips lag the
    // primary glow for a flowing rainbow effect.
    const _mkNeon = ( hueOffset, intensity ) => {

        const m = new THREE.MeshStandardMaterial( { color: 0x00FFFF, emissive: 0x00FFFF, emissiveIntensity: intensity } );
        m.userData.godNeon = true;
        m.userData.hueOffset = hueOffset;
        return m;

    };
    const underglow = new THREE.Mesh( new THREE.BoxGeometry( 1.7, 0.04, 3.4 ), _mkNeon( 0.0, 2.2 ) );
    underglow.position.set( 0, - 0.46, 0 );
    parent.add( underglow );
    const ugL = new THREE.Mesh( new THREE.BoxGeometry( 0.04, 0.04, 3.2 ), _mkNeon( 0.3, 2.0 ) );
    ugL.position.set( - 0.98, - 0.417, 0 );
    parent.add( ugL );
    const ugR = new THREE.Mesh( new THREE.BoxGeometry( 0.04, 0.04, 3.2 ), _mkNeon( - 0.3, 2.0 ) );
    ugR.position.set( 0.98, - 0.417, 0 );
    parent.add( ugR );

    for ( const [ x, z, h ] of [ [ - 0.95, - 1.05, 1.0 ], [ 0.95, - 1.05, - 1.0 ], [ - 0.99, 1.05, 1.5 ], [ 0.99, 1.05, - 1.5 ] ] ) {

        const arch = new THREE.Mesh( new THREE.BoxGeometry( 0.06, 0.06, 0.95 ), _mkNeon( h, 1.8 ) );
        arch.position.set( x, - 0.05, z );
        parent.add( arch );

    }

    const seamL = new THREE.Mesh( new THREE.BoxGeometry( 0.04, 0.03, 1.8 ), _mkNeon( 2.0, 1.8 ) );
    seamL.position.set( - 0.96, 0.05, 0 );
    parent.add( seamL );
    const seamR = new THREE.Mesh( new THREE.BoxGeometry( 0.04, 0.03, 1.8 ), _mkNeon( - 2.0, 1.8 ) );
    seamR.position.set( 0.96, 0.05, 0 );
    parent.add( seamR );

    // Five PointLights distributed along the chassis (z = -1.4 → +1.4) to
    // spread the glow evenly under the whole car instead of one bright
    // hotspot at the centre. Each is half-intensity, lower range, higher
    // decay so individual contributions soft-blend across the underside.
    // All tagged godRoadLight so updateGodNeon drives every one.
    for ( const z of [ - 1.4, - 0.7, 0, 0.7, 1.4 ] ) {

        const rl = new THREE.PointLight( 0x00FFFF, 0.9, 3.5, 1.8 );
        rl.position.set( 0, - 0.55, z );
        rl.userData.godRoadLight = true;
        parent.add( rl );

    }

    // Full-width front LED light bar (white)
    _addCarMesh( parent, new THREE.BoxGeometry( 1.7, 0.04, 0.06 ), headlightMat, [ 0, - 0.08, - 1.88 ] );
    // Vertical LED slits (Tron-style headlights)
    for ( const x of [ - 0.75, - 0.5, 0.5, 0.75 ] ) {

        _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.16, 0.06 ), headlightMat, [ x, - 0.16, - 1.88 ] );

    }
    // Pair of higher main beams
    for ( const x of [ - 0.62, 0.62 ] ) {

        _addCarMesh( parent, _visLightGeom, headlightMat, [ x, - 0.04, - 1.86 ] );

    }

    // Full-width rear LED strip + segmented taillights
    for ( const x of [ - 0.7, - 0.35, 0, 0.35, 0.7 ] ) {

        _addTaillight( parent, new THREE.BoxGeometry( 0.3, 0.08, 0.06 ), taillightMat, [ x, 0.05, 1.86 ], true );

    }
    // Lower rear glow bar
    _addTaillight( parent, new THREE.BoxGeometry( 1.7, 0.04, 0.06 ), taillightMat, [ 0, - 0.18, 1.88 ], true );

    // Roof beacon array (kept from previous design — futuristic spotlight strip)
    const roofLightGeom = new THREE.BoxGeometry( 0.18, 0.14, 0.14 );
    for ( const x of [ - 0.5, - 0.17, 0.17, 0.5 ] ) _addCarMesh( parent, roofLightGeom, roofLightMat, [ x, 0.46, - 0.55 ] );

    // Side air intakes (glowing inside)
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.18, 0.7 ), darkMat, [ - 1.0, 0.05, 0.5 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.18, 0.7 ), darkMat, [ 1.0, 0.05, 0.5 ] );
    const intakeL = new THREE.Mesh( new THREE.BoxGeometry( 0.03, 0.06, 0.6 ), neonCyanMat );
    intakeL.position.set( - 1.01, 0.05, 0.5 );
    parent.add( intakeL );
    const intakeR = new THREE.Mesh( new THREE.BoxGeometry( 0.03, 0.06, 0.6 ), neonCyanMat );
    intakeR.position.set( 1.01, 0.05, 0.5 );
    parent.add( intakeR );

    // Side mirrors (small angular cameras) — mirror housing nudged outboard 3mm to avoid coplanar face with stalk
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.08 ), darkMat, [ - 0.88, 0.18, - 0.65 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.14, 0.08, 0.08 ), accentMat, [ - 0.973, 0.2, - 0.65 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.04, 0.04, 0.08 ), darkMat, [ 0.88, 0.18, - 0.65 ] );
    _addCarMesh( parent, new THREE.BoxGeometry( 0.14, 0.08, 0.08 ), accentMat, [ 0.973, 0.2, - 0.65 ] );

}

const _CAR_BUILDERS = {
    'Hatchback': _buildHatchback,
    'Muscle V8': _buildMuscleV8,
    'Sport Flat-six': _buildSportFlatSix,
    'Rally Turbo': _buildRallyTurbo,
    'Supercar V12': _buildSupercarV12,
    'F1': _buildF1,
    'God Car': _buildGodCar
};

function buildCarVisuals( parent, car ) {

    ( _CAR_BUILDERS[ car.name ] || _buildHatchback )( parent );

}

function _disposeCarVisuals() {

    if ( ! carVisualsGroup ) return;
    while ( carVisualsGroup.children.length > 0 ) {

        const c = carVisualsGroup.children[ 0 ];
        carVisualsGroup.remove( c );
        if ( c.geometry ) c.geometry.dispose();
        if ( c.material ) c.material.dispose();

    }

}

function addWheel( index, pos, carMesh ) {

    const wheelWidth = 0.4;
    const wheelDirection = { x: 0.0, y: - 1.0, z: 0.0 };
    const wheelAxle = { x: - 1.0, y: 0.0, z: 0.0 };

    vehicleController.addWheel(
        pos,
        wheelDirection,
        wheelAxle,
        currentCar.suspensionRestLength,
        WHEEL_RADIUS
    );

    vehicleController.setWheelSuspensionStiffness( index, currentCar.suspensionStiffness );
    vehicleController.setWheelSuspensionCompression( index, currentCar.suspensionCompression );
    vehicleController.setWheelSuspensionRelaxation( index, currentCar.suspensionRelaxation );
    vehicleController.setWheelFrictionSlip( index, currentCar.wheelFrictionSlip );
    vehicleController.setWheelSteering( index, pos.z < 0 );

    // Wheel = Group containing a black tyre + a silver rim with 5 spokes +
    // a hub cap on each visible face. The whole Group inherits the per-wheel
    // spin/steer quaternion from updateWheels(), so the spokes visibly
    // rotate when the car moves and sit still when stopped — load-bearing
    // for "you can tell the car is rolling vs sliding" feedback.
    const wheel = new THREE.Group();
    wheel.position.copy( pos );

    // Tyre — pure 0x000000 so paintCarPurple() skips it (tyres stay black
    // even in AI mode); see the hex-exception check in paintCarPurple.
    const tyreGeom = new THREE.CylinderGeometry( WHEEL_RADIUS, WHEEL_RADIUS, wheelWidth, 20 );
    tyreGeom.rotateZ( Math.PI * 0.5 );
    const tyreMat = new THREE.MeshStandardMaterial( { color: 0x000000, roughness: 0.9, metalness: 0.0 } );
    const tyre = new THREE.Mesh( tyreGeom, tyreMat );
    tyre.castShadow = true;
    wheel.add( tyre );

    // Rim assembly mirrored on both faces of the tyre — at spawn we don't
    // know whether this is a +X or -X wheel relative to the chassis, and
    // the spokes need to be visible from the outboard face either way.
    // Silver for the rim ring + 5 spokes. Black for the hub. Tyre also black
    // (already set above). Net look: black wheel with a thin silver outline
    // and 5 silver spokes radiating from a black centre.
    const silverMat = new THREE.MeshStandardMaterial( { color: 0xC8CDD2, roughness: 0.3, metalness: 0.85 } );
    const blackHubMat = new THREE.MeshStandardMaterial( { color: 0x000000, roughness: 0.6, metalness: 0.2 } );
    const spokeLen = WHEEL_RADIUS * 0.70;
    const spokeGeom = new THREE.BoxGeometry( 0.03, spokeLen, 0.05 );
    spokeGeom.translate( 0, spokeLen * 0.5, 0 );  // base at y=0, tip at y=spokeLen
    const hubGeom = new THREE.BoxGeometry( 0.05, 0.09, 0.09 );
    // Thin silver outer ring — Torus so it's a real circle outline, not a
    // disc. Default torus lies in XY plane; rotate around Y by π/2 so it
    // sits in the YZ plane (perpendicular to the wheel's X spin axis).
    // Sized smaller than the tyre (0.75× WHEEL_RADIUS) so it clearly reads
    // as a rim INSIDE the tyre — like a real wheel.
    const ringGeom = new THREE.TorusGeometry( WHEEL_RADIUS * 0.75, 0.015, 6, 28 );
    ringGeom.rotateY( Math.PI * 0.5 );
    for ( const side of [ - 1, 1 ] ) {

        const sideX = side * ( wheelWidth * 0.5 + 0.008 );

        // Thin silver outer ring.
        const ring = new THREE.Mesh( ringGeom, silverMat );
        ring.position.x = sideX;
        ring.castShadow = true;
        wheel.add( ring );

        // Black hub cap at the wheel centre.
        const hub = new THREE.Mesh( hubGeom, blackHubMat );
        hub.position.x = sideX + side * 0.025;
        hub.castShadow = true;
        wheel.add( hub );

        // Five silver spokes radiating from the hub to the ring.
        for ( let s = 0; s < 5; s ++ ) {

            const ang = ( s / 5 ) * Math.PI * 2;
            const spoke = new THREE.Mesh( spokeGeom, silverMat );
            spoke.position.x = sideX;
            spoke.rotation.x = ang;
            spoke.castShadow = true;
            wheel.add( spoke );

        }

    }

    wheels.push( wheel );
    carMesh.add( wheel );

}

let _visualWheelSpin = 0;
const _wheelFwdTmp = new THREE.Vector3();
const _wheelQTmp = new THREE.Quaternion();
function updateWheels( dt ) {

    if ( vehicleController === undefined ) return;

    // Velocity-driven wheel spin: derive angular velocity from the chassis
    // forward velocity (signed) divided by wheel radius. Always matches
    // ground speed visually — no wheelspin on burnouts, no lockup under
    // brakes, no per-axle independent slip. Just clean rolling.
    if ( chassis ) {

        const lv = chassis.linvel();
        const r = chassis.rotation();
        _wheelQTmp.set( r.x, r.y, r.z, r.w );
        _wheelFwdTmp.set( 0, 0, - 1 ).applyQuaternion( _wheelQTmp );
        const vFwd = lv.x * _wheelFwdTmp.x + lv.z * _wheelFwdTmp.z;
        _visualWheelSpin += ( vFwd / WHEEL_RADIUS ) * ( dt || ( 1 / 60 ) );

    }

    const wheelSteeringQuat = new THREE.Quaternion();
    const wheelRotationQuat = new THREE.Quaternion();
    const up = new THREE.Vector3( 0, 1, 0 );

    // The per-map car scale (carScale in MAPS) multiplies the chassis root
    // node, so wheel.position values — set in physics metres — also get
    // scaled, AND the wheel mesh's radius scales too. Two corrections:
    //   1. Divide suspension travel by parent scale so the wheel CENTER
    //      lands where physics says.
    //   2. Add WHEEL_RADIUS·(1 − 1/scale) lift so the bigger wheel mesh
    //      doesn't sink half its scaled radius into the ground.
    const carScaleY = ( car && car.scale && car.scale.y ) ? car.scale.y : 1;
    const wheelLift = WHEEL_RADIUS * ( 1 - 1 / carScaleY );

    wheels.forEach( ( wheel, index ) => {

        const wheelAxleCs = vehicleController.wheelAxleCs( index );
        const connection = vehicleController.wheelChassisConnectionPointCs( index ).y || 0;
        const suspension = vehicleController.wheelSuspensionLength( index ) || 0;
        const steering = vehicleController.wheelSteering( index ) || 0;
        const rotationRad = _visualWheelSpin;

        wheel.position.y = ( connection - suspension ) / carScaleY + wheelLift;

        wheelSteeringQuat.setFromAxisAngle( up, steering );
        wheelRotationQuat.setFromAxisAngle( wheelAxleCs, rotationRad );

        wheel.quaternion.multiplyQuaternions( wheelSteeringQuat, wheelRotationQuat );

    } );

}

// ---------- input / transmission / engine pipeline ----------

function applyDeadzone( v, dz ) {

    if ( Math.abs( v ) < dz ) return 0;
    return Math.sign( v ) * ( Math.abs( v ) - dz ) / ( 1 - dz );

}

// Shape the merged steer input through deadzone → curve. Returns a value in
// [-1, 1]. The deadzone snaps small residual values (controller drift,
// floating-point noise from max-merging across sources) to exactly 0, fixing
// the "driving straight feels like it's drifting" problem visible on the
// joystick-map widget. The exponent flattens the response near center so
// fine corrections at speed aren't twitchy, while still reaching ±1 at full
// stick deflection.
function shapeSteer( raw ) {

    const a = Math.abs( raw );
    if ( a <= steeringCfg.deadzone ) return 0;
    const remapped = ( a - steeringCfg.deadzone ) / ( 1 - steeringCfg.deadzone );
    const curved = Math.pow( remapped, steeringCfg.curveExponent );
    return Math.sign( raw ) * curved;

}

// Scale the per-car mechanical maximum steering angle by speed so the car
// can't be ripped sideways at 200 km/h. Returns [minFactor, 1] — at
// standstill we get full lock, then it ramps down to minFactor at vReduceMax.
function steeringSpeedFactor( speed ) {

    const t = Math.min( 1, Math.abs( speed ) / steeringCfg.vReduceMax );
    return THREE.MathUtils.lerp( 1, steeringCfg.minFactor, t );

}

// Per-driven-wheel traction-control multiplier. Returns 1.0 when slip is in
// the safe range, then ramps down toward `minMult` as slip exceeds the
// per-car threshold. The slip ratio is clamped at low vehicle speed because
// the slipRatio = (wheelV − bodyV)/bodyV math blows up as bodyV → 0 and
// otherwise TC chokes throttle on every hill-start / sand-launch.
function tractionCutFactor( slipRatio, speed, car ) {

    if ( ! tcCfg.enabled ) return 1;
    const absSpeed = Math.abs( speed );
    if ( absSpeed < tcCfg.minActiveSpeed ) return 1;
    // Per-car TC override (car.tc) is merged onto tcCfg defaults. Lets a
    // high-perf car (F1, Supercar) have a wider slipThreshold + higher
    // minMult so TC barely intervenes during a launch, while economy cars
    // keep the conservative defaults.
    const ov = car && car.tc ? car.tc : null;
    const baseSlip = ov && ov.slipThreshold != null ? ov.slipThreshold : tcCfg.slipThreshold;
    const cutGain  = ov && ov.cutGain       != null ? ov.cutGain       : tcCfg.cutGain;
    const minMult  = ov && ov.minMult       != null ? ov.minMult       : tcCfg.minMult;
    const carGrip = car ? ( car.wheelFrictionSlip || 2.0 ) : 2.0;
    const threshold = baseSlip * ( 1 + ( carGrip - 2.0 ) * tcCfg.gripScale );
    const excess = Math.abs( slipRatio ) - threshold;
    if ( excess <= 0 ) return 1;
    let cut = excess * cutGain;
    // Smooth fade-in: TC strength scales from 0 (at minActiveSpeed) to 1
    // (at fadeInSpeed) so accelerating out of standstill / uphill / sand
    // doesn't snap into a hard torque cut the moment we leave the exemption.
    if ( absSpeed < tcCfg.fadeInSpeed ) {

        const fade = ( absSpeed - tcCfg.minActiveSpeed ) / ( tcCfg.fadeInSpeed - tcCfg.minActiveSpeed );
        cut *= Math.max( 0, Math.min( 1, fade ) );

    }
    return Math.max( minMult, 1 - cut );

}

// ABS multiplier — cuts brake force on a wheel when its slip ratio is past
// the lock-up threshold, restoring lateral grip so steering still works
// during heavy braking. Same shape as TC but reads the brake side.
function absModulate( brakeForce, slipRatio, speed ) {

    if ( ! absCfg.enabled ) return brakeForce;
    if ( brakeForce <= 0 ) return brakeForce;
    if ( Math.abs( speed ) < absCfg.minActiveSpeed ) return brakeForce;
    const excess = Math.abs( slipRatio ) - absCfg.slipThreshold;
    if ( excess <= 0 ) return brakeForce;
    const mult = Math.max( absCfg.minMult, 1 - excess * absCfg.cutGain );
    return brakeForce * mult;

}

function pollGamepad() {

    if ( gamepad.index < 0 ) return null;
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const pad = pads[ gamepad.index ];
    if ( ! pad ) return null;

    const steer = applyDeadzone( pad.axes[ 0 ] || 0, 0.12 );
    const throttle = pad.buttons[ 7 ] ? pad.buttons[ 7 ].value : 0; // RT
    const brake = pad.buttons[ 6 ] ? pad.buttons[ 6 ].value : 0;   // LT
    const handbrake = pad.buttons[ 0 ] && pad.buttons[ 0 ].pressed ? 1 : 0; // A

    // Edge-trigger bumpers / face buttons.
    const prev = gamepad.prevButtons;
    const rb = pad.buttons[ 5 ] && pad.buttons[ 5 ].pressed;
    const lb = pad.buttons[ 4 ] && pad.buttons[ 4 ].pressed;
    const b = pad.buttons[ 1 ] && pad.buttons[ 1 ].pressed; // B — toggle ABS
    const x = pad.buttons[ 2 ] && pad.buttons[ 2 ].pressed; // mode toggle
    const y = pad.buttons[ 3 ] && pad.buttons[ 3 ].pressed; // camera toggle
    const back = pad.buttons[ 8 ] && pad.buttons[ 8 ].pressed; // Back / Select / Share — cycle car
    const start = pad.buttons[ 9 ] && pad.buttons[ 9 ].pressed; // reset
    const dUp = pad.buttons[ 12 ] && pad.buttons[ 12 ].pressed; // D-pad up — stats for nerds
    const dDown = pad.buttons[ 13 ] && pad.buttons[ 13 ].pressed; // D-pad down — toggle TC
    const dLeft = pad.buttons[ 14 ] && pad.buttons[ 14 ].pressed; // D-pad left — minimap
    const dRight = pad.buttons[ 15 ] && pad.buttons[ 15 ].pressed; // D-pad right — cycle map

    if ( rb && ! prev[ 5 ] && transmission.mode === 'manual' ) manualShift( 1 );
    if ( lb && ! prev[ 4 ] && transmission.mode === 'manual' ) manualShift( - 1 );
    if ( b && ! prev[ 1 ] ) toggleAbs();
    if ( x && ! prev[ 2 ] ) toggleTransmissionMode();
    if ( y && ! prev[ 3 ] ) cycleCameraMode();
    if ( back && ! prev[ 8 ] ) cycleCar( 1 );
    if ( dUp && ! prev[ 12 ] ) toggleStatsForNerds();
    if ( dDown && ! prev[ 13 ] ) toggleTractionControl();
    if ( dLeft && ! prev[ 14 ] ) toggleMinimap();
    if ( dRight && ! prev[ 15 ] ) {

        // Cycle through MAPS in declaration order so D-pad → matches the
        // 1 / 2 / 3 keyboard binds.
        const ids = Object.keys( MAPS );
        swapMap( ids[ ( ids.indexOf( currentMapId ) + 1 ) % ids.length ] );

    }
    if ( start && ! prev[ 9 ] ) input.keyR = true; else if ( ! start && prev[ 9 ] ) input.keyR = false;

    // Any gamepad button press counts as a user gesture in modern browsers,
    // so we can also unlock audio from here — handy for players who jump
    // straight into driving with a controller and never touch the keyboard.
    if ( ! audio.started ) {

        for ( let i = 0; i < pad.buttons.length; i ++ ) {

            if ( pad.buttons[ i ] && pad.buttons[ i ].pressed ) { startAudio(); break; }

        }

    }

    gamepad.prevButtons = pad.buttons.map( b => b.pressed );

    return { steer, throttle, brake, handbrake };

}

function updateInput( dt ) {

    // Keyboard contribution (binary).
    let kSteer = 0;
    if ( input.keyA || input.arrowLeft ) kSteer += 1;
    if ( input.keyD || input.arrowRight ) kSteer -= 1;

    const kThrottle = ( input.keyW || input.arrowUp ) ? 1 : 0;
    // Space is a plain brake (no reverse). S still does brake + long-press reverse.
    const kBrake = ( input.keyS || input.arrowDown || input.keySpace ) ? 1 : 0;
    const kHandbrake = input.keyE ? 1 : 0;

    // Gamepad contribution (analog, overrides if magnitude > keyboard).
    const pad = pollGamepad();
    let steer = kSteer;
    let throttle = kThrottle;
    let brake = kBrake;
    let handbrake = kHandbrake;
    if ( pad ) {

        if ( Math.abs( pad.steer ) > Math.abs( steer ) ) steer = - pad.steer; // invert for our coord system
        if ( pad.throttle > throttle ) throttle = pad.throttle;
        if ( pad.brake > brake ) brake = pad.brake;
        if ( pad.handbrake > handbrake ) handbrake = pad.handbrake;

    }

    // Touch overlay merges in last. Analog values, max-wins.
    if ( touch.enabled ) {

        if ( Math.abs( touch.steer ) > Math.abs( steer ) ) steer = touch.steer;
        if ( touch.throttle > throttle ) throttle = touch.throttle;
        if ( touch.brake > brake ) brake = touch.brake;
        if ( touch.handbrake > handbrake ) handbrake = touch.handbrake;

    }

    // Capture the raw (pre-shape) merged steer so the joystick-map widget +
    // telemetry can show what the driver actually requested. The curve below
    // shapes the steer that the *physics* uses — small inputs become smaller
    // (softer near center) and a 4.5% deadzone snaps residual drift to 0 so
    // the car tracks straight when no one is touching the wheel.
    input.steerRaw = THREE.MathUtils.clamp( steer, - 1, 1 );
    input.steer = shapeSteer( input.steerRaw );
    input.throttle = throttle;
    input.brake = brake;
    input.handbrake = handbrake;
    input.reset = input.keyR;

    // Post-R handbrake lock — set by the reset block in applyVehicleForces.
    // Released the moment the player actually inputs anything (key, gamepad,
    // or touch). Until then we force handbrake = 1 so the chassis can't roll.
    if ( input.handbrakeAfterReset ) {

        if ( _anyInputActive() ) input.handbrakeAfterReset = false;
        else input.handbrake = 1;

    }

    // Long-press reverse: S / ↓ / touch brake bar trigger this — Space is a
    // pure brake and never engages reverse. Requires car essentially stopped.
    const speed = vehicleController ? Math.abs( vehicleController.currentVehicleSpeed() ) : 0;
    const reverseTrigger = ( input.keyS || input.arrowDown || touch.brakeActive ) ? 1 : 0;
    if ( reverseTrigger > 0.5 && speed < 0.6 ) {

        input.sHeldTime += dt;
        if ( input.sHeldTime > 0.3 ) input.reverseEngaged = true;

    } else if ( reverseTrigger < 0.1 ) {

        input.sHeldTime = 0;
        if ( throttle > 0.1 && transmission.mode === 'auto' ) input.reverseEngaged = false;

    }

    // Gamepad LT-held-at-full reverse trigger. Triggers and binary-pedal
    // paths are intentionally separate because LT is naturally held hard
    // when braking down to a stop — we use a longer dwell (2 s) and a high
    // pressure threshold (> 0.95) so it doesn't fire on a normal hard stop.
    const padBrake = pad ? pad.brake : 0;
    if ( padBrake > 0.95 && speed < 0.6 ) {

        input.padBrakeFullTime += dt;
        if ( input.padBrakeFullTime > 2.0 ) input.reverseEngaged = true;

    } else if ( padBrake < 0.5 ) {

        input.padBrakeFullTime = 0;
        if ( throttle > 0.1 && transmission.mode === 'auto' ) input.reverseEngaged = false;

    }

}

function gearRatio( gear ) {

    if ( gear === 0 ) return 0;
    if ( gear === - 1 ) return currentCar.reverseRatio;
    const idx = gear - 1;
    if ( idx < 0 || idx >= currentCar.gearRatios.length ) return 0;
    return currentCar.gearRatios[ idx ];

}

function maxGear() { return currentCar.gearRatios.length; }

function manualShift( direction ) {

    if ( transmission.shiftCooldown > 0 ) return;
    const next = transmission.gear + direction;
    if ( next < - 1 || next > maxGear() ) return;
    transmission.gear = next;
    transmission.shiftCooldown = 0.15;
    playShiftSound();

}

function toggleTransmissionMode() {

    transmission.mode = transmission.mode === 'auto' ? 'manual' : 'auto';
    if ( speedoModeEl ) speedoModeEl.textContent = transmission.mode.toUpperCase();
    // When switching to manual mid-drive, start in current ratio so we don't
    // jolt the engine. Auto will sort itself out next frame.

}

// Map vehicle speed + current gear → engine RPM.
function computeRpm( speed, gear ) {

    const ratio = gearRatio( gear );
    if ( ratio === 0 ) return engine.idleRpm;
    const wheelOmega = Math.abs( speed ) / WHEEL_RADIUS;       // rad/s
    const wheelRpm = wheelOmega * 60 / ( 2 * Math.PI );
    const rpm = wheelRpm * Math.abs( ratio ) * currentCar.finalDrive;
    return Math.max( engine.idleRpm, rpm );

}

// Bell-shaped torque curve, normalized to [0,1]. Peak / width come from the
// current car, so different engines have visibly different powerband shapes.
function torqueAt( rpm ) {

    if ( rpm >= engine.redline ) return 0.15; // rev limiter cut
    const x = ( rpm - currentCar.peakTorqueRpm ) / currentCar.torqueCurveWidth;
    return Math.max( 0.18, Math.exp( - x * x ) );

}

function updateTransmission( dt, speed ) {

    if ( transmission.shiftCooldown > 0 ) transmission.shiftCooldown -= dt;

    if ( transmission.mode === 'manual' ) return; // user shifts in manual

    // Auto reverse handling.
    if ( input.reverseEngaged && transmission.gear !== - 1 ) {

        transmission.gear = - 1;
        transmission.shiftCooldown = 0.2;
        playShiftSound();
        return;

    }
    if ( ! input.reverseEngaged && transmission.gear === - 1 && input.throttle > 0.1 ) {

        transmission.gear = 1;
        transmission.shiftCooldown = 0.2;
        playShiftSound();
        return;

    }

    if ( transmission.shiftCooldown > 0 ) return;

    // From a standing start, auto shifts into 1st when throttle is pressed.
    if ( transmission.gear === 0 && input.throttle > 0.05 ) {

        transmission.gear = 1;
        transmission.shiftCooldown = 0.15;
        playShiftSound();
        return;

    }

    // Upshift when RPM crosses threshold and we're under throttle.
    if ( transmission.gear >= 1 && transmission.gear < maxGear() && engine.rpm > engine.autoUpshiftRpm && input.throttle > 0.4 ) {

        transmission.gear += 1;
        transmission.shiftCooldown = 0.25;
        playShiftSound();
        return;

    }

    // Downshift on low RPM.
    if ( transmission.gear > 1 && engine.rpm < engine.autoDownshiftRpm ) {

        transmission.gear -= 1;
        transmission.shiftCooldown = 0.25;
        playShiftSound();

    }

}

function applyVehicleForces( speed, dt ) {

    if ( input.reset ) {

        chassis.setTranslation( new physics.RAPIER.Vector3( spawnPoint.x, spawnPoint.y, spawnPoint.z ), true );
        chassis.setRotation( new physics.RAPIER.Quaternion( spawnQuaternion.x, spawnQuaternion.y, spawnQuaternion.z, spawnQuaternion.w ), true );
        chassis.setLinvel( new physics.RAPIER.Vector3( 0, 0, 0 ), true );
        chassis.setAngvel( new physics.RAPIER.Vector3( 0, 0, 0 ), true );
        transmission.gear = 1;
        transmission.shiftCooldown = 0;
        engine.rpm = engine.idleRpm;
        input.reverseEngaged = false;
        input.sHeldTime = 0;
        input.padBrakeFullTime = 0;
        input.handbrakeAfterReset = true;
        chaseCam.initialized = false;
        resetTires();
        resetDrivetrain();
        clearSkidMarks();
        lapTimerResetCurrent();
        resetDualsenseState();
        return;

    }

    if ( chassis.isSleeping() ) chassis.wakeUp();

    // ENGINE FORCE.
    // In AUTO with reverseEngaged, the brake pedal doubles as the reverse throttle.
    // In MANUAL, throttle is always W; gear sign decides direction.
    let throttleEffective = input.throttle;
    if ( transmission.mode === 'auto' && input.reverseEngaged ) {

        throttleEffective = input.brake; // S pedal acts as reverse accelerator

    }

    const ratio = gearRatio( transmission.gear );

    // Direct engine-force model (reverted from the clutch+flywheel drivetrain
    // because the clutch's engine-braking force was overpowering the tire
    // friction limit, locking the wheels at cruise and crashing the Pacejka
    // grip multiplier into a feedback loop). The clutch state used by the
    // stats panel is kept for telemetry but is now a thin signal.
    let engineForce = 0;
    if ( ratio !== 0 && throttleEffective > 0 ) {

        const torque = torqueAt( engine.rpm );
        const magnitude = throttleEffective * torque * currentCar.maxEngineForce;
        engineForce = - magnitude * Math.sign( ratio );

    }
    // Route engine force to the correct wheels for FWD/RWD/AWD. The original
    // tuning was 2 wheels × engineForce → 2·engineForce total chassis force.
    // Distribute the *same total* across however many driven wheels this car
    // has, so swapping driveType doesn't change acceleration: each driven
    // wheel gets (2·engineForce) / N. AWD therefore puts 50 % torque on each
    // wheel (even split, simple center "diff").
    const driven = drivenWheelIndices( currentCar.driveType );
    const perDriven = ( 2 * engineForce ) / driven.length;
    // Traction control: trim per-wheel torque whenever its slip ratio is
    // past the peak-grip threshold. Track the largest cut for the stats panel
    // and latch an "engaged" indicator for ~120ms so the UI light is readable.
    let frameMaxCut = 0;
    for ( let i = 0; i < 4; i ++ ) {

        const isDriven = driven.indexOf( i ) >= 0;
        if ( ! isDriven ) {

            vehicleController.setWheelEngineForce( i, 0 );
            continue;

        }
        const tcMult = tractionCutFactor( tires.slipRatio[ i ], speed, currentCar );
        const cut = 1 - tcMult;
        if ( cut > frameMaxCut ) frameMaxCut = cut;
        vehicleController.setWheelEngineForce( i, perDriven * tcMult );

    }
    drivetrain.tc.cutPct = frameMaxCut;
    if ( frameMaxCut > 0.02 ) {

        if ( ! drivetrain.tc.engaged ) drivetrain.tc.eventCount += 1;
        drivetrain.tc.engaged = true;
        drivetrain.tc.engagedUntil = performance.now() + 120;

    } else if ( performance.now() > drivetrain.tc.engagedUntil ) {

        drivetrain.tc.engaged = false;

    }

    // Light cosmetic clutch state for the stats display.
    drivetrain.clutchOpen = transmission.shiftCooldown > 0 || ratio === 0;
    drivetrain.clutchTorque = drivetrain.clutchOpen ? 0 : engineForce;

    // BRAKE.
    // In auto+reverseEngaged, the brake pedal is throttle so no braking from it.
    // In every other case, S applies the service brake.
    let serviceBrake = 0;
    if ( ! ( transmission.mode === 'auto' && input.reverseEngaged ) ) {

        serviceBrake = input.brake * currentCar.maxBrakeForce;

    }
    const handbrake = input.handbrake * currentCar.maxBrakeForce * currentCar.handbrakeMultiplier;

    // Brake bias: shift the service brake forward (or rearward) per car.
    // bias = 0.5 keeps the old equal split; FWD/heavy-nose cars get more
    // bias so the rear doesn't lock first. Total brake force stays equal
    // (frontMul + rearMul = 2, so 2*front + 2*rear = 4 * serviceBrake = old).
    const bias = currentCar.brakeBias != null ? currentCar.brakeBias : 0.5;
    const frontMul = bias * 2;
    const rearMul = ( 1 - bias ) * 2;
    const fbFront = serviceBrake * frontMul;
    const fbRear = serviceBrake * rearMul;

    // ABS modulation per wheel. Handbrake is applied AFTER ABS so the
    // handbrake can still lock the rears intentionally (drift / e-brake).
    const w0 = absModulate( fbFront, tires.slipRatio[ 0 ], speed );
    const w1 = absModulate( fbFront, tires.slipRatio[ 1 ], speed );
    const w2 = absModulate( fbRear,  tires.slipRatio[ 2 ], speed );
    const w3 = absModulate( fbRear,  tires.slipRatio[ 3 ], speed );

    // Telemetry: largest fractional ABS cut across all four wheels this frame.
    let absMaxCut = 0;
    if ( fbFront > 0 ) {

        absMaxCut = Math.max( absMaxCut, 1 - w0 / fbFront, 1 - w1 / fbFront );

    }
    if ( fbRear > 0 ) {

        absMaxCut = Math.max( absMaxCut, 1 - w2 / fbRear, 1 - w3 / fbRear );

    }
    drivetrain.abs.cutPct = absMaxCut;
    if ( absMaxCut > 0.02 ) {

        if ( ! drivetrain.abs.engaged ) drivetrain.abs.eventCount += 1;
        drivetrain.abs.engaged = true;
        drivetrain.abs.engagedUntil = performance.now() + 120;

    } else if ( performance.now() > drivetrain.abs.engagedUntil ) {

        drivetrain.abs.engaged = false;

    }

    vehicleController.setWheelBrake( 0, w0 );
    vehicleController.setWheelBrake( 1, w1 );
    vehicleController.setWheelBrake( 2, Math.max( w2, handbrake ) );
    vehicleController.setWheelBrake( 3, Math.max( w3, handbrake ) );

    // Straight-line lateral-velocity assist. On a slope, gravity pulls the
    // car sideways relative to its heading — the wheels integrate that as
    // chassis-local +X velocity even when the player is going perfectly
    // straight, and the slip angle grows past peak, grip collapses,
    // car slides off into the wall at 15 km/h. This bleeds off that
    // unintended lateral velocity whenever the player has centred steering
    // and no handbrake. Two strengths:
    //   - hard damp when braking (caught the panic-stop slide on slopes)
    //   - mild damp when coasting (catches the long-tail crab from any
    //     residual setup asymmetry — toe, suspension, surface)
    // Both fade above ~12 m/s so the player can still trail-brake or
    // four-wheel drift on the flat at speed.
    if ( Math.abs( input.steer ) < 0.02 && input.handbrake < 0.05 ) {

        const v = chassis.linvel();
        const q = chassis.rotation();
        _worldToLocalVec( v, q, _carLocalVel );
        const vLatLocal = _carLocalVel.x;
        if ( Math.abs( vLatLocal ) > 0.03 ) {

            const speedAssist = Math.hypot( v.x, v.y, v.z );
            const speedFactor = speedAssist < 12
                ? 1
                : Math.max( 0.15, 1 - ( speedAssist - 12 ) / 28 );
            // Brake-pressing → strong damp (12 1/s). Coasting → mild (2 1/s).
            const brakeStrength = 12.0 * input.brake;
            const coastStrength = input.throttle < 0.05 && input.brake < 0.05 ? 2.0 : 0;
            const dampRate = ( brakeStrength + coastStrength ) * speedFactor;
            if ( dampRate > 0 ) {

                const k = 1 - Math.exp( - dampRate * dt );
                // world right-axis = quaternion-rotated (1, 0, 0)
                const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
                const rx = 1 - 2 * ( qy * qy + qz * qz );
                const ry = 2 * ( qx * qy + qw * qz );
                const rz = 2 * ( qx * qz - qw * qy );
                const reduction = k * vLatLocal;
                chassis.setLinvel(
                    { x: v.x - reduction * rx, y: v.y - reduction * ry, z: v.z - reduction * rz },
                    true
                );

            }

        }

    }

    // STEERING — non-linear curve (in shapeSteer), speed-scaled mechanical
    // max, and dt-aware smoothing. Toe stays baked in as the *resting*
    // steering angle; driver input lerps an offset on top.
    const toe = currentCar.toeDeg || [ 0, 0, 0, 0 ];
    const toeFL = toe[ 0 ] * _DEG;
    const toeFR = toe[ 1 ] * _DEG;
    // Read current driver-steering offset by subtracting the toe contribution
    // off the wheel. Both front wheels share the same driver offset.
    const currentOffset = vehicleController.wheelSteering( 0 ) - toeFL;
    const speedFactor = steeringSpeedFactor( speed );
    const maxAngle = currentCar.maxSteeringAngle * speedFactor;
    const target = maxAngle * input.steer;
    // Return-to-center is faster than steer-in so the wheels actually settle
    // when input goes to 0 instead of asymptotically lingering off-axis.
    const returning = Math.abs( target ) < Math.abs( currentOffset );
    const rate = returning ? steeringCfg.smoothReturnRate : steeringCfg.smoothInRate;
    const alpha = 1 - Math.exp( - rate * dt );
    let steering = THREE.MathUtils.lerp( currentOffset, target, alpha );
    // Snap to zero when the input is centered and we're inside the
    // numerical noise floor. Catches the long tail of the exponential decay
    // — without this, the wheels never quite reach 0 and the chassis drifts.
    if ( input.steer === 0 && Math.abs( steering ) < steeringCfg.zeroSnapRad ) steering = 0;
    // Telemetry for the joystick map + stats panel.
    steeringTelemetry.target = target;
    steeringTelemetry.actual = steering;
    steeringTelemetry.maxAngle = maxAngle;
    steeringTelemetry.speedFactor = speedFactor;
    vehicleController.setWheelSteering( 0, toeFL + steering );
    vehicleController.setWheelSteering( 1, toeFR + steering );

}

const _carQuat = new THREE.Quaternion();
const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _desiredPos = new THREE.Vector3();
const _desiredLook = new THREE.Vector3();
const _worldUp = new THREE.Vector3( 0, 1, 0 );

function updateChaseCamera( delta ) {

    if ( ! chassis || ! car ) return;

    const r = chassis.rotation();
    _carQuat.set( r.x, r.y, r.z, r.w );

    _forward.set( 0, 0, - 1 ).applyQuaternion( _carQuat );
    _forward.y = 0;

    if ( _forward.lengthSq() < 1e-4 ) {

        _forward.subVectors( car.position, camera.position );
        _forward.y = 0;
        if ( _forward.lengthSq() < 1e-4 ) _forward.set( 0, 0, - 1 );

    }

    _forward.normalize();
    _right.crossVectors( _forward, _worldUp ).normalize();

    _desiredPos.copy( car.position )
        .addScaledVector( _forward, - chaseCam.positionOffset.z )
        .addScaledVector( _right, chaseCam.positionOffset.x )
        .addScaledVector( _worldUp, chaseCam.positionOffset.y );

    _desiredLook.copy( car.position )
        .addScaledVector( _forward, - chaseCam.lookOffset.z )
        .addScaledVector( _right, chaseCam.lookOffset.x )
        .addScaledVector( _worldUp, chaseCam.lookOffset.y );

    if ( ! chaseCam.initialized ) {

        camera.position.copy( _desiredPos );
        chaseCam.currentLookAt.copy( _desiredLook );
        chaseCam.initialized = true;

    } else {

        const posAlpha = 1 - Math.exp( - chaseCam.positionDamping * delta );
        const lookAlpha = 1 - Math.exp( - chaseCam.lookDamping * delta );

        camera.position.lerp( _desiredPos, posAlpha );
        chaseCam.currentLookAt.lerp( _desiredLook, lookAlpha );

    }

    camera.lookAt( chaseCam.currentLookAt );

    const v = chassis.linvel();
    const planarSpeed = Math.hypot( v.x, v.z );
    const t = Math.min( planarSpeed / chaseCam.speedForMaxFov, 1 );
    const targetFov = chaseCam.baseFov + chaseCam.maxFovBoost * t;
    const fovAlpha = 1 - Math.exp( - chaseCam.fovDamping * delta );
    camera.fov += ( targetFov - camera.fov ) * fovAlpha;
    camera.updateProjectionMatrix();

}

function onWindowResize() {

    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize( window.innerWidth, window.innerHeight );
    if ( dof.composer ) dof.composer.setSize( window.innerWidth, window.innerHeight );
    // Mobile UI: re-evaluate touchOnly + portrait/landscape and re-layout
    // the touch overlay + speedometer / pedal positions. Cheap — flips a
    // couple of CSS classes; never rebuilds DOM unless touchOnly itself
    // changes.
    if ( typeof _updateDeviceState === 'function' ) _updateDeviceState();
    if ( typeof applyMobileLayout === 'function' ) applyMobileLayout();

}

// ---------------- depth-of-field composer ----------------
// Built lazily on the first map that opts in via MAPS[id].dof so the cheaper
// maps pay nothing. When `enabled` is false we render straight through
// renderer.render(); when true we route through composer.render() with the
// bokeh pass focusing at `cfg.focus` metres.

const dof = { composer: null, bokeh: null, enabled: false };

function setupDof( cfg ) {

    if ( ! cfg ) {

        dof.enabled = false;
        return;

    }
    if ( ! dof.composer ) {

        dof.composer = new EffectComposer( renderer );
        dof.composer.setSize( window.innerWidth, window.innerHeight );
        dof.composer.addPass( new RenderPass( scene, camera ) );
        dof.bokeh = new BokehPass( scene, camera, {
            focus: cfg.focus,
            aperture: cfg.aperture,
            maxblur: cfg.maxblur
        } );
        dof.composer.addPass( dof.bokeh );
        dof.composer.addPass( new OutputPass() );

    } else {

        // Re-target the existing bokeh pass to this map's settings.
        if ( dof.bokeh.uniforms[ 'focus' ] ) dof.bokeh.uniforms[ 'focus' ].value = cfg.focus;
        if ( dof.bokeh.uniforms[ 'aperture' ] ) dof.bokeh.uniforms[ 'aperture' ].value = cfg.aperture;
        if ( dof.bokeh.uniforms[ 'maxblur' ] ) dof.bokeh.uniforms[ 'maxblur' ].value = cfg.maxblur;

    }
    dof.enabled = true;

}

function animate( time ) {

    // Frame lock: bail out if it isn't time for the next frame yet.
    // The 0.5ms slack absorbs rAF jitter so we don't drop a frame that
    // arrives a hair early on a 120Hz display.
    if ( time - fpsTarget.lastRenderTime < fpsTarget.frameInterval - 0.5 ) return;

    const frameDelta = time - fpsTarget.lastRenderTime;
    fpsTarget.lastRenderTime = time;

    // Adaptive downgrade: only meaningful when targeting 120.
    if ( fpsTarget.target === 120 ) {

        if ( frameDelta > fpsTarget.frameInterval * 1.4 ) {

            fpsTarget.overBudgetStreak ++;

            if ( fpsTarget.overBudgetStreak >= fpsTarget.overBudgetThreshold ) {

                fpsTarget.target = 60;
                fpsTarget.frameInterval = 1000 / 60;
                fpsTarget.overBudgetStreak = 0;
                if ( fpsLabel ) fpsLabel.textContent = 'system busy · downgraded to 60fps';

            }

        } else {

            fpsTarget.overBudgetStreak = 0;

        }

    }

    const delta = Math.min( clock.getDelta(), 0.1 );

    if ( vehicleController ) {

        const speed = vehicleController.currentVehicleSpeed();

        updateInput( delta );

        // AI overrides input.steer/throttle/brake after the human/gamepad/touch
        // merge above, so AI mode wins until the player toggles it back off (L).
        aiUpdate( delta );

        // Engine RPM is computed kinematically from wheel speed × gear ratio
        // × final drive. Smoothed slightly so gear shifts don't snap the gauge.
        const targetRpm = computeRpm( speed, transmission.gear );
        const rpmAlpha = 1 - Math.exp( - 12 * delta );
        engine.rpm += ( targetRpm - engine.rpm ) * rpmAlpha;

        updateTransmission( delta, speed );

        // Writes that the upcoming physics step will consume: engine force,
        // brakes, steering, and chassis aero impulse.
        applyVehicleForces( speed, delta );
        updateAerodynamics( delta );

        // updateVehicle applies suspension/engine forces TO the chassis body,
        // then world.step integrates one timestep with the same dt.
        vehicleController.updateVehicle( delta );
        physics.step( delta );

        // POST-STEP: read fresh sensor data (impulses, suspension force, wheel
        // angular position) and write friction values for the NEXT frame.
        updateSuspensionGeometry();
        updateTires( delta );

        updateWheels( delta );
        updateSpeedometer( speed );
        updateBrakeLights();
        updateGodNeon( delta );
        updateRumble( speed );
        rumbleTick();
        updateDualsense( speed );
        updateSkidMarks();

        statsForNerds.lastDelta = delta;
        updateStatsForNerds( speed );
        if ( statsForNerds.enabled ) renderJoystickMap();
        captureTelemetrySample( performance.now() );

        updateAudio( delta );

        updateLapTimer();

        _maybeBroadcastSnapshot( performance.now() );

    }

    _updateRemoteCars( delta );
    _tickRace();

    if ( cameraMode === 'chase' ) {

        updateChaseCamera( delta );

    } else if ( cameraMode === 'pov' ) {

        updatePovCamera();

    } else if ( controls && car ) { // free

        controls.target.copy( car.position );
        controls.update();

    }

    // Steering wheel mesh tracks the front tyre steer angle every frame,
    // regardless of camera mode (so it animates the same in chase / free / pov).
    if ( steeringWheelMesh && vehicleController ) {

        const cockpit = COCKPITS[ currentCar.name ];
        if ( cockpit ) {

            steeringWheelMesh.rotation.z = - vehicleController.wheelSteering( 0 ) * cockpit.wheelRotationMultiplier;

        }

    }

    // Sun follows the car so the tight shadow frustum stays useful at any
    // point on the 6km track.
    if ( car && sunLight && sunTarget ) {

        sunTarget.position.copy( car.position );
        sunLight.position.copy( car.position ).add( sunOffset );

        updateTrackVisibility();
        updateTrackShadowReceive();

    }

    if ( posLabel && chassis ) {

        const t = chassis.translation();
        posLabel.textContent = `pos: ${ t.x.toFixed( 1 ) }, ${ t.y.toFixed( 1 ) }, ${ t.z.toFixed( 1 ) }    (P to copy)`;

    }

    if ( physicsHelper && physicsHelper.visible ) physicsHelper.update();

    if ( dof.enabled && dof.composer ) dof.composer.render();
    else renderer.render( scene, camera );
    renderMinimap();

    stats.update();

}

// ─────────────────────────────────────────────────────────────────────────
// AI drive (press L)
//
// Pure-pursuit + curvature-based speed control on a pre-baked racing line
// (public/racing-lines/<id>.json, generated offline by scripts/extract-
// racing-line.mjs). The line is an ordered loop of { x, z, v } waypoints
// already optimised for minimum curvature and bounded by physics-derived
// brake / accel caps, so the AI just has to follow it accurately.
//
// Each frame aiUpdate() — called immediately after updateInput() in the
// main loop — picks a lookahead waypoint a speed-dependent distance ahead,
// computes the angle to it in the car's local frame, and writes input.steer
// + input.throttle + input.brake. The downstream physics pipeline (engine,
// brake, steer-shaping) is unchanged, so the AI feels like a perfectly
// disciplined human driver.
//
// Visuals: car body materials swap to bright purple, a thick magenta
// LineLoop above the track shows the line, and a small "AI DRIVE" badge
// appears top-centre. Any deliberate human input cancels AI mode.

const _aiPickedHumanInput = () => (
    input.keyW || input.keyS || input.keyA || input.keyD ||
    input.arrowUp || input.arrowDown || input.arrowLeft || input.arrowRight ||
    input.keySpace || input.keyE || ( touch.enabled && (
        Math.abs( touch.steer ) > 0.05 || touch.throttle > 0.05 || touch.brake > 0.05
    ) )
);

async function loadRacingLine( id ) {

    racingLine = null;
    try {

        const res = await fetch( import.meta.env.BASE_URL + 'racing-lines/' + id + '.json' );
        if ( ! res.ok ) { console.warn( `[ai] no racing-line for ${ id }` ); return; }
        const raw = await res.json();

        // Raycast each waypoint against the loaded track. Drop waypoints
        // whose ray either (a) misses the track entirely, or (b) hits a mesh
        // whose material name isn't in MAPS[id].roadMaterials — i.e. it
        // landed on grass / wall / shoulder rather than tarmac. This filters
        // out the Hierholzer Euler-circuit detours the extractor leaves in
        // the JSON at junctions / spawn areas.
        const roadMats = ( MAPS[ id ] && MAPS[ id ].roadMaterials ) ? new Set( MAPS[ id ].roadMaterials ) : null;
        const ray = new THREE.Raycaster();
        const down = new THREE.Vector3( 0, - 1, 0 );
        const baseY = ( typeof spawnPoint !== 'undefined' && spawnPoint ) ? spawnPoint.y : 0;
        let onTrackCount = 0;
        const filtered = [];
        for ( const w of raw ) {

            ray.set( new THREE.Vector3( w.x, baseY + 200, w.z ), down );
            ray.far = 500;
            let onTrack = false;
            let hitY = baseY + 0.1;
            if ( track ) {

                const hits = ray.intersectObject( track, true );
                for ( const h of hits ) {

                    const matName = h.object && h.object.material && h.object.material.name;
                    if ( ! roadMats || ( matName && roadMats.has( matName ) ) ) {

                        onTrack = true;
                        hitY = h.point.y;
                        break;

                    }

                }

            } else { onTrack = true; }
            if ( onTrack ) {

                onTrackCount ++;
                filtered.push( { x: w.x, z: w.z, v: w.v, y: hitY } );

            }

        }
        racingLine = filtered;
        console.log( `[ai] racing-line loaded: ${ raw.length } raw → ${ onTrackCount } on-track waypoints (dropped ${ raw.length - onTrackCount })` );

    } catch ( e ) { console.warn( '[ai] racing-line fetch failed', e ); }

}

function toggleAiMode() {

    if ( ai.enabled ) {

        ai.enabled = false;
        ai._loggedEngage = false;
        ai.stuckMs = 0;
        ai.recoverUntil = 0;
        ai.postRecoverUntil = 0;
        input.reverseEngaged = false;
        paintCarPurple( false );
        disposeAiLineMesh();
        _showAiBadge( false );
        showCarToast( 'AI off — you drive' );
        return;

    }

    if ( currentMapId === 'spa' ) {

        showCarToast( 'no AI on Spa — GLB road mesh is split' );
        return;

    }

    if ( ! racingLine || racingLine.length < 8 ) {

        showCarToast( 'no racing line for this map' );
        return;

    }

    // Snap closestIdx to the car's current XZ so the AI doesn't initially
    // try to drive backwards toward waypoint 0.
    if ( chassis ) {

        const t = chassis.translation();
        ai.closestIdx = _aiNearestIdx( t.x, t.z, 0, racingLine.length );

        // Direction handed off to aiUpdate, which dynamically re-evaluates
        // it each frame (the racing-line JSONs are too noisy with Hierholzer
        // U-turns to pick a single global direction reliably at engage time).
        ai.dir = 1;

    }

    ai.enabled = true;
    ai.stuckMs = 0;
    ai.recoverUntil = 0;
    // 3 s engage grace: the hatchback can take ~2 s to accelerate to 1 m/s
    // from a dead standstill, and stuck-detection would otherwise fire at
    // 1.5 s of "throttle on, vFwd < 1" and reverse the car right at spawn.
    ai.postRecoverUntil = performance.now() + 3000;
    paintCarPurple( true );
    buildAiLineMesh();
    _showAiBadge( true );
    showCarToast( 'AI drive engaged · press L to take back' );

}

function _aiNearestIdx( x, z, startIdx, scanCount ) {

    let bestIdx = startIdx, bestD = Infinity;
    const n = racingLine.length;
    for ( let i = 0; i < scanCount; i ++ ) {

        const k = ( startIdx + i ) % n;
        const p = racingLine[ k ];
        const dx = p.x - x, dz = p.z - z;
        const d = dx * dx + dz * dz;
        if ( d < bestD ) { bestD = d; bestIdx = k; }

    }
    return bestIdx;

}

const _aiFwd = new THREE.Vector3();
const _aiRight = new THREE.Vector3();
const _aiTmpQ = new THREE.Quaternion();

function aiUpdate( dt ) {

    if ( ! ai.enabled || ! racingLine || ! chassis ) return;

    // Bail out on any deliberate human input — driver wants control back.
    if ( _aiPickedHumanInput() ) { toggleAiMode(); return; }

    const now = performance.now();

    // ─── stuck recovery (active) ───────────────────────────────────
    // While the recovery timer is live, hold straight reverse. The auto
    // transmission shifts to gear -1 because input.reverseEngaged is set,
    // and input.brake doubles as reverse throttle in that mode (see
    // applyVehicleForces around the reverseEngaged check).
    if ( now < ai.recoverUntil ) {

        input.steerRaw = 0;
        input.steer = 0;
        input.throttle = 0;
        input.brake = 0.55;
        input.handbrake = 0;
        input.handbrakeAfterReset = false;
        input.reverseEngaged = true;
        return;

    }
    if ( ai.recoverUntil !== 0 ) {

        // Recovery just expired this frame: clear reverseEngaged so the
        // engine shifts back to forward on the first throttle application,
        // and arm a generous post-recovery grace window. The car may have
        // built up ~8 m/s of backward momentum during the 1.5 s reverse —
        // it takes ~1 s of forward braking to bleed that off, another
        // 1–2 s to actually start moving forward at >1 m/s. The grace
        // window must outlast that whole sequence or stuck-detection
        // re-fires and we loop reverse-and-stuck forever.
        ai.recoverUntil = 0;
        input.reverseEngaged = false;
        ai.postRecoverUntil = now + 4000;

    }

    const t = chassis.translation();
    const v = chassis.linvel();
    const speed = Math.hypot( v.x, v.z );

    const n = racingLine.length;

    // Car heading in world space — used for both target selection and the
    // pure-pursuit local-frame math.
    const q = chassis.rotation();
    _aiTmpQ.set( q.x, q.y, q.z, q.w );
    _aiFwd.set( 0, 0, - 1 ).applyQuaternion( _aiTmpQ );
    _aiRight.set( 1, 0, 0 ).applyQuaternion( _aiTmpQ );

    // Per-car / per-track AI tuning — see AI_CAR_PROFILES / AI_TRACK_PROFILES
    // near the top of this file. These shape every downstream decision
    // (lookahead distance, corner-speed cap, brake strength, trail-brake,
    // throttle ramp, slip threshold) so each car drives like its archetype on
    // each circuit instead of a one-size-fits-all pure-pursuit drone.
    const carP = _aiCarProfile();
    const trackP = _aiTrackProfile();
    const speedScale = carP.gripMu * trackP.gripMu * trackP.aggression;

    // Lookahead distance: faster cars and longer-sight tracks look further;
    // tight chicane tracks pull it in. Per-car lookaheadGain × per-track
    // lookaheadBias scales the speed-adaptive base.
    const laGain = carP.lookaheadGain * trackP.lookaheadBias;
    const lookAhead = THREE.MathUtils.clamp(
        ( 5 + speed * 0.55 ) * laGain,
        6, 48
    );

    // Pick lookahead target by scanning the WHOLE racing line and picking
    // the waypoint that is (a) in front of the car (lz > 0.5) and (b)
    // closest to the desired lookahead distance. This per-frame direction
    // picker is load-bearing: the racing-line JSONs contain Hierholzer Euler
    // back-and-forth so any single-step closestIdx+dir walk gets fooled.
    //
    // We also collect a *sequence* of forward waypoints (sorted by forward
    // distance) so the controller below can scan their curvature for early
    // brake demand and target the corner-entry, not just the steering point.
    // O(n) per frame, identical asymptotics to the old direction-only scan.
    const fwdX = _aiFwd.x, fwdZ = _aiFwd.z;
    const MAX_R = 320; // m — must outrange the brake-distance scan window
    // Brake-scan window: just enough to cover the physical braking distance
    // from current speed to a near-stop, plus a margin. At 80 m/s with
    // a≈10 m/s² we need ~320 m to stop; we cap at 260 m so the scan never
    // grabs corners we'll see in plenty of time on the NEXT pass.
    const scanRange = Math.min( 260, Math.max( 70, 50 + speed * 2.6 ) );
    let bestIdx = - 1, bestErr = Infinity;
    let closestForwardD = Infinity, closestForwardIdx = - 1;
    // Forward-sector waypoints, captured for the curvature scan further down.
    // Reused per-frame typed arrays would be marginally faster but the JSONs
    // are ~8 k waypoints and only a fraction fall in the forward sector, so
    // this stays well under the existing AI cost budget.
    const fwdIdx = [];
    const fwdDist = [];
    // Also capture each waypoint's neighbor-median v so the curvature scan
    // can detect-and-ignore Hierholzer U-turn artifacts (waypoints whose
    // baked v is anomalously low because the extractor doubled back on itself
    // at a junction). Without this guard, a 4 m/s artifact 80 m ahead on what
    // looks like a straight section will pin brakeDemand=1 forever and the
    // car just brakes-and-stops on every straight. See the scan loop below.
    for ( let i = 0; i < n; i ++ ) {

        const p = racingLine[ i ];
        const ddx = p.x - t.x, ddz = p.z - t.z;
        const d2 = ddx * ddx + ddz * ddz;
        if ( d2 > MAX_R * MAX_R ) continue;
        const lzI = ddx * fwdX + ddz * fwdZ;
        if ( lzI < 0.5 ) continue;
        const d = Math.sqrt( d2 );
        const err = Math.abs( d - lookAhead );
        // Lookahead target: closest waypoint to the desired lookahead distance,
        // with a 4 m floor so we never lock onto a waypoint right next to the
        // car (which produces enormous alpha and a single-frame steer spike).
        if ( d > 4 && err < bestErr ) { bestErr = err; bestIdx = i; }
        if ( d < closestForwardD ) { closestForwardD = d; closestForwardIdx = i; }
        if ( d < scanRange ) { fwdIdx.push( i ); fwdDist.push( d ); }

    }
    // If nothing's in front at lookAhead range, fall back to the closest
    // forward waypoint, however close. If even THAT fails, the AI can't
    // see the line — full brake until we get bumped back into range.
    let idx = bestIdx >= 0 ? bestIdx : closestForwardIdx;
    if ( idx < 0 ) {

        input.steer = 0;
        input.steerRaw = 0;
        input.throttle = 0;
        input.brake = 1.0;
        input.handbrake = 0;
        input.handbrakeAfterReset = false;
        return;

    }
    ai.closestIdx = idx;
    const target = racingLine[ idx ];
    if ( ! ai._loggedEngage ) {

        const tdx = target.x - t.x, tdz = target.z - t.z;
        const tlz = tdx * fwdX + tdz * fwdZ;
        console.log( `[ai] engage: bestIdx=${ idx }  target=(${ target.x.toFixed( 1 ) }, ${ target.z.toFixed( 1 ) })  lz=${ tlz.toFixed( 1 ) }  d=${ Math.hypot( tdx, tdz ).toFixed( 1 ) }  speed=${ speed.toFixed( 1 ) }  carMu=${ carP.gripMu }  trackMu=${ trackP.gripMu }` );
        ai._loggedEngage = true;

    }

    // ─── Forward curvature + brake-distance scan ─────────────────────
    // Walk forward waypoints (sorted by forward distance), compute the
    // required deceleration to reach each waypoint's v cap:
    //   a_req = (v² - v_t²) / (2·d)
    // Express as a 0..1 demand against available longitudinal brake grip,
    // and keep the SINGLE WORST demand across the scan. The 3-zone pedal
    // mapping (below) then turns that into a smooth brake/coast/throttle
    // gradient, so a corner at d=400 starts a light coast-dab and naturally
    // builds to full pedal as we close in — no on/off binary that brakes
    // the whole straight.
    //
    // Anomaly filter (critical): the Hierholzer Euler-circuit extractor
    // leaves waypoints with absurdly low v (down to 2-3 m/s) at junctions /
    // doubled-back sections. They sit ON tarmac so loadRacingLine's
    // on-track filter keeps them. If we don't ignore them here, every
    // straight has a "phantom hairpin" 50-100 m ahead and the AI brakes
    // continuously. We use a windowed-mean of the 6 neighbors on each
    // side and drop any waypoint whose v < 55% of that mean. This was the
    // single biggest cause of the "AI just brakes constantly" symptom.
    //
    // aAvail is shaped by the friction-circle: lateral grip currently in
    // use eats into longitudinal grip. Mid-corner we have LESS brake
    // authority — that's correct physics and stops the AI from spinning
    // under brake mid-corner (which the old controller did because it
    // assumed full grip on the brake axis always).
    const ord = fwdIdx.map( ( _, k ) => k ).sort( ( a, b ) => fwdDist[ a ] - fwdDist[ b ] );
    const SCAN_N = Math.min( 50, ord.length );

    // Effective speed cap for the picked target waypoint (per-car / per-track).
    // 0.95 headroom keeps us off the very edge so a bump or kerb doesn't push
    // us past the friction limit at apex.
    const apexHeadroom = 0.95;
    const targetVraw = target.v * speedScale;
    const targetV = targetVraw * apexHeadroom;

    // Friction-circle adjustment of brake authority. We don't have yaw rate
    // cheaply, so use |v_lat| / (speed × 0.35) as a 0..1 proxy for "how
    // much lateral grip is being spent right now." 0.35 is empirical: it
    // saturates to 1 when |v_lat| ≈ 0.35 × speed, which corresponds to a
    // big-slip (>20°) cornering state. Below speed=4 m/s we don't apply
    // the friction-circle scaling (low-speed dynamics aren't grip-limited).
    const _vLateralNow = Math.abs( v.x * _aiRight.x + v.z * _aiRight.z );
    const _latUseRatio = THREE.MathUtils.clamp(
        ( speed > 4 ? _vLateralNow / Math.max( 4, speed * 0.35 ) : 0 ),
        0, 0.95
    );
    // Brake-axis grip available right now: nominal longitudinal grip × brake
    // bias, scaled by friction-circle ellipse (sqrt(1 - latUse²)). Floor 0.20
    // so even a full-slip drift still leaves us SOME brake authority (the
    // AI shouldn't refuse to brake just because the rear stepped out).
    const aAvailLong = 9.81 * carP.brakeBias * trackP.gripMu *
        Math.sqrt( Math.max( 0.20, 1.0 - _latUseRatio * _latUseRatio ) );

    // Track the worst SINGLE upcoming corner (highest demand) AND the
    // weakest absolute cap anywhere ahead (so the throttle branch can
    // recognise "tight corner coming, don't floor it").
    let brakeDemand = 0;     // 0…1 normalised required-decel / brake grip
    let anyVtAhead = Infinity;
    for ( let s = 0; s < SCAN_N; s ++ ) {

        const wi = fwdIdx[ ord[ s ] ];
        const d = fwdDist[ ord[ s ] ];
        const w = racingLine[ wi ];

        // Anomaly filter: compute neighbor-mean v over a ±6 waypoint window.
        // If w.v is < 55% of that mean (AND the mean is high enough that we
        // wouldn't be filtering out a real hairpin), it's almost certainly a
        // Hierholzer doubled-back artifact, not a real corner — skip it.
        // Cheap and bounded: 12 reads per scanned waypoint. This was the
        // single biggest cause of "the AI just brakes for no reason and
        // stops on every straight" — the optimizer JSONs have v as low as
        // 2-3 m/s at junction artifacts that the on-track filter can't see.
        let medSum = 0, medCount = 0;
        for ( let k = - 6; k <= 6; k ++ ) {

            if ( k === 0 ) continue;
            const ni = ( ( wi + k ) % n + n ) % n;
            medSum += racingLine[ ni ].v;
            medCount ++;

        }
        const medV = medCount > 0 ? medSum / medCount : w.v;
        if ( w.v < medV * 0.55 && medV > 6 ) continue;

        // Effective cap, with optional small lift for late-brakers. Hard-capped
        // at vCap × 1.04 so even cornerEntryLift = 0.92 can't push us more
        // than ~4% over the optimizer's grip-limited speed. This protects
        // against the launch-off-track bug the first iteration of this AI
        // had — gripMu × cornerEntryLift stacking to 1.75× the JSON cap.
        const vCap = w.v * speedScale * apexHeadroom;
        const liftDiv = Math.max( 0.96, carP.cornerEntryLift );
        const vEff = Math.min( vCap / liftDiv, vCap * 1.04 );
        if ( vEff < anyVtAhead ) anyVtAhead = vEff;
        if ( vEff >= speed ) continue;     // we'd already be slow enough — skip

        const dEff = Math.max( 2, d );
        const aReq = ( speed * speed - vEff * vEff ) / ( 2 * dEff );
        const demand = aReq / aAvailLong;

        if ( demand > brakeDemand ) brakeDemand = demand;

    }
    // anyVtAhead may still be Infinity if every visible waypoint is above
    // current speed; collapse to a sensible value for the throttle branch.
    if ( ! isFinite( anyVtAhead ) ) anyVtAhead = targetVraw;

    // Express target in car-local frame:
    //   lz = signed forward distance, POSITIVE when target is in front
    //   lx = signed lateral offset, POSITIVE when target is to the LEFT
    // (left-positive matches the codebase's input.steer convention where
    //  +1 = left — see updateInput where A/← contribute +1 to kSteer.)
    const dx = target.x - t.x, dz = target.z - t.z;
    const lz = dx * _aiFwd.x + dz * _aiFwd.z;
    const lx = - ( dx * _aiRight.x + dz * _aiRight.z );

    // Pure-pursuit kinematic bicycle. atan2 keeps the angle correct in all
    // four quadrants — if the target ends up behind (lz < 0) we get |α| > π/2
    // and steering saturates, then the reverse-safety below brakes us so we
    // pivot toward the line rather than plowing forward off-road.
    const alpha = Math.atan2( lx, lz );
    const wheelbase = 2.6;
    const delta = Math.atan2( 2 * wheelbase * Math.sin( alpha ), Math.max( 6, lookAhead ) );
    let steer = THREE.MathUtils.clamp( delta / ( 35 * Math.PI / 180 ), - 1, 1 );
    const absSteer = Math.abs( steer );

    // Slip-aware throttle dampening: the perpendicular component of velocity
    // (lateral slip in m/s, NOT slip-angle, but it's a clean proxy without
    // having to dig into Rapier wheel state every frame) is how we tell that
    // the rear is stepping out. Above carP.slipLimit we cap throttle.
    const vLateral = Math.abs( v.x * _aiRight.x + v.z * _aiRight.z );
    let slipScale = 1.0;
    if ( vLateral > carP.slipLimit && speed > 6 ) {

        // Linear taper from 1.0 down to 0.5 as slip overshoots by ~3 m/s.
        slipScale = THREE.MathUtils.clamp(
            1.0 - ( vLateral - carP.slipLimit ) / 6.0,
            0.5, 1.0
        );

    }

    // ─── throttle / brake decision ───────────────────────────────────
    // Three zones, keyed to brakeDemand (= required-decel / available-decel):
    //   demand ≥ 0.70 : HARD BRAKE. Pedal = demand × 1.10 clamped to [0.35, 1.0].
    //                   Throttle off. We're committed.
    //   0.40 ≤ d < 0.70: SOFT BRAKE. Pedal = (d − 0.40) + 0.15, throttle off.
    //                   "Coast and dab" — we'd be reckless to keep throttling
    //                   but we don't need to stomp yet. Bleeds speed gently
    //                   into the brake zone proper.
    //   demand < 0.40 : DRIVE. Throttle ramped on (1 − absSteer), corner-aware.
    //
    // The proportional pedal-mapping replaces the previous binary "100% brake
    // above 1.0, scaled brake between 0.55..1, full throttle otherwise" — that
    // had an EMERGENCY-BRAKE multiplicative seatbelt on top, which is what
    // made the AI brake the whole straight ("speed > worstVt × 1.5" stays
    // true for most of the deceleration and pegged demand=1 forever).
    let throttle = 0, brake = 0;
    if ( brakeDemand >= 0.70 ) {

        // HARD brake: pedal tracks demand with a small +10% bias so we always
        // brake a hair harder than the bare minimum (eats actuation lag, ABS
        // overshoot, kerb bumps). Floor 0.35 so the very edge of the hard
        // zone still feels like a real brake application.
        brake = THREE.MathUtils.clamp( brakeDemand * 1.10, 0.35, 1.0 );
        throttle = 0;

    } else if ( brakeDemand >= 0.40 ) {

        // SOFT brake / coast zone. 15-45% pedal. Throttle off. This is the
        // "coast into the corner" the previous controller missed — without
        // it, the AI was either flooring it or stomping the brake, never in
        // between, and it was always too late to soft-brake.
        brake = THREE.MathUtils.clamp( ( brakeDemand - 0.40 ) * 1.0 + 0.15, 0.15, 0.50 );
        throttle = 0;

    } else {

        // DRIVE: open the taps. exitOpen ramps with (1 − absSteer); throttleRamp
        // shapes how aggressive the curve is (god / F1 / rally stamp earlier,
        // muscle / hatch progressive). Baseline 0.25 keeps the car off coast.
        const exitOpen = Math.max( 0, 1.0 - absSteer * 1.15 );
        const ramp = Math.pow( exitOpen, 1.6 - carP.throttleRamp );
        const base = 0.25;
        throttle = THREE.MathUtils.clamp( base + ( 1.0 - base ) * ramp * carP.throttleRamp, 0, 1 );

        // Floor it when straight AND well under both the picked target cap
        // AND the weakest visible cap — i.e. we're truly on a straight, not
        // closing in on a hidden hairpin. The anyVtAhead guard is what makes
        // this safe (the old controller checked only against `targetV` which
        // is the LOOKAHEAD point, not the slowest corner ahead).
        if ( absSteer < 0.15 && speed < targetV - 4 && speed < anyVtAhead - 2 ) {

            throttle = 1.0;

        }

        // Soft brake if we're nudging over the picked apex cap (small overshoot
        // catch — different from brakeDemand which is about reaching the future
        // cap, this is "you're already over the local cap right now").
        if ( speed > targetV + 1.5 ) {

            brake = THREE.MathUtils.clamp( ( speed - targetV - 1.5 ) * 0.07, 0.05, 0.4 );
            throttle *= 0.4;

        }

    }

    // ─── Trail-braking ───────────────────────────────────────────────
    // Apply a tapered brake during turn-in: peak at high steering + medium
    // speed, decay to zero as we straighten or slow. Per-car trailBrakeStrength
    // means hot hatch barely trails (~0.05) while F1 / supercar trail more
    // aggressively (~0.20). Only applies when we're not already throttle-on
    // out of the apex AND when we're NOT already braking hard from the
    // primary branch (don't stack ~30% brake on top of 100% — that's just
    // 100%, fine — but stacking trail-brake on top of a 60% primary brake
    // pushes us over the friction-circle limit mid-corner and spins us).
    if ( speed > 12 && absSteer > 0.18 && absSteer < 0.85 &&
         throttle < 0.6 && brake < 0.35 ) {

        const turnIn = Math.min( 1, ( absSteer - 0.18 ) / 0.45 );
        const speedFade = Math.min( 1, ( speed - 12 ) / 25 );
        const trail = carP.trailBrakeStrength * turnIn * speedFade;
        brake = Math.max( brake, trail );

    }

    // Apply the slip-aware throttle cap last so trail-brake and corner-exit
    // ramp both fold into it.
    throttle *= slipScale;

    // Reverse safety: dot of velocity onto forward — positive when going
    // forward, negative when going backward. Full brake if we've actually
    // started rolling backward. (Stuck-recovery block below owns the full
    // recovery; this just stops us digging in deeper while we wait for it.)
    //
    // Suppressed during the post-recovery grace window: just exited a
    // 1.2 s deliberate reverse, so backward velocity is EXPECTED for the
    // next second or so. If we slammed full brake here we'd never coast
    // back to neutral and the engage-throttle below would never get to
    // push us forward.
    const vFwd = v.x * _aiFwd.x + v.z * _aiFwd.z;
    const _inGrace = ai.postRecoverUntil && now < ai.postRecoverUntil;
    if ( vFwd < - 2 && ! _inGrace ) { throttle = 0; brake = 1.0; }

    // ─── stuck detection ────────────────────────────────────────────
    // If forward velocity stays near zero while we want to ACCELERATE, the
    // car is wedged — usually nose-first into a wall or grass perpendicular
    // to the racing line. After ~1.5 s of crawl, arm a fixed 2.5 s reverse
    // to back out; the per-frame direction picker then re-acquires the line
    // facing whichever way the car ends up.
    //
    // Two guards on top of "only count throttle, not brake":
    //   - postRecoverUntil: skip the entire counter for 1.5 s after a
    //     recovery so the car has time to pick up forward speed before we
    //     decide it's stuck again. Otherwise the loop reverse → stop → check
    //     → still slow → reverse fires endlessly.
    //   - require speed < 1.0 m/s AND throttle > 0.2, not just "applied".
    //     Anything moving above 1 m/s isn't actually wedged.
    const inPostRecoverGrace = ai.postRecoverUntil && now < ai.postRecoverUntil;
    if ( ! inPostRecoverGrace && Math.abs( vFwd ) < 1.0 && throttle > 0.2 && brake < 0.2 ) {

        ai.stuckMs += dt * 1000;

    } else {

        ai.stuckMs = 0;

    }
    if ( ai.stuckMs > 1500 ) {

        // 1.2 s of reverse at 0.55 brake builds ~6 m/s of backward speed,
        // enough to clear most wedge-against-wall cases without taking a
        // long time to bleed back off. Was 2.5 s × 0.7 brake — that built
        // ~12 m/s of backward speed and the bleed-off ate the entire
        // post-recovery grace window, looping reverse-and-stuck forever.
        ai.recoverUntil = now + 1200;
        ai.stuckMs = 0;
        console.log( '[ai] stuck → reversing 1.2s' );
        input.steerRaw = 0;
        input.steer = 0;
        input.throttle = 0;
        input.brake = 0.55;
        input.handbrake = 0;
        input.handbrakeAfterReset = false;
        input.reverseEngaged = true;
        return;

    }

    input.steerRaw = steer;
    input.steer = steer;
    input.throttle = throttle;
    input.brake = brake;
    input.handbrake = 0;
    input.handbrakeAfterReset = false;

}

// ─── purple body-paint swap ───
function paintCarPurple( on ) {

    if ( ! carVisualsGroup ) return;
    if ( on ) {

        ai.paintedMats.clear();
        carVisualsGroup.traverse( ( o ) => {

            const m = o.material;
            if ( ! m || ! m.color ) return;
            // Skip lights and pure-black trim (windows, tyres).
            const c = m.color.getHex();
            if ( c === 0x000000 || c === 0xFF0000 || c === 0xFFFFFF ) return;
            ai.paintedMats.set( m, c );
            m.color.setHex( ai.paintColor );

        } );

    } else {

        for ( const [ m, c ] of ai.paintedMats ) m.color.setHex( c );
        ai.paintedMats.clear();

    }

}

// ─── Forza-style chevron overlay ───
// One flat triangle arrow per Nth waypoint, instanced (single draw call),
// rotated to point along the racing line, raycast-projected onto the track
// so they hug elevation changes. Reads like Forza's racing-line aid /
// F1's AR turn-by-turn arrows.
function buildAiLineMesh() {

    if ( ! racingLine || ai.lineMesh ) return;

    // Pre-pass: walk waypoints in ai.dir direction and accept one chevron
    // every ≥ MIN_SPACING m, skipping any candidate that's < MIN_DEDUPE m
    // from an already-placed chevron (kills Hierholzer back-and-forth stacks
    // that would otherwise render as overlapping fans of triangles).
    const MIN_SPACING = 14;
    const MIN_DEDUPE = 5;
    const n = racingLine.length;
    const accepted = [];
    let cursor = ai.closestIdx || 0;
    let acc = 0;
    let last = racingLine[ cursor ];
    accepted.push( cursor );
    for ( let i = 1; i < n; i ++ ) {

        const idx = ( cursor + i * ai.dir + n * 2 ) % n;
        const p = racingLine[ idx ];
        const dl = Math.hypot( p.x - last.x, p.z - last.z );
        acc += dl;
        last = p;
        if ( acc < MIN_SPACING ) continue;
        // Dedupe against ALL previously-placed chevrons (kills wrap-around
        // crossings and self-intersections).
        let tooClose = false;
        for ( const ai_idx of accepted ) {

            const ap = racingLine[ ai_idx ];
            if ( Math.hypot( ap.x - p.x, ap.z - p.z ) < MIN_DEDUPE ) { tooClose = true; break; }

        }
        if ( tooClose ) continue;
        accepted.push( idx );
        acc = 0;

    }
    const count = accepted.length;

    // Smaller arrow: 0.7 m long × 0.9 m wide. Reads as a clear chevron from
    // chase-cam without the huge "ramp" look the previous 1.4 m version had.
    const arrow = new THREE.BufferGeometry();
    arrow.setAttribute( 'position', new THREE.BufferAttribute( new Float32Array( [
        0.0,  0.05, - 0.7,
        - 0.45, 0.05,   0.2,
        0.45, 0.05,   0.2
    ] ), 3 ) );
    arrow.setIndex( [ 0, 1, 2 ] );
    arrow.computeVertexNormals();

    // Per-instance color: white base, real color comes from instanceColor.
    const mat = new THREE.MeshBasicMaterial( {
        color: 0xFFFFFF,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false
    } );

    const inst = new THREE.InstancedMesh( arrow, mat, count );
    inst.frustumCulled = false;   // bbox of the whole loop is the track itself
    inst.renderOrder = 999;
    // Allocate per-instance color buffer so chevrons can show braking state.
    inst.instanceColor = new THREE.InstancedBufferAttribute( new Float32Array( count * 3 ), 3 );

    // Speed-delta color ramp (F1 22 / Forza / ACC convention):
    //   red    = braking zone   (speed dropping ahead on the line)
    //   yellow = coast / steady (speed roughly constant)
    //   green  = throttle-on    (speed rising ahead on the line)
    // `racingLine[*].v` is in m/s (same unit the AI controller compares
    // against `speed` in m/s below). Calibrated against the four bundled
    // racing-line JSONs — the 5th/95th percentile of dv/ds across
    // Nürburgring, Spa, Suzuka, and Nürburgring GP all sit in ±0.3 to ±0.7
    // (m/s)/m, so ±0.4 puts true braking/throttle events at the saturated
    // ends of the ramp while light coast stays yellow.
    const BRAKE_SLOPE = - 0.4;   // (m/s) per m → bright red at or below
    const ACCEL_SLOPE =   0.4;   // (m/s) per m → bright green at or above
    const _colRed    = new THREE.Color( 0xFF2030 );
    const _colYellow = new THREE.Color( 0xFFD000 );
    const _colGreen  = new THREE.Color( 0x22DD44 );
    const _colTmp    = new THREE.Color();
    function _chevronColor( dvds, out ) {

        if ( dvds <= BRAKE_SLOPE ) { out.copy( _colRed ); return; }
        if ( dvds >= ACCEL_SLOPE ) { out.copy( _colGreen ); return; }
        if ( dvds < 0 ) {

            // Brake → yellow band: t=0 at BRAKE_SLOPE (red), t=1 at 0 (yellow).
            const t = 1 - ( dvds / BRAKE_SLOPE );
            out.copy( _colRed ).lerp( _colYellow, t );

        } else {

            // Yellow → green band: t=0 at 0 (yellow), t=1 at ACCEL_SLOPE (green).
            const t = dvds / ACCEL_SLOPE;
            out.copy( _colYellow ).lerp( _colGreen, t );

        }

    }

    // Pre-compute dv/ds per accepted chevron using a ~k-step lookahead along
    // the accepted strip itself (matches what the driver actually sees ahead).
    const LOOKAHEAD = 3;
    const _dvds = new Float32Array( count );
    for ( let ai_i = 0; ai_i < count; ai_i ++ ) {

        const w0 = racingLine[ accepted[ ai_i ] ];
        let s = 0;
        let last2 = w0;
        for ( let k = 1; k <= LOOKAHEAD; k ++ ) {

            const wk = racingLine[ accepted[ ( ai_i + k ) % count ] ];
            s += Math.hypot( wk.x - last2.x, wk.z - last2.z );
            last2 = wk;

        }
        const wN = racingLine[ accepted[ ( ai_i + LOOKAHEAD ) % count ] ];
        _dvds[ ai_i ] = s > 0.01 ? ( wN.v - w0.v ) / s : 0;

    }

    const ray = new THREE.Raycaster();
    const down = new THREE.Vector3( 0, - 1, 0 );
    const baseY = ( typeof spawnPoint !== 'undefined' && spawnPoint ) ? spawnPoint.y : 0;
    const tmpM = new THREE.Matrix4();
    const tmpQ = new THREE.Quaternion();
    const tmpP = new THREE.Vector3();
    const tmpS = new THREE.Vector3( 1, 1, 1 );
    const yAxis = new THREE.Vector3( 0, 1, 0 );

    for ( let ai_i = 0; ai_i < accepted.length; ai_i ++ ) {

        const idx = accepted[ ai_i ];
        const w = racingLine[ idx ];
        // Tangent from the NEXT accepted chevron so each arrow points at its
        // successor (matches what the AI controller actually targets next).
        const nextIdx = accepted[ ( ai_i + 1 ) % accepted.length ];
        const next = racingLine[ nextIdx ];
        const dx = next.x - w.x, dz = next.z - w.z;
        // Arrow geometry's "forward" is -Z (Three.js convention). Yaw to
        // align local -Z with world (dx, dz): yaw = atan2(-dx, -dz).
        const yaw = Math.atan2( - dx, - dz );

        // Snap Y to the actual track surface so the arrow follows
        // Nordschleife's elevation changes.
        ray.set( new THREE.Vector3( w.x, baseY + 200, w.z ), down );
        ray.far = 500;
        let y = baseY + 0.1;
        if ( track ) {

            const hits = ray.intersectObject( track, true );
            if ( hits.length ) y = hits[ 0 ].point.y + 0.1;

        }

        tmpP.set( w.x, y, w.z );
        tmpQ.setFromAxisAngle( yAxis, yaw );
        tmpM.compose( tmpP, tmpQ, tmpS );
        inst.setMatrixAt( ai_i, tmpM );

        _chevronColor( _dvds[ ai_i ], _colTmp );
        inst.setColorAt( ai_i, _colTmp );

    }
    inst.instanceMatrix.needsUpdate = true;
    if ( inst.instanceColor ) inst.instanceColor.needsUpdate = true;
    scene.add( inst );
    ai.lineMesh = inst;

}

function disposeAiLineMesh() {

    if ( ! ai.lineMesh ) return;
    scene.remove( ai.lineMesh );
    ai.lineMesh.geometry.dispose();
    ai.lineMesh.material.dispose();
    ai.lineMesh = null;

}

function _showAiBadge( on ) {

    if ( ! ai.badgeEl ) {

        const el = document.createElement( 'div' );
        el.id = 'ai-badge';
        el.textContent = 'AI DRIVE';
        el.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);background:rgba(153,51,255,0.18);color:#D6B3FF;font:600 13px Monospace;letter-spacing:2px;padding:6px 14px;border:1px solid rgba(153,51,255,0.55);border-radius:4px;z-index:9999;display:none;pointer-events:none';
        document.body.appendChild( el );
        ai.badgeEl = el;

    }
    ai.badgeEl.style.display = on ? 'block' : 'none';

}
