// Extract an optimised racing line per map.
//
// Pipeline:
//   1. Walk GLB, baking world transforms, keep triangles whose material name is
//      in MAPS[id].racingLineMaterials (≈ roadMaterials minus pit lane).
//   2. Rasterise triangles into a binary mask (1 = road) at CELL_SIZE m / cell.
//   3. Felzenszwalb–Huttenlocher 2-pass distance transform → distance-to-edge
//      for each road cell.
//   4. Build "core" mask = cells whose DT ≥ coreFrac × maxDT. This carves the
//      road down to its inner spine, killing pit-lane stubs, T-junctions, and
//      paddock fragments that are thinner than the main racing surface.
//   5. Connected components on the core mask. Pick the component that contains
//      (or is closest to) spawnPos.
//   6. Geodesic BFS from spawn cell through the spawn component → distance
//      field d1. The cell with max d1 is the "antipode" (≈ halfway around the
//      loop, geodesically).
//   7. Geodesic BFS from antipode → distance field d2. Cells satisfying
//      d1[c] + d2[c] ≈ d1[antipode] lie on a geodesic from spawn → antipode.
//      For a closed loop, BOTH half-arcs satisfy this (equal length), so this
//      set is a thin annular ring tracing the entire lap.
//   8. Thin that ring with Zhang–Suen → 1-cell-wide closed loop. Walk it as
//      an Euler circuit starting at the spawn cell.
//   9. Resample to uniform arclength (RESAMPLE_M m spacing).
//  10. Per sample, cast perpendiculars left/right against the full mask to find
//      the half-width-to-edge on each side.
//  11. Iterative minimum-curvature optimisation: smooth (Gaussian) then clip
//      the lateral offset to [-w_left + MARGIN, +w_right - MARGIN].
//  12. Forward + backward sweep computes per-sample max speed:
//      v_max(κ) = sqrt(μ·g/κ), then accel-bound on the way up + brake-bound
//      backwards through corners.
//  13. Write public/racing-lines/<id>.json with [{ x, z, v }, …] in loop order.
//
// Run: node scripts/extract-racing-line.mjs [mapId]

import { NodeIO } from '@gltf-transform/core';
import { writeFileSync, mkdirSync } from 'node:fs';

// ─── per-map config ───
// Forward direction (world-space) implied by a spawn quaternion: rotate
// (0, 0, -1) and project to XZ.
function spawnForwardFromQuat( q ) {

    const m13 = 2 * ( q.x * q.z + q.y * q.w );
    const m33 = 1 - 2 * ( q.x * q.x + q.y * q.y );
    const fx = - m13, fz = - m33;
    const l = Math.hypot( fx, fz ) || 1;
    return { x: fx / l, z: fz / l };

}

const MAPS = {
    nurburgring: {
        path: 'public/textures/models/nurburgring.glb',
        scale: 1,
        racingLineMaterials: new Set( [ 'Material' ] ),
        cellSize: 2.0,
        sampleM: 8.0,
        spawnPos: { x: 3147.90, z: - 2733.54 },
        spawnQuat: { x: - 0.0046, y: - 0.5791, z: 0.0216, w: 0.8150 },
        // Morphological close radius (metres) — bridges small triangle gaps
        // in the road mesh so the lap stays one connected piece.
        closeM: 4.0,
        // Loop must reach this far from spawn (m) before we accept closure.
        minLoopRadiusM: 3000
    },
    nurburgring_gp: {
        path: 'public/textures/models/nurburgring_gp.glb',
        scale: 2,
        racingLineMaterials: new Set( [ 'Esdanurburgring2022681Mtl' ] ),
        cellSize: 2.0,
        sampleM: 6.0,
        spawnPos: { x: 26.17, z: 1219.19 },
        spawnQuat: { x: 0.0037, y: - 0.0175, z: 0.0121, w: - 0.9998 },
        closeM: 4.0,
        minLoopRadiusM: 600
    },
    spa: {
        path: 'public/textures/models/spa.glb',
        scale: 1,
        // road1x is the only material the user confirmed under the car.
        racingLineMaterials: new Set( [ 'Meshesroadroad1x0171Mtl' ] ),
        cellSize: 3.0,
        sampleM: 10.0,
        spawnPos: { x: - 2881.70, z: 2612.47 },
        spawnQuat: { x: 0.0188, y: - 0.1562, z: - 0.0036, w: - 0.9875 },
        // Spa has large mesh gaps; close hard (~12 m).
        closeM: 12.0,
        minLoopRadiusM: 1500
    },
    suzuka: {
        path: 'public/textures/models/suzuka.glb',
        scale: 1,
        racingLineMaterials: new Set( [
            'ROAD01', 'ROAD02', 'ROAD03', 'ROAD04', 'ROAD05', 'ROAD06', 'ROAD07',
            'ROADD', 'ROADX'
        ] ),
        cellSize: 1.5,
        sampleM: 6.0,
        spawnPos: { x: 505.02, z: 504.37 },
        spawnQuat: { x: 0.0026, y: - 0.9995, z: - 0.0158, w: 0.0257 },
        closeM: 3.0,
        minLoopRadiusM: 800
    }
};

// Resolve spawnForward at startup so every map config has both .pos and .fwd.
for ( const cfg of Object.values( MAPS ) ) cfg.spawnForward = spawnForwardFromQuat( cfg.spawnQuat );

const MU = 1.05;                  // tyre grip coefficient (slightly > 1 for sticky tarmac)
const G = 9.81;
const A_MAX = 9.0;                // m/s² accel cap
const B_MAX = 16.0;               // m/s² brake cap
const V_CAP = 95;                 // m/s ≈ 340 km/h hard cap (god car territory)
const EDGE_MARGIN_M = 1.5;        // keep AI this far from track edge
const OPT_ITERS = 400;            // smooth/clip iterations
const OPT_SMOOTH_K = 0.35;        // smoothing factor per iter

// ─── mat4 (column-major) helpers ───
function mat4FromTRS( t, r, s ) {

    const [ qx, qy, qz, qw ] = r;
    const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
    const xx = qx * x2, xy = qx * y2, xz = qx * z2;
    const yy = qy * y2, yz = qy * z2, zz = qz * z2;
    const wx = qw * x2, wy = qw * y2, wz = qw * z2;
    const m = new Float64Array( 16 );
    m[ 0 ] = ( 1 - ( yy + zz ) ) * s[ 0 ];
    m[ 1 ] = ( xy + wz ) * s[ 0 ];
    m[ 2 ] = ( xz - wy ) * s[ 0 ];
    m[ 3 ] = 0;
    m[ 4 ] = ( xy - wz ) * s[ 1 ];
    m[ 5 ] = ( 1 - ( xx + zz ) ) * s[ 1 ];
    m[ 6 ] = ( yz + wx ) * s[ 1 ];
    m[ 7 ] = 0;
    m[ 8 ] = ( xz + wy ) * s[ 2 ];
    m[ 9 ] = ( yz - wx ) * s[ 2 ];
    m[ 10 ] = ( 1 - ( xx + yy ) ) * s[ 2 ];
    m[ 11 ] = 0;
    m[ 12 ] = t[ 0 ];
    m[ 13 ] = t[ 1 ];
    m[ 14 ] = t[ 2 ];
    m[ 15 ] = 1;
    return m;

}

function mat4Mul( a, b ) {

    const o = new Float64Array( 16 );
    for ( let r = 0; r < 4; r ++ ) for ( let c = 0; c < 4; c ++ ) {

        let s = 0;
        for ( let k = 0; k < 4; k ++ ) s += a[ k * 4 + r ] * b[ c * 4 + k ];
        o[ c * 4 + r ] = s;

    }
    return o;

}

function nodeLocal( n ) {

    const m = n.getMatrix();
    if ( m ) {

        const o = new Float64Array( 16 );
        for ( let i = 0; i < 16; i ++ ) o[ i ] = m[ i ];
        return o;

    }
    return mat4FromTRS( n.getTranslation(), n.getRotation(), n.getScale() );

}

function transformXZ( m, x, y, z ) {

    const w = m[ 3 ] * x + m[ 7 ] * y + m[ 11 ] * z + m[ 15 ];
    const wx = ( m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ] ) / w;
    const wz = ( m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ] ) / w;
    return [ wx, wz ];

}

// ─── 1. collect road triangles in world XZ ───
async function collectTris( cfg ) {

    const io = new NodeIO();
    const doc = await io.read( cfg.path );
    const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[ 0 ];
    const s = cfg.scale || 1;
    const rootMat = mat4FromTRS( [ 0, 0, 0 ], [ 0, 0, 0, 1 ], [ s, s, s ] );
    const tris = [];

    function visit( node, parentMat ) {

        const wm = mat4Mul( parentMat, nodeLocal( node ) );
        const mesh = node.getMesh();
        if ( mesh ) {

            for ( const prim of mesh.listPrimitives() ) {

                const mat = prim.getMaterial();
                const name = mat ? ( mat.getName() || '' ) : '';
                if ( ! cfg.racingLineMaterials.has( name ) ) continue;

                const pos = prim.getAttribute( 'POSITION' );
                if ( ! pos ) continue;
                const a = pos.getArray();
                const vCount = ( a.length / 3 ) | 0;
                const wxz = new Float64Array( vCount * 2 );
                for ( let i = 0; i < vCount; i ++ ) {

                    const p = transformXZ( wm, a[ i * 3 ], a[ i * 3 + 1 ], a[ i * 3 + 2 ] );
                    wxz[ i * 2 ] = p[ 0 ];
                    wxz[ i * 2 + 1 ] = p[ 1 ];

                }
                const idxA = prim.getIndices();
                const idx = idxA ? idxA.getArray() : null;
                const tc = idx ? ( idx.length / 3 ) | 0 : ( vCount / 3 ) | 0;
                for ( let i = 0; i < tc; i ++ ) {

                    const i0 = idx ? idx[ i * 3 ] : i * 3;
                    const i1 = idx ? idx[ i * 3 + 1 ] : i * 3 + 1;
                    const i2 = idx ? idx[ i * 3 + 2 ] : i * 3 + 2;
                    tris.push(
                        wxz[ i0 * 2 ], wxz[ i0 * 2 + 1 ],
                        wxz[ i1 * 2 ], wxz[ i1 * 2 + 1 ],
                        wxz[ i2 * 2 ], wxz[ i2 * 2 + 1 ]
                    );

                }

            }

        }
        for ( const c of node.listChildren() ) visit( c, wm );

    }
    for ( const n of scene.listChildren() ) visit( n, rootMat );
    return tris;

}

// ─── 2. rasterise triangles into Uint8Array mask ───
function rasterise( tris, cellSize ) {

    let xMin = Infinity, xMax = - Infinity, zMin = Infinity, zMax = - Infinity;
    for ( let i = 0; i < tris.length; i += 2 ) {

        if ( tris[ i ] < xMin ) xMin = tris[ i ];
        if ( tris[ i ] > xMax ) xMax = tris[ i ];
        if ( tris[ i + 1 ] < zMin ) zMin = tris[ i + 1 ];
        if ( tris[ i + 1 ] > zMax ) zMax = tris[ i + 1 ];

    }
    // 4-cell border so distance transform / skeleton can't escape.
    const BORDER = 4;
    const w = Math.ceil( ( xMax - xMin ) / cellSize ) + BORDER * 2;
    const h = Math.ceil( ( zMax - zMin ) / cellSize ) + BORDER * 2;
    const offX = - xMin / cellSize + BORDER;
    const offZ = - zMin / cellSize + BORDER;
    const mask = new Uint8Array( w * h );

    for ( let t = 0; t < tris.length; t += 6 ) {

        const x1 = tris[ t ] / cellSize + offX, y1 = tris[ t + 1 ] / cellSize + offZ;
        const x2 = tris[ t + 2 ] / cellSize + offX, y2 = tris[ t + 3 ] / cellSize + offZ;
        const x3 = tris[ t + 4 ] / cellSize + offX, y3 = tris[ t + 5 ] / cellSize + offZ;
        const xi0 = Math.max( 0, Math.floor( Math.min( x1, x2, x3 ) ) );
        const xi1 = Math.min( w - 1, Math.ceil( Math.max( x1, x2, x3 ) ) );
        const yi0 = Math.max( 0, Math.floor( Math.min( y1, y2, y3 ) ) );
        const yi1 = Math.min( h - 1, Math.ceil( Math.max( y1, y2, y3 ) ) );
        const den = ( y2 - y3 ) * ( x1 - x3 ) + ( x3 - x2 ) * ( y1 - y3 );
        if ( Math.abs( den ) < 1e-9 ) continue;
        const invDen = 1 / den;
        for ( let py = yi0; py <= yi1; py ++ ) {

            const cy = py + 0.5;
            for ( let px = xi0; px <= xi1; px ++ ) {

                const cx = px + 0.5;
                const wa = ( ( y2 - y3 ) * ( cx - x3 ) + ( x3 - x2 ) * ( cy - y3 ) ) * invDen;
                const wb = ( ( y3 - y1 ) * ( cx - x3 ) + ( x1 - x3 ) * ( cy - y3 ) ) * invDen;
                if ( wa >= 0 && wb >= 0 && wa + wb <= 1 ) mask[ py * w + px ] = 1;

            }

        }

    }
    return { mask, w, h, offX, offZ };

}

// ─── 3. Felzenszwalb–Huttenlocher distance transform (squared) ───
function dt1D( f, n ) {

    const d = new Float64Array( n );
    const v = new Int32Array( n );
    const z = new Float64Array( n + 1 );
    let k = 0;
    v[ 0 ] = 0;
    z[ 0 ] = - Infinity;
    z[ 1 ] = + Infinity;
    for ( let q = 1; q < n; q ++ ) {

        let s = ( ( f[ q ] + q * q ) - ( f[ v[ k ] ] + v[ k ] * v[ k ] ) ) / ( 2 * q - 2 * v[ k ] );
        while ( s <= z[ k ] ) {

            k --;
            s = ( ( f[ q ] + q * q ) - ( f[ v[ k ] ] + v[ k ] * v[ k ] ) ) / ( 2 * q - 2 * v[ k ] );

        }
        k ++;
        v[ k ] = q;
        z[ k ] = s;
        z[ k + 1 ] = + Infinity;

    }
    k = 0;
    for ( let q = 0; q < n; q ++ ) {

        while ( z[ k + 1 ] < q ) k ++;
        d[ q ] = ( q - v[ k ] ) * ( q - v[ k ] ) + f[ v[ k ] ];

    }
    return d;

}

function distanceTransform( mask, w, h ) {

    // We want, for each ROAD cell, the distance to the nearest non-road cell
    // (= distance-to-edge). Seed: 0 on edge (non-road), +∞ inside.
    const INF = 1e12;
    const f = new Float64Array( w * h );
    for ( let i = 0; i < f.length; i ++ ) f[ i ] = mask[ i ] ? INF : 0;
    // Pass along x.
    const col = new Float64Array( h );
    const tmp = new Float64Array( w * h );
    for ( let y = 0; y < h; y ++ ) {

        const row = new Float64Array( w );
        for ( let x = 0; x < w; x ++ ) row[ x ] = f[ y * w + x ];
        const out = dt1D( row, w );
        for ( let x = 0; x < w; x ++ ) tmp[ y * w + x ] = out[ x ];

    }
    // Pass along y.
    const dist = new Float64Array( w * h );
    for ( let x = 0; x < w; x ++ ) {

        for ( let y = 0; y < h; y ++ ) col[ y ] = tmp[ y * w + x ];
        const out = dt1D( col, h );
        // But we only care about *inside* cells — outside cells stay 0 so
        // the skeleton step doesn't have to second-guess them.
        for ( let y = 0; y < h; y ++ ) {

            const v = out[ y ];
            dist[ y * w + x ] = mask[ y * w + x ] ? Math.sqrt( v ) : 0;

        }

    }
    return dist;

}

// ─── 4. Zhang–Suen thinning ───
function thin( maskIn, w, h ) {

    const m = new Uint8Array( maskIn );
    let changed = true;
    const toRemove = [];

    function nb( x, y ) {

        return [
            m[ ( y - 1 ) * w + x ],
            m[ ( y - 1 ) * w + ( x + 1 ) ],
            m[ y * w + ( x + 1 ) ],
            m[ ( y + 1 ) * w + ( x + 1 ) ],
            m[ ( y + 1 ) * w + x ],
            m[ ( y + 1 ) * w + ( x - 1 ) ],
            m[ y * w + ( x - 1 ) ],
            m[ ( y - 1 ) * w + ( x - 1 ) ]
        ];

    }

    function transitions( P ) {

        let n = 0;
        for ( let i = 0; i < 8; i ++ ) if ( P[ i ] === 0 && P[ ( i + 1 ) % 8 ] === 1 ) n ++;
        return n;

    }

    while ( changed ) {

        changed = false;
        toRemove.length = 0;
        for ( let y = 1; y < h - 1; y ++ ) for ( let x = 1; x < w - 1; x ++ ) {

            if ( ! m[ y * w + x ] ) continue;
            const P = nb( x, y );
            const B = P.reduce( ( a, v ) => a + v, 0 );
            if ( B < 2 || B > 6 ) continue;
            if ( transitions( P ) !== 1 ) continue;
            if ( P[ 0 ] && P[ 2 ] && P[ 4 ] ) continue;
            if ( P[ 2 ] && P[ 4 ] && P[ 6 ] ) continue;
            toRemove.push( y * w + x );

        }
        if ( toRemove.length ) { for ( const idx of toRemove ) m[ idx ] = 0; changed = true; }
        toRemove.length = 0;
        for ( let y = 1; y < h - 1; y ++ ) for ( let x = 1; x < w - 1; x ++ ) {

            if ( ! m[ y * w + x ] ) continue;
            const P = nb( x, y );
            const B = P.reduce( ( a, v ) => a + v, 0 );
            if ( B < 2 || B > 6 ) continue;
            if ( transitions( P ) !== 1 ) continue;
            if ( P[ 0 ] && P[ 2 ] && P[ 6 ] ) continue;
            if ( P[ 0 ] && P[ 4 ] && P[ 6 ] ) continue;
            toRemove.push( y * w + x );

        }
        if ( toRemove.length ) { for ( const idx of toRemove ) m[ idx ] = 0; changed = true; }

    }
    return m;

}

// ─── 5. geodesic BFS through a binary mask ───
//
// 8-connected wavefront from `start` cell. Step cost ≈ 10 for orthogonal
// neighbours, 14 for diagonal (scaled int distance to keep `dist` as Int32).
// `mask` may be any Uint8Array (road, core, ring, …). Returns:
//   dist:   Int32Array of size w*h, -1 where unreachable.
//   parent: Int32Array of size w*h, -1 for start and unreachable cells.
//   maxIdx: the cell with the largest dist (-1 if start unreachable).
function geodesicBFS( mask, w, h, startIdx ) {

    const N = w * h;
    const dist = new Int32Array( N ).fill( - 1 );
    const parent = new Int32Array( N ).fill( - 1 );
    if ( ! mask[ startIdx ] ) return { dist, parent, maxIdx: - 1 };
    dist[ startIdx ] = 0;

    // Bucket-queue Dijkstra: distances are bounded; bucket size = 14 ensures
    // we always pop the next-smallest. Cheaper than a binary heap for this
    // small-integer-cost case.
    const BUCKETS = 16;
    const buckets = new Array( BUCKETS );
    for ( let i = 0; i < BUCKETS; i ++ ) buckets[ i ] = [];
    buckets[ 0 ].push( startIdx );
    let curD = 0, popped = 0;

    const D8x = [ - 1, 1, 0, 0, - 1, - 1, 1, 1 ];
    const D8y = [ 0, 0, - 1, 1, - 1, 1, - 1, 1 ];
    const COST = [ 10, 10, 10, 10, 14, 14, 14, 14 ];

    let maxIdx = startIdx;
    let maxD = 0;

    while ( true ) {

        // Find the lowest non-empty bucket >= curD (modular indexing).
        let found = - 1;
        for ( let off = 0; off < BUCKETS; off ++ ) {

            const b = ( curD + off ) % BUCKETS;
            if ( buckets[ b ].length ) { found = off; break; }

        }
        if ( found < 0 ) break;
        curD += found;
        const bucket = buckets[ curD % BUCKETS ];
        const idx = bucket.pop();
        if ( dist[ idx ] !== curD ) continue;   // stale entry
        popped ++;
        if ( curD > maxD ) { maxD = curD; maxIdx = idx; }

        const x = idx % w, y = ( idx / w ) | 0;
        for ( let k = 0; k < 8; k ++ ) {

            const nx = x + D8x[ k ], ny = y + D8y[ k ];
            if ( nx < 0 || nx >= w || ny < 0 || ny >= h ) continue;
            const ni = ny * w + nx;
            if ( ! mask[ ni ] ) continue;
            const nd = curD + COST[ k ];
            if ( dist[ ni ] === - 1 || nd < dist[ ni ] ) {

                dist[ ni ] = nd;
                parent[ ni ] = idx;
                buckets[ nd % BUCKETS ].push( ni );

            }

        }

    }

    return { dist, parent, maxIdx };

}

// ─── 6. connected components on a mask (8-conn) ───
function connectedComponents( mask, w, h ) {

    const N = w * h;
    const comp = new Int32Array( N ).fill( - 1 );
    const sizes = [];
    const stack = [];
    const D8x = [ - 1, 1, 0, 0, - 1, - 1, 1, 1 ];
    const D8y = [ 0, 0, - 1, 1, - 1, 1, - 1, 1 ];
    let nextId = 0;
    for ( let s = 0; s < N; s ++ ) {

        if ( ! mask[ s ] || comp[ s ] !== - 1 ) continue;
        comp[ s ] = nextId;
        stack.length = 0;
        stack.push( s );
        let size = 0;
        while ( stack.length ) {

            const v = stack.pop();
            size ++;
            const x = v % w, y = ( v / w ) | 0;
            for ( let k = 0; k < 8; k ++ ) {

                const nx = x + D8x[ k ], ny = y + D8y[ k ];
                if ( nx < 0 || nx >= w || ny < 0 || ny >= h ) continue;
                const ni = ny * w + nx;
                if ( ! mask[ ni ] || comp[ ni ] !== - 1 ) continue;
                comp[ ni ] = nextId;
                stack.push( ni );

            }

        }
        sizes.push( size );
        nextId ++;

    }
    return { comp, sizes, count: nextId };

}

// ─── 7. centerline extraction by direction-preserving skeleton walk ───
//
// Algorithm:
//  (a) Thin the *full* road mask with Zhang–Suen → 1-cell skeleton G. Every
//      road cell collapses to its medial axis. T-junctions (pit-outs, figure-8
//      crossings) become degree-≥3 vertices; the main lap is a long cycle.
//  (b) Iteratively prune dead-end chains (degree-1 nodes) until what remains
//      has every node ≥ degree 2. Pit-out stubs vanish. The lap survives
//      because it's cyclic.
//  (c) Walk from the skeleton cell nearest spawn. At each step pick the
//      unvisited neighbour whose direction most aligns with the current
//      heading (= straight through). Allow re-entry to ALREADY-visited
//      degree-≥3 cells (junctions), so figure-8 crossovers — where the lap
//      passes through a +-shape twice — work correctly.
//  (d) Stop when the walk loops back to a cell within `cellSize × 4` m of
//      the start AND the walked length is long enough to be the lap (not a
//      tiny side loop).
function extractCenterLoop( mask, w, h, cellSize, offX, offZ, dist, spawnPos, spawnFwd, closeM, minLoopRadiusM ) {

    const N = w * h;
    void dist;

    // Strategy: trace the OUTER perimeter of the road mask as a closed
    // polygon, then "shrink inward" to the centerline by walking each
    // boundary cell back along the gradient of the distance-transform
    // until we reach a ridge (local DT maximum). That ridge IS the lap
    // centerline.
    //
    // Why this works: the road is a thick strip rolled into a closed loop.
    // Its outer perimeter is one connected boundary curve. Each outer
    // boundary pixel has a unique closest inner cell on the lap centerline
    // (along the perpendicular). Walking up the DT gradient ≡ moving
    // perpendicular to the boundary toward the centerline.
    //
    // Branches (pit-out, paddock) appear in the perimeter as "outward
    // detours" but those map to centerline cells that are NOT on the lap.
    // We filter them by keeping only centerline cells whose DT ≥ medianDT.
    //
    // Failing that, we fall back to the dead-end-pruned skeleton walk.

    void spawnPos; void spawnFwd;   // diagnostic — used downstream
    void minLoopRadiusM;

    // Morphological closing: dilate by 1 cell then erode by 1. Fills small
    // gaps in chunky/triangle-poor meshes (Spa's road has cracks where
    // adjacent strips don't quite overlap). Keeps the skeleton connected.
    function dilate( m ) {

        const o = new Uint8Array( N );
        for ( let y = 1; y < h - 1; y ++ ) for ( let x = 1; x < w - 1; x ++ ) {

            const i = y * w + x;
            if ( m[ i ] ) { o[ i ] = 1; continue; }
            if ( m[ i - 1 ] || m[ i + 1 ] || m[ i - w ] || m[ i + w ] ||
                m[ i - w - 1 ] || m[ i - w + 1 ] || m[ i + w - 1 ] || m[ i + w + 1 ] ) o[ i ] = 1;

        }
        return o;

    }
    function erode( m ) {

        const o = new Uint8Array( N );
        for ( let y = 1; y < h - 1; y ++ ) for ( let x = 1; x < w - 1; x ++ ) {

            const i = y * w + x;
            if ( ! m[ i ] ) continue;
            if ( m[ i - 1 ] && m[ i + 1 ] && m[ i - w ] && m[ i + w ] &&
                m[ i - w - 1 ] && m[ i - w + 1 ] && m[ i + w - 1 ] && m[ i + w + 1 ] ) o[ i ] = 1;

        }
        return o;

    }
    // Close radius in cells: how many dilate+erode passes to fill mesh
    // gaps. Per-map closeM tunes how wide a gap we'll bridge.
    const closeR = closeM > 0 ? Math.max( 1, Math.round( closeM / cellSize ) ) : 2;
    let working = mask;
    for ( let p = 0; p < closeR; p ++ ) working = dilate( working );
    for ( let p = 0; p < closeR; p ++ ) working = erode( working );
    let workingCells = 0;
    for ( const v of working ) if ( v ) workingCells ++;
    console.log( `  [close] morphological close (${ closeR }-dilate, ${ closeR }-erode): ${ workingCells } cells` );

    // We skeletonise the closed mask (no DT-erosion) — Hierholzer downstream
    // can consume any extra connectors. Skipping erosion keeps the lap and
    // pit-paddock topologies fused into one component, so spawn always sits
    // on the lap graph.
    console.log( `  [skel] thinning closed road mask …` );
    const skel = thin( working, w, h );
    let skelCount = 0;
    for ( let i = 0; i < skel.length; i ++ ) if ( skel[ i ] ) skelCount ++;
    console.log( `  [skel] ${ skelCount } cells after Zhang–Suen` );

    // (b) Build adjacency (8-connected). Use Int32Array slots packed in a
    //     flat array for speed: each cell gets up to 8 neighbour idx values
    //     stored contiguously.
    const D8x = [ - 1, 1, 0, 0, - 1, - 1, 1, 1 ];
    const D8y = [ 0, 0, - 1, 1, - 1, 1, - 1, 1 ];

    const adj = new Map();   // skelCellIdx -> int[] of skelCellIdx neighbours
    for ( let y = 1; y < h - 1; y ++ ) for ( let x = 1; x < w - 1; x ++ ) {

        const i = y * w + x;
        if ( ! skel[ i ] ) continue;
        const list = [];
        for ( let k = 0; k < 8; k ++ ) {

            const nx = x + D8x[ k ], ny = y + D8y[ k ];
            const ni = ny * w + nx;
            if ( skel[ ni ] ) list.push( ni );

        }
        adj.set( i, list );

    }
    console.log( `  [skel] ${ adj.size } graph nodes built` );

    // Helper: iteratively prune all degree ≤ 1 nodes ("leaves" → bare cycles).
    function pruneLeaves() {

        let toProcess = [];
        for ( const [ i, ns ] of adj ) if ( ns.length <= 1 ) toProcess.push( i );
        while ( toProcess.length ) {

            const next = [];
            for ( const i of toProcess ) {

                const ns = adj.get( i );
                if ( ! ns ) continue;
                for ( const n of ns ) {

                    const arr = adj.get( n );
                    if ( arr ) {

                        const k = arr.indexOf( i );
                        if ( k >= 0 ) arr.splice( k, 1 );
                        if ( arr.length <= 1 ) next.push( n );

                    }

                }
                adj.delete( i );

            }
            toProcess = next;

        }

    }

    // Helper: find all bridges (edges whose removal disconnects the graph)
    // via Tarjan's algorithm. Returns Set of "u,v" / "v,u" pairs.
    function findBridges() {

        const disc = new Map();
        const low = new Map();
        const bridges = [];
        let timer = 0;
        // Iterative DFS to avoid blowing the stack on long Nordschleife chains.
        const visit = ( root ) => {

            const stack = [ [ root, - 1, 0 ] ];
            disc.set( root, timer );
            low.set( root, timer );
            timer ++;
            while ( stack.length ) {

                const frame = stack[ stack.length - 1 ];
                const [ u, parent, i ] = frame;
                const ns = adj.get( u );
                if ( i < ns.length ) {

                    frame[ 2 ] ++;
                    const v = ns[ i ];
                    if ( v === parent ) continue;
                    if ( disc.has( v ) ) {

                        if ( disc.get( v ) < low.get( u ) ) low.set( u, disc.get( v ) );

                    } else {

                        disc.set( v, timer );
                        low.set( v, timer );
                        timer ++;
                        stack.push( [ v, u, 0 ] );

                    }

                } else {

                    // Done with u: propagate low up to parent, check bridge.
                    stack.pop();
                    if ( parent !== - 1 ) {

                        const lu = low.get( u ), lp = low.get( parent );
                        if ( lu < lp ) low.set( parent, lu );
                        if ( lu > disc.get( parent ) ) bridges.push( [ parent, u ] );

                    }

                }

            }

        };
        for ( const r of adj.keys() ) if ( ! disc.has( r ) ) visit( r );
        return bridges;

    }

    // (b1) First pass: prune dead-end chains.
    pruneLeaves();
    console.log( `  [skel] ${ adj.size } nodes after dead-end prune` );
    if ( adj.size === 0 ) throw new Error( 'no closed cycle in skeleton after prune' );

    // We deliberately keep bridges: some tracks (figure-8 layouts) traverse
    // a single connector as part of their lap. The direction-preserving
    // walker downstream distinguishes "go through bridge" (lap) from "turn
    // off into stub" (pit) by alignment with current heading.
    void findBridges;

    // After bridge removal everything that survives lies on some cycle.
    // Decompose into connected components and pick the LARGEST that reaches
    // the required loop radius around (or extent from) the spawn area.
    const sCellX = Math.round( spawnPos.x / cellSize + offX );
    const sCellZ = Math.round( spawnPos.z / cellSize + offZ );

    const compId = new Map();
    let nextComp = 0;
    const compCells = [];           // node lists per component
    const compClosestToSpawn = [];  // [cellIdx, dist²] per component
    const stk = [];
    for ( const start of adj.keys() ) {

        if ( compId.has( start ) ) continue;
        stk.length = 0;
        stk.push( start );
        compId.set( start, nextComp );
        const cells = [];
        let bestIdx = start, bestD = Infinity;
        while ( stk.length ) {

            const v = stk.pop();
            cells.push( v );
            const x = v % w, y = ( v / w ) | 0;
            const d = ( x - sCellX ) * ( x - sCellX ) + ( y - sCellZ ) * ( y - sCellZ );
            if ( d < bestD ) { bestD = d; bestIdx = v; }
            for ( const u of adj.get( v ) ) if ( ! compId.has( u ) ) { compId.set( u, nextComp ); stk.push( u ); }

        }
        compCells.push( cells );
        compClosestToSpawn.push( [ bestIdx, bestD ] );
        nextComp ++;

    }

    // Geometric extent (max distance between any 2 cells, approximated by
    // bbox diagonal) of each component — proxy for "real lap" vs "small ring".
    function extent( cells ) {

        let xMin = Infinity, xMax = - Infinity, yMin = Infinity, yMax = - Infinity;
        for ( const c of cells ) {

            const x = c % w, y = ( c / w ) | 0;
            if ( x < xMin ) xMin = x;
            if ( x > xMax ) xMax = x;
            if ( y < yMin ) yMin = y;
            if ( y > yMax ) yMax = y;

        }
        return Math.hypot( xMax - xMin, yMax - yMin );

    }

    // Score each component, pick the best.
    let mainComp = 0, mainScore = - Infinity;
    for ( let c = 0; c < nextComp; c ++ ) {

        const ext = extent( compCells[ c ] );
        const sz = compCells[ c ].length;
        const spawnD = Math.sqrt( compClosestToSpawn[ c ][ 1 ] ) * cellSize;
        // Score: extent in cells is the strongest signal; size breaks ties;
        // spawn distance penalises pit-only fragments.
        const score = ext * 5 + sz - spawnD * 0.5;
        console.log( `  [comp ${ c }] size=${ sz }, extent=${ ( ext * cellSize ).toFixed( 0 ) } m, nearest-spawn=${ spawnD.toFixed( 0 ) } m  score=${ score.toFixed( 0 ) }` );
        if ( score > mainScore ) { mainScore = score; mainComp = c; }

    }
    console.log( `  [skel] picked main component ${ mainComp }` );

    // Strip adjacency to main component.
    for ( const k of [ ...adj.keys() ] ) if ( compId.get( k ) !== mainComp ) adj.delete( k );
    for ( const [ k, ns ] of adj ) adj.set( k, ns.filter( n => adj.has( n ) ) );

    // Sanity: extent.
    const lapExtent = extent( compCells[ mainComp ] ) * cellSize;
    if ( lapExtent < minLoopRadiusM * 0.8 ) {

        console.warn( `  [skel] WARNING: lap extent ${ lapExtent.toFixed( 0 ) } m < expected ${ minLoopRadiusM } m` );

    }

    // (c) Hierholzer over the spawn component → consume every edge in one
    // closed walk. Bridges between sub-cycles get traversed twice (once each
    // direction); doubled-back stub paths get collapsed afterward.

    const startCell = compClosestToSpawn[ mainComp ][ 0 ];
    const sX = startCell % w, sY = ( startCell / w ) | 0;
    console.log( `  [skel] start cell world (${ ( ( sX - offX ) * cellSize ).toFixed( 0 ) }, ${ ( ( sY - offZ ) * cellSize ).toFixed( 0 ) })` );

    function edgeKey( u, v ) { return Math.min( u, v ) * 1e9 + Math.max( u, v ); }

    // Use full main-component adjacency.
    const lapAdj = adj;
    let totalEdges = 0;
    for ( const ns of lapAdj.values() ) totalEdges += ns.length;
    totalEdges = totalEdges / 2;
    console.log( `  [walk] main component: ${ lapAdj.size } nodes, ${ totalEdges } edges` );

    // Pre-pass: collapse "stub bridges". A stub bridge is an edge (u,v) such
    // that removing it leaves one side disconnected from spawn AND that side
    // has total extent < minLoopRadiusM/2. Such bridges are pit-out roads
    // and minor connectors — we delete the bridge AND the stub side. The
    // lap-traversed bridges (e.g. figure-8 crossover neck) are kept because
    // both sides are big.
    function findBridgesIn( graph ) {

        const disc = new Map();
        const low = new Map();
        const bridges = [];
        let timer = 0;
        const visit = ( root ) => {

            const stack = [ [ root, - 1, 0 ] ];
            disc.set( root, timer ); low.set( root, timer ); timer ++;
            while ( stack.length ) {

                const frame = stack[ stack.length - 1 ];
                const [ u, parent, i ] = frame;
                const ns = graph.get( u );
                if ( i < ns.length ) {

                    frame[ 2 ] ++;
                    const v = ns[ i ];
                    if ( v === parent ) continue;
                    if ( disc.has( v ) ) {

                        if ( disc.get( v ) < low.get( u ) ) low.set( u, disc.get( v ) );

                    } else {

                        disc.set( v, timer ); low.set( v, timer ); timer ++;
                        stack.push( [ v, u, 0 ] );

                    }

                } else {

                    stack.pop();
                    if ( parent !== - 1 ) {

                        const lu = low.get( u ), lp = low.get( parent );
                        if ( lu < lp ) low.set( parent, lu );
                        if ( lu > disc.get( parent ) ) bridges.push( [ parent, u ] );

                    }

                }

            }

        };
        for ( const r of graph.keys() ) if ( ! disc.has( r ) ) visit( r );
        return bridges;

    }

    // Component size + extent given a starting cell and an excluded edge.
    function componentExtentFrom( start, excludeEdge ) {

        const seen = new Set( [ start ] );
        const stk = [ start ];
        let xMn = start % w, xMx = start % w;
        let yMn = ( start / w ) | 0, yMx = ( start / w ) | 0;
        while ( stk.length ) {

            const v = stk.pop();
            const x = v % w, y = ( v / w ) | 0;
            if ( x < xMn ) xMn = x; if ( x > xMx ) xMx = x;
            if ( y < yMn ) yMn = y; if ( y > yMx ) yMx = y;
            const ns = lapAdj.get( v );
            if ( ! ns ) continue;
            for ( const u of ns ) {

                if ( excludeEdge.has( edgeKey( v, u ) ) ) continue;
                if ( seen.has( u ) ) continue;
                seen.add( u );
                stk.push( u );

            }

        }
        return { size: seen.size, extent: Math.hypot( xMx - xMn, yMx - yMn ) * cellSize, nodes: seen };

    }

    let totalStubRemoved = 0;
    for ( let iter = 0; iter < 6; iter ++ ) {

        const bridges = findBridgesIn( lapAdj );
        if ( bridges.length === 0 ) break;
        let removedThisIter = 0;
        for ( const [ u, v ] of bridges ) {

            const au = lapAdj.get( u );
            const av = lapAdj.get( v );
            if ( ! au || ! av ) continue;
            if ( ! au.includes( v ) ) continue;   // bridge already removed
            const excl = new Set( [ edgeKey( u, v ) ] );
            const sideU = componentExtentFrom( u, excl );
            const sideV = componentExtentFrom( v, excl );
            // Only prune obviously-small stubs (≤ 80 m extent). Bigger
            // detours might be legitimate lap sections — we keep them.
            const stubThresh = 80;
            // Pick smaller side; if both are large, this is a real lap
            // bridge → keep it.
            const smallExtent = Math.min( sideU.extent, sideV.extent );
            const bigExtent = Math.max( sideU.extent, sideV.extent );
            if ( smallExtent < stubThresh && bigExtent > stubThresh ) {

                // Stub: remove bridge AND all stub-side cells from lapAdj.
                const stubSide = sideU.extent < sideV.extent ? sideU.nodes : sideV.nodes;
                for ( const k of stubSide ) lapAdj.delete( k );
                // Patch remaining cells' adjacency.
                for ( const [ k, ns ] of lapAdj ) lapAdj.set( k, ns.filter( n => lapAdj.has( n ) ) );
                removedThisIter ++;
                totalStubRemoved += stubSide.size;

            }

        }
        console.log( `  [stub] iter ${ iter + 1 }: ${ bridges.length } bridges, removed ${ removedThisIter } stubs (${ totalStubRemoved } cells total)` );
        if ( removedThisIter === 0 ) break;

    }
    // Re-prune dead-ends one last time after stub removal.
    {
        let toProcess = [];
        for ( const [ i, ns ] of lapAdj ) if ( ns.length <= 1 ) toProcess.push( i );
        while ( toProcess.length ) {

            const next = [];
            for ( const i of toProcess ) {

                const ns = lapAdj.get( i );
                if ( ! ns ) continue;
                for ( const n of ns ) {

                    const arr = lapAdj.get( n );
                    if ( arr ) {

                        const k = arr.indexOf( i );
                        if ( k >= 0 ) arr.splice( k, 1 );
                        if ( arr.length <= 1 ) next.push( n );

                    }

                }
                lapAdj.delete( i );

            }
            toProcess = next;

        }

    }
    console.log( `  [stub] after pruning: ${ lapAdj.size } nodes` );

    // Find new lapStart: closest cell in lapAdj to spawn.
    let lapStart = - 1, lapStartD = Infinity;
    for ( const k of lapAdj.keys() ) {

        const x = k % w, y = ( k / w ) | 0;
        const d = ( x - sCellX ) * ( x - sCellX ) + ( y - sCellZ ) * ( y - sCellZ );
        if ( d < lapStartD ) { lapStartD = d; lapStart = k; }

    }
    console.log( `  [walk] lap start cell at ${ ( Math.sqrt( lapStartD ) * cellSize ).toFixed( 1 ) } m from spawn` );

    // Recompute total edges.
    totalEdges = 0;
    for ( const ns of lapAdj.values() ) totalEdges += ns.length;
    totalEdges = totalEdges / 2;

    // Initial heading from spawnForward.
    let initHx = spawnFwd.x, initHy = spawnFwd.z;
    const ihl = Math.hypot( initHx, initHy ) || 1;
    initHx /= ihl; initHy /= ihl;

    function pickAligned( cur, prev, candidates ) {

        if ( candidates.length === 1 ) return candidates[ 0 ];
        let ux, uy;
        if ( prev < 0 ) { ux = initHx; uy = initHy; }
        else {

            ux = ( cur % w ) - ( prev % w );
            uy = ( ( cur / w ) | 0 ) - ( ( prev / w ) | 0 );

        }
        const ul = Math.hypot( ux, uy ) || 1;
        let best = candidates[ 0 ], bestDot = - Infinity;
        for ( const n of candidates ) {

            const vx = ( n % w ) - ( cur % w );
            const vy = ( ( n / w ) | 0 ) - ( ( cur / w ) | 0 );
            const vl = Math.hypot( vx, vy ) || 1;
            const dot = ( ux * vx + uy * vy ) / ( ul * vl );
            if ( dot > bestDot ) { bestDot = dot; best = n; }

        }
        return best;

    }

    // Hierholzer's algorithm: build a full Eulerian-style closed walk that
    // consumes every edge of the lap BCC. This handles complicated lap
    // graphs (figure-8, multi-cycle BCC clumps) by definition: every edge is
    // visited exactly once and the walk is a single closed loop.
    //
    // If the BCC has odd-degree vertices (not strictly Eulerian) Hierholzer
    // still produces a long closed walk that visits all edges reachable from
    // start; remaining odd-degree subgraphs need pairing but we accept the
    // best closed walk we can get.
    const usedEdge = new Set();
    // Index per-node: next neighbour to try in its adjacency.
    const idxAt = new Map();
    for ( const n of lapAdj.keys() ) idxAt.set( n, 0 );

    function hierholzer( start ) {

        // Hierholzer: build path by always taking SOME available edge; on
        // dead-end, splice. We use a stack of cells; output is reverse-order
        // (then reversed back at the end).
        const stack = [ start ];
        const out = [];
        while ( stack.length ) {

            const top = stack[ stack.length - 1 ];
            const ns = lapAdj.get( top ) || [];
            // Find next unused edge incident at `top`.
            let i = idxAt.get( top );
            let next = - 1;
            while ( i < ns.length ) {

                const n = ns[ i ];
                if ( ! usedEdge.has( edgeKey( top, n ) ) ) { next = n; i ++; idxAt.set( top, i ); break; }
                i ++;

            }
            idxAt.set( top, i );
            if ( next >= 0 ) {

                usedEdge.add( edgeKey( top, next ) );
                stack.push( next );

            } else {

                out.push( stack.pop() );

            }

        }
        out.reverse();
        return out;

    }

    let cycle = hierholzer( lapStart );
    console.log( `  [walk] hierholzer cycle ${ cycle.length } cells; used ${ usedEdge.size } / ${ totalEdges } edges` );

    // Post-pass: collapse "go-in-then-back-out" stub detours. The Hierholzer
    // walk visits every edge; when there's a stub bridge it goes in, hits a
    // dead-end leaf cycle, and comes back. In the cycle that looks like
    //   … X Y Z … Z Y X …
    // A palindrome around X. We iteratively collapse the longest such
    // palindromes by detecting cell repeats.
    //
    // Algorithm:
    //   • Scan cycle.
    //   • If cycle[i] == cycle[j] for j > i+1, and the segment cycle[i..j]
    //     is a true palindrome (i.e. cycle[i+k] == cycle[j-k] for all k in
    //     the inner half), splice out cycle[i+1..j] (keep one endpoint).
    //   • Iterate until no palindromes remain.
    //
    // We do a single pass scanning for the SHORTEST palindromes (innermost
    // stubs); after collapse, longer stubs become visible and a second pass
    // catches them.
    function collapseStubs( seq ) {

        let out = seq.slice();
        let totalCollapses = 0;
        let changed = true;
        while ( changed ) {

            changed = false;
            // Pass A: collapse length-2 palindromes (X Y X → X).
            for ( let i = 0; i + 2 < out.length; i ++ ) {

                if ( out[ i ] === out[ i + 2 ] && out[ i ] !== out[ i + 1 ] ) {

                    out.splice( i + 1, 2 );
                    changed = true;
                    totalCollapses ++;
                    i -- ;

                }

            }
            // Pass B: longer palindromes. For each pair of equal endpoints
            // out[i] == out[j], verify the *inner* segment is palindromic by
            // checking the first and last inner cells match. We only collapse
            // when the inner cells exactly mirror — guarantees the walker
            // really went-in-and-back-out.
            // Try j in increasing order from i+4, capped to avoid O(n²).
            const MAX_PAL_LEN = 200;   // palindromes longer than this are rare; cap for perf
            for ( let i = 0; i + 4 < out.length; i ++ ) {

                const a = out[ i ];
                for ( let len = 4; len <= MAX_PAL_LEN && i + len < out.length; len += 2 ) {

                    const j = i + len;
                    if ( out[ j ] !== a ) continue;
                    // Check palindrome: out[i+k] == out[j-k] for k=1..len/2-1
                    let isPal = true;
                    const half = len / 2;
                    for ( let k = 1; k < half; k ++ ) {

                        if ( out[ i + k ] !== out[ j - k ] ) { isPal = false; break; }

                    }
                    if ( isPal ) {

                        out.splice( i + 1, len );
                        changed = true;
                        totalCollapses ++;
                        i -- ;
                        break;   // restart scan from i

                    }

                }

            }

        }
        console.log( `  [stub] collapsed ${ totalCollapses } palindromic stubs → ${ out.length } cells` );
        return out;

    }

    cycle = collapseStubs( cycle );

    // Post-pass: extract the longest contiguous sub-sequence of the cycle
    // that has each cell appearing AT MOST a small number of times. This
    // strips off the "go in, come back" detour halves: the lap proper is
    // the longest simple chunk in the Hierholzer walk.
    //
    // We use the sliding-window LONGEST-SUBARRAY-WITH-UNIQUE-CELLS pattern.
    // Wrap-around: append cycle to itself, scan, but cap output at cycle.length.
    function longestSimpleSubcycle( seq ) {

        const n = seq.length;
        if ( n === 0 ) return seq;
        // Build window over seq concatenated with itself (wrap-around).
        const seen = new Map();
        let l = 0, bestL = 0, bestR = 0, bestLen = 0;
        for ( let r = 0; r < 2 * n; r ++ ) {

            const v = seq[ r % n ];
            if ( seen.has( v ) && seen.get( v ) >= l ) l = seen.get( v ) + 1;
            seen.set( v, r );
            const len = r - l + 1;
            if ( len > bestLen ) { bestLen = len; bestL = l; bestR = r; }
            if ( bestLen >= n ) break;

        }
        const out = [];
        for ( let i = bestL; i <= bestR; i ++ ) out.push( seq[ i % n ] );
        return out;

    }

    const simple = longestSimpleSubcycle( cycle );
    console.log( `  [walk] longest simple sub-cycle: ${ simple.length } cells (was ${ cycle.length })` );
    if ( simple.length * cellSize >= minLoopRadiusM * 2 ) {

        cycle = simple;

    } else {

        console.warn( `  [walk] simple sub-cycle too short, keeping Hierholzer output` );

    }

    // Orient: ensure first step is along spawnForward.
    if ( cycle.length >= 2 ) {

        const c1 = cycle[ 1 ];
        const nxC = ( c1 % w ) - ( cycle[ 0 ] % w );
        const nyC = ( ( c1 / w ) | 0 ) - ( ( cycle[ 0 ] / w ) | 0 );
        if ( nxC * initHx + nyC * initHy < 0 ) {

            const head = cycle[ 0 ];
            cycle = [ head, ...cycle.slice( 1 ).reverse() ];

        }

    }
    if ( cycle.length > 2 && cycle[ cycle.length - 1 ] === cycle[ 0 ] ) cycle.pop();

    return cycle.map( i => {

        const x = i % w;
        const y = ( i / w ) | 0;
        return [ ( x - offX ) * cellSize, ( y - offZ ) * cellSize ];

    } );

}

// ─── 8. resample to uniform arclength ───
function resample( pts, ds ) {

    const total = pts.length;
    let acc = 0;
    const seg = [];
    for ( let i = 0; i < total; i ++ ) {

        const a = pts[ i ], b = pts[ ( i + 1 ) % total ];
        const d = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
        seg.push( d );
        acc += d;

    }
    const out = [];
    let cur = 0, segIdx = 0, segRem = seg[ 0 ];
    out.push( pts[ 0 ] );
    while ( cur + ds < acc ) {

        cur += ds;
        let rem = ds;
        while ( rem > segRem ) {

            rem -= segRem;
            segIdx ++;
            segRem = seg[ segIdx ];

        }
        segRem -= rem;
        const t = 1 - segRem / seg[ segIdx ];
        const a = pts[ segIdx ];
        const b = pts[ ( segIdx + 1 ) % total ];
        out.push( [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ] );

    }
    return out;

}

// ─── 9. per-sample half-widths against the mask ───
function halfWidths( samples, mask, w, h, cellSize, offX, offZ, maxM ) {

    const out = [];
    const STEP = 0.5;
    const n = samples.length;
    const maxSteps = Math.ceil( maxM / ( cellSize * STEP ) );

    function isRoad( wx, wz ) {

        const ix = Math.round( wx / cellSize + offX );
        const iy = Math.round( wz / cellSize + offZ );
        if ( ix < 0 || ix >= w || iy < 0 || iy >= h ) return false;
        return !! mask[ iy * w + ix ];

    }

    for ( let i = 0; i < n; i ++ ) {

        const p = samples[ i ];
        const q = samples[ ( i + 1 ) % n ];
        const tx = q[ 0 ] - p[ 0 ], ty = q[ 1 ] - p[ 1 ];
        const tl = Math.hypot( tx, ty ) || 1;
        const nxL = - ty / tl, nyL = tx / tl;

        let leftSteps = 0;
        while ( leftSteps < maxSteps && isRoad( p[ 0 ] + nxL * cellSize * STEP * leftSteps, p[ 1 ] + nyL * cellSize * STEP * leftSteps ) ) leftSteps ++;
        let rightSteps = 0;
        while ( rightSteps < maxSteps && isRoad( p[ 0 ] - nxL * cellSize * STEP * rightSteps, p[ 1 ] - nyL * cellSize * STEP * rightSteps ) ) rightSteps ++;
        out.push( [ ( leftSteps - 1 ) * cellSize * STEP, ( rightSteps - 1 ) * cellSize * STEP ] );

    }
    return out;

}

// ─── 10. minimum-curvature optimisation (iterative smooth + clip) ───
function optimiseLine( samples, widths ) {

    const n = samples.length;
    const tx = new Float64Array( n );
    const ty = new Float64Array( n );
    const nxL = new Float64Array( n );
    const nyL = new Float64Array( n );
    for ( let i = 0; i < n; i ++ ) {

        const a = samples[ ( i + n - 1 ) % n ];
        const b = samples[ ( i + 1 ) % n ];
        const dx = b[ 0 ] - a[ 0 ], dy = b[ 1 ] - a[ 1 ];
        const l = Math.hypot( dx, dy ) || 1;
        tx[ i ] = dx / l;
        ty[ i ] = dy / l;
        nxL[ i ] = - ty[ i ];
        nyL[ i ] = tx[ i ];

    }

    const alpha = new Float64Array( n );
    const alphaMin = new Float64Array( n );
    const alphaMax = new Float64Array( n );
    for ( let i = 0; i < n; i ++ ) {

        alphaMin[ i ] = - widths[ i ][ 1 ] + EDGE_MARGIN_M;
        alphaMax[ i ] = + widths[ i ][ 0 ] - EDGE_MARGIN_M;
        if ( alphaMax[ i ] < alphaMin[ i ] ) {

            const mid = ( alphaMax[ i ] + alphaMin[ i ] ) * 0.5;
            alphaMin[ i ] = alphaMax[ i ] = mid;

        }

    }

    const smoothed = new Float64Array( n );
    for ( let iter = 0; iter < OPT_ITERS; iter ++ ) {

        for ( let i = 0; i < n; i ++ ) {

            smoothed[ i ] = alpha[ i ] + OPT_SMOOTH_K * ( 0.5 * ( alpha[ ( i + n - 1 ) % n ] + alpha[ ( i + 1 ) % n ] ) - alpha[ i ] );

        }
        for ( let i = 0; i < n; i ++ ) {

            alpha[ i ] = Math.max( alphaMin[ i ], Math.min( alphaMax[ i ], smoothed[ i ] ) );

        }

    }

    const line = [];
    for ( let i = 0; i < n; i ++ ) {

        line.push( [ samples[ i ][ 0 ] + nxL[ i ] * alpha[ i ], samples[ i ][ 1 ] + nyL[ i ] * alpha[ i ] ] );

    }
    return line;

}

// ─── 11. curvature + speed profile ───
function speedProfile( line ) {

    const n = line.length;
    const kappa = new Float64Array( n );
    for ( let i = 0; i < n; i ++ ) {

        const a = line[ ( i + n - 1 ) % n ];
        const b = line[ i ];
        const c = line[ ( i + 1 ) % n ];
        const ax = a[ 0 ], ay = a[ 1 ];
        const bx = b[ 0 ], by = b[ 1 ];
        const cx = c[ 0 ], cy = c[ 1 ];
        const A2 = Math.abs( ( bx - ax ) * ( cy - ay ) - ( by - ay ) * ( cx - ax ) );
        const ab = Math.hypot( bx - ax, by - ay );
        const bc = Math.hypot( cx - bx, cy - by );
        const ca = Math.hypot( ax - cx, ay - cy );
        const denom = ab * bc * ca;
        kappa[ i ] = denom > 1e-6 ? ( 2 * A2 / denom ) : 0;

    }

    const v = new Float64Array( n );
    for ( let i = 0; i < n; i ++ ) {

        const k = Math.max( kappa[ i ], 1e-5 );
        v[ i ] = Math.min( V_CAP, Math.sqrt( MU * G / k ) );

    }

    const ds = new Float64Array( n );
    for ( let i = 0; i < n; i ++ ) {

        const a = line[ i ], b = line[ ( i + 1 ) % n ];
        ds[ i ] = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );

    }

    for ( let pass = 0; pass < 2; pass ++ ) {

        for ( let i = 0; i < n; i ++ ) {

            const j = ( i + 1 ) % n;
            const vMax = Math.sqrt( v[ i ] * v[ i ] + 2 * A_MAX * ds[ i ] );
            if ( v[ j ] > vMax ) v[ j ] = vMax;

        }
        for ( let i = n - 1; i >= 0; i -- ) {

            const j = ( i + n - 1 ) % n;
            const vMax = Math.sqrt( v[ i ] * v[ i ] + 2 * B_MAX * ds[ i ] );
            if ( v[ j ] > vMax ) v[ j ] = vMax;

        }

    }

    return v;

}

// ─── 12. orient loop so it flows in spawn direction ───
function orientLoop( line, speeds, spawnPos, spawnFwd ) {

    let best = 0, bestD = Infinity;
    for ( let i = 0; i < line.length; i ++ ) {

        const dx = line[ i ][ 0 ] - spawnPos.x;
        const dz = line[ i ][ 1 ] - spawnPos.z;
        const d = dx * dx + dz * dz;
        if ( d < bestD ) { bestD = d; best = i; }

    }
    const a = line[ best ];
    const b = line[ ( best + 1 ) % line.length ];
    const tx = b[ 0 ] - a[ 0 ], tz = b[ 1 ] - a[ 1 ];
    const dot = tx * spawnFwd.x + tz * spawnFwd.z;
    let ordered = line.slice( best ).concat( line.slice( 0, best ) );
    let v = Array.from( speeds.slice( best ) ).concat( Array.from( speeds.slice( 0, best ) ) );
    if ( dot < 0 ) {

        ordered = ordered.slice().reverse();
        v = v.slice().reverse();

    }
    return { ordered, v };

}

// ─── main ───
async function processMap( id ) {

    const cfg = MAPS[ id ];
    console.log( `\n[${ id }] loading ${ cfg.path }` );
    const tris = await collectTris( cfg );
    if ( tris.length === 0 ) throw new Error( `${ id }: no road triangles (check materials)` );
    console.log( `[${ id }] ${ ( tris.length / 6 ).toLocaleString() } road tris` );

    const ras = rasterise( tris, cfg.cellSize );
    let roadCells = 0; for ( let i = 0; i < ras.mask.length; i ++ ) if ( ras.mask[ i ] ) roadCells ++;
    console.log( `[${ id }] mask ${ ras.w } × ${ ras.h } (${ cfg.cellSize } m/cell), ${ roadCells } road cells` );

    const dist = distanceTransform( ras.mask, ras.w, ras.h );

    console.log( `[${ id }] extracting centerline …` );
    const loopPts = extractCenterLoop(
        ras.mask, ras.w, ras.h, cfg.cellSize, ras.offX, ras.offZ,
        dist, cfg.spawnPos, cfg.spawnForward, cfg.closeM || 4, cfg.minLoopRadiusM || 500
    );
    console.log( `[${ id }] loop: ${ loopPts.length } raw points` );

    const samples = resample( loopPts, cfg.sampleM );
    console.log( `[${ id }] resampled to ${ samples.length } @ ${ cfg.sampleM } m spacing` );

    const widths = halfWidths( samples, ras.mask, ras.w, ras.h, cfg.cellSize, ras.offX, ras.offZ, 60 );
    const wAvg = widths.reduce( ( a, w ) => a + w[ 0 ] + w[ 1 ], 0 ) / widths.length;
    console.log( `[${ id }] avg full-width ~${ wAvg.toFixed( 1 ) } m` );

    const optLine = optimiseLine( samples, widths );
    const speeds = speedProfile( optLine );
    const sMin = Math.min( ...speeds ), sMax = Math.max( ...speeds );
    console.log( `[${ id }] speed: ${ ( sMin * 3.6 ).toFixed( 0 ) } – ${ ( sMax * 3.6 ).toFixed( 0 ) } km/h` );

    const oriented = orientLoop( optLine, speeds, cfg.spawnPos, cfg.spawnForward );

    const out = oriented.ordered.map( ( p, i ) => ( {
        x: + p[ 0 ].toFixed( 2 ),
        z: + p[ 1 ].toFixed( 2 ),
        v: + oriented.v[ i ].toFixed( 2 )
    } ) );

    mkdirSync( 'public/racing-lines', { recursive: true } );
    const outPath = `public/racing-lines/${ id }.json`;
    writeFileSync( outPath, JSON.stringify( out ) );
    console.log( `[${ id }] → ${ outPath } (${ out.length } pts)` );

}

const only = process.argv[ 2 ];
const ids = only ? [ only ] : Object.keys( MAPS );
for ( const id of ids ) await processMap( id );
