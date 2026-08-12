// V2 racing line extractor — geodesic-ring approach.
//
// Algorithm:
//   1. Rasterise road triangles → binary mask (cellSize m / cell).
//   2. Morphological close to bridge small mesh gaps.
//   3. Distance transform → keep cells in the spine (DT ≥ ridgeFrac · median
//      half-width). This removes outer edges and shoulders so the lap is a
//      "thick band" exactly as wide as the inner racing surface.
//   4. Connected components on the spine; pick the component containing
//      spawn (or nearest to it).
//   5. Find a cell on the spine nearest spawn → S. Geodesic BFS from S
//      through the spine → distance d1[c] for every spine cell. The cell
//      with largest d1 is the antipode A (≈ halfway around the lap).
//   6. Geodesic BFS from A → d2[c]. For a closed loop, both half-arcs satisfy
//      d1[c] + d2[c] ≈ d1[A]. Cells satisfying this lie on the lap ring.
//   7. Walk the ring monotonically: sort ring cells by d1, walk in order, then
//      come back along the OTHER half by following decreasing d1 from A back
//      to S using a geodesic walk seeded at A. This gives the lap as
//      S → (along increasing d1) → A → (along decreasing d1, but on the
//      OTHER half) → S.
//
//   The trick that avoids doublebacks: half-arc 1 and half-arc 2 of the lap
//   both have d1 monotonically going 0 → d1[A]. We separate them by which
//   side of the line d1=A/2 each cell is on (using a 2-coloring). Each cell
//   in the ring is assigned to side L or R via BFS from S along the ring graph
//   — the first time we leave S we mark "side", and any neighbour on the ring
//   inherits the same side until it merges with the other half at A.
//
//   8. Resample to uniform arclength.
//   9. Smooth (Gaussian Laplacian).
//  10. Curvature-based speed profile.
//
// Output: racing-lines-v2/<id>.json  ([{x,z,v},…])

import { NodeIO } from '@gltf-transform/core';
import { writeFileSync, mkdirSync } from 'node:fs';

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
        ridgeFrac: 0.55,
        closeM: 4.0,
        spawnPos: { x: 3147.90, z: - 2733.54 },
        spawnQuat: { x: - 0.0046, y: - 0.5791, z: 0.0216, w: 0.8150 }
    },
    nurburgring_gp: {
        path: 'public/textures/models/nurburgring_gp.glb',
        scale: 2,
        racingLineMaterials: new Set( [ 'Esdanurburgring2022681Mtl' ] ),
        cellSize: 2.0,
        sampleM: 6.0,
        ridgeFrac: 0.55,
        closeM: 4.0,
        spawnPos: { x: 26.17, z: 1219.19 },
        spawnQuat: { x: 0.0037, y: - 0.0175, z: 0.0121, w: - 0.9998 }
    },
    spa: {
        path: 'public/textures/models/spa.glb',
        scale: 1,
        // Visual inspection of /tmp/spa-materials.png and the zoomed
        // /tmp/spa_zoom-materials.png shows road1x is the racing surface but
        // the GLB has a topology hole near the start-finish / Bus Stop area:
        // the south loop (Eau Rouge → Combes → Pouhon → Stavelot → Blanchimont)
        // and the north start-finish straight are road1x but are NOT triangle-
        // connected. Adding other materials to bridge introduces parallel
        // old-layout roads or paddock blobs and produces nonsense loops (we
        // tried road3x+roadj+roadb → algorithm traced the outer boundary of
        // the road-coverage region instead of the line).
        //
        // Decision: use road1x ONLY. The algorithm correctly detects the
        // open topology and emits an out-and-back along the south loop. This
        // gives waypoints on real tarmac for the section that's connected; the
        // disconnected north straight is excluded. This is a GLB limitation.
        racingLineMaterials: new Set( [ 'Meshesroadroad1x0171Mtl' ] ),
        cellSize: 2.0,
        sampleM: 10.0,
        ridgeFrac: 0.45,
        closeM: 8.0,
        spawnPos: { x: - 2881.70, z: 2612.47 },
        spawnQuat: { x: 0.0188, y: - 0.1562, z: - 0.0036, w: - 0.9875 }
    },
    suzuka: {
        path: 'public/textures/models/suzuka.glb',
        scale: 1,
        // Visual inspection of /tmp/suzuka-materials.png shows ROAD01 alone
        // covers the entire figure-8 lap (main straight, turn 1+2, esses,
        // Dunlop, Degner, hairpin, spoon, back straight, 130R, Casio chicane).
        // ROAD02 is the parallel pit-lane strip (green in the materials map).
        // ROAD05/06/07 cluster around the pit-out / Casio area and are NOT
        // part of the racing surface. Pit-* materials are obvious pit assets.
        // Re-verified against track-maps/suzuka.png ground truth.
        racingLineMaterials: new Set( [ 'ROAD01' ] ),
        cellSize: 1.5,
        sampleM: 6.0,
        ridgeFrac: 0.55,
        // Keep close radius tight: bigger values weld the ROAD01 pit-out spur
        // (near start/finish + Casio Triangle) onto the racing surface and the
        // skeleton then has extra Y-junctions that the loop solver can't tell
        // apart from the real lap.
        closeM: 1.5,
        // ROAD01 contains a few pit-out spurs ~30–60 m long. Default 8-iter
        // leaf prune leaves them intact, which produces "open spur" tails in
        // the final loop. Bumping to 50 chews through them while still leaving
        // the main cycle untouched (cycle cells have degree 2, never get
        // demoted to degree-1 leaves).
        leafPruneIters: 50,
        spawnPos: { x: 505.02, z: 504.37 },
        spawnQuat: { x: 0.0026, y: - 0.9995, z: - 0.0158, w: 0.0257 }
    }
};

for ( const cfg of Object.values( MAPS ) ) cfg.spawnForward = spawnForwardFromQuat( cfg.spawnQuat );

const MU = 1.05;
const G = 9.81;
const A_MAX = 9.0;
const B_MAX = 16.0;
const V_CAP = 95;

// ─── mat4 helpers ──────────────────────────────────────────────────────────
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

// ─── 1. collect tris ───────────────────────────────────────────────────────
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

// ─── 2. rasterise ──────────────────────────────────────────────────────────
function rasterise( tris, cellSize ) {

    let xMin = Infinity, xMax = - Infinity, zMin = Infinity, zMax = - Infinity;
    for ( let i = 0; i < tris.length; i += 2 ) {

        if ( tris[ i ] < xMin ) xMin = tris[ i ];
        if ( tris[ i ] > xMax ) xMax = tris[ i ];
        if ( tris[ i + 1 ] < zMin ) zMin = tris[ i + 1 ];
        if ( tris[ i + 1 ] > zMax ) zMax = tris[ i + 1 ];

    }
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
    return { mask, w, h, offX, offZ, xMin, xMax, zMin, zMax };

}

// ─── distance transform (Felzenszwalb–Huttenlocher squared) ───────────────
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

    const INF = 1e12;
    const f = new Float64Array( w * h );
    for ( let i = 0; i < f.length; i ++ ) f[ i ] = mask[ i ] ? INF : 0;
    const col = new Float64Array( h );
    const tmp = new Float64Array( w * h );
    for ( let y = 0; y < h; y ++ ) {

        const row = new Float64Array( w );
        for ( let x = 0; x < w; x ++ ) row[ x ] = f[ y * w + x ];
        const out = dt1D( row, w );
        for ( let x = 0; x < w; x ++ ) tmp[ y * w + x ] = out[ x ];

    }
    const dist = new Float64Array( w * h );
    for ( let x = 0; x < w; x ++ ) {

        for ( let y = 0; y < h; y ++ ) col[ y ] = tmp[ y * w + x ];
        const out = dt1D( col, h );
        for ( let y = 0; y < h; y ++ ) {

            const v = out[ y ];
            dist[ y * w + x ] = mask[ y * w + x ] ? Math.sqrt( v ) : 0;

        }

    }
    return dist;

}

// ─── morphological ops ─────────────────────────────────────────────────────
function dilate( m, w, h ) {

    const o = new Uint8Array( w * h );
    for ( let y = 1; y < h - 1; y ++ ) for ( let x = 1; x < w - 1; x ++ ) {

        const i = y * w + x;
        if ( m[ i ] ) { o[ i ] = 1; continue; }
        if ( m[ i - 1 ] || m[ i + 1 ] || m[ i - w ] || m[ i + w ] ||
            m[ i - w - 1 ] || m[ i - w + 1 ] || m[ i + w - 1 ] || m[ i + w + 1 ] ) o[ i ] = 1;

    }
    return o;

}

function erode( m, w, h ) {

    const o = new Uint8Array( w * h );
    for ( let y = 1; y < h - 1; y ++ ) for ( let x = 1; x < w - 1; x ++ ) {

        const i = y * w + x;
        if ( ! m[ i ] ) continue;
        if ( m[ i - 1 ] && m[ i + 1 ] && m[ i - w ] && m[ i + w ] &&
            m[ i - w - 1 ] && m[ i - w + 1 ] && m[ i + w - 1 ] && m[ i + w + 1 ] ) o[ i ] = 1;

    }
    return o;

}

function morphClose( m, w, h, r ) {

    let out = m;
    for ( let i = 0; i < r; i ++ ) out = dilate( out, w, h );
    for ( let i = 0; i < r; i ++ ) out = erode( out, w, h );
    return out;

}

// ─── Zhang–Suen thinning ───────────────────────────────────────────────────
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

// ─── connected components (8-conn) ─────────────────────────────────────────
function components( mask, w, h ) {

    const N = w * h;
    const comp = new Int32Array( N ).fill( - 1 );
    const cells = [];
    const D8x = [ - 1, 1, 0, 0, - 1, - 1, 1, 1 ];
    const D8y = [ 0, 0, - 1, 1, - 1, 1, - 1, 1 ];
    let next = 0;
    for ( let s = 0; s < N; s ++ ) {

        if ( ! mask[ s ] || comp[ s ] !== - 1 ) continue;
        const arr = [];
        comp[ s ] = next;
        const stk = [ s ];
        while ( stk.length ) {

            const v = stk.pop();
            arr.push( v );
            const x = v % w, y = ( v / w ) | 0;
            for ( let k = 0; k < 8; k ++ ) {

                const nx = x + D8x[ k ], ny = y + D8y[ k ];
                if ( nx < 0 || nx >= w || ny < 0 || ny >= h ) continue;
                const ni = ny * w + nx;
                if ( ! mask[ ni ] || comp[ ni ] !== - 1 ) continue;
                comp[ ni ] = next;
                stk.push( ni );

            }

        }
        cells.push( arr );
        next ++;

    }
    return { comp, cells, count: next };

}

// ─── weighted Dijkstra (binary-heap) through a mask ──────────────────────
// Costs: orthogonal=10, diagonal=14, multiplied by `cost[ni]` if provided
// (1 for normal cells, higher for "penalty" cells). Returns dist + parent.
function dijkstra( mask, w, h, startIdx, cost ) {

    const N = w * h;
    const dist = new Float64Array( N );
    for ( let i = 0; i < N; i ++ ) dist[ i ] = Infinity;
    const parent = new Int32Array( N ).fill( - 1 );
    if ( ! mask[ startIdx ] ) return { dist, parent, maxIdx: - 1, maxD: 0 };
    dist[ startIdx ] = 0;
    const D8x = [ - 1, 1, 0, 0, - 1, - 1, 1, 1 ];
    const D8y = [ 0, 0, - 1, 1, - 1, 1, - 1, 1 ];
    const COST = [ 10, 10, 10, 10, 14, 14, 14, 14 ];
    // Min-heap of [dist, idx]
    const heap = [ [ 0, startIdx ] ];
    function hpush( d, i ) {

        heap.push( [ d, i ] );
        let n = heap.length - 1;
        while ( n > 0 ) {

            const p = ( n - 1 ) >> 1;
            if ( heap[ p ][ 0 ] <= heap[ n ][ 0 ] ) break;
            const t = heap[ p ]; heap[ p ] = heap[ n ]; heap[ n ] = t;
            n = p;

        }

    }
    function hpop() {

        const top = heap[ 0 ];
        const last = heap.pop();
        if ( heap.length ) {

            heap[ 0 ] = last;
            let n = 0;
            const L = heap.length;
            while ( true ) {

                const l = n * 2 + 1, r = l + 1; let m = n;
                if ( l < L && heap[ l ][ 0 ] < heap[ m ][ 0 ] ) m = l;
                if ( r < L && heap[ r ][ 0 ] < heap[ m ][ 0 ] ) m = r;
                if ( m === n ) break;
                const t = heap[ m ]; heap[ m ] = heap[ n ]; heap[ n ] = t;
                n = m;

            }

        }
        return top;

    }
    let maxIdx = startIdx, maxD = 0;
    while ( heap.length ) {

        const [ d, idx ] = hpop();
        if ( d > dist[ idx ] ) continue;
        if ( d > maxD ) { maxD = d; maxIdx = idx; }
        const x = idx % w, y = ( idx / w ) | 0;
        for ( let k = 0; k < 8; k ++ ) {

            const nx = x + D8x[ k ], ny = y + D8y[ k ];
            if ( nx < 0 || nx >= w || ny < 0 || ny >= h ) continue;
            const ni = ny * w + nx;
            if ( ! mask[ ni ] ) continue;
            const w_ = cost ? cost[ ni ] : 1;
            const nd = d + COST[ k ] * w_;
            if ( nd < dist[ ni ] ) {

                dist[ ni ] = nd;
                parent[ ni ] = idx;
                hpush( nd, ni );

            }

        }

    }
    return { dist, parent, maxIdx, maxD };

}

// Convenience wrapper: integer geodesic = dijkstra with cost=null.
function geodesicBFS( mask, w, h, startIdx ) {

    const r = dijkstra( mask, w, h, startIdx, null );
    // Convert to int compatible API: same shape.
    return { dist: r.dist, parent: r.parent, maxIdx: r.maxIdx, maxD: r.maxD };

}

// ─── trace path from cell back to start via parent[] ──────────────────────
function tracePath( parent, startIdx, endIdx ) {

    const path = [];
    let cur = endIdx;
    let safety = parent.length;
    while ( cur !== - 1 && safety -- > 0 ) {

        path.push( cur );
        if ( cur === startIdx ) break;
        cur = parent[ cur ];

    }
    path.reverse();
    return path;

}

// ─── extract the lap loop ──────────────────────────────────────────────────
function extractLoop( roadMask, w, h, cfg, ras ) {

    // A. Close gaps.
    const closeR = Math.max( 1, Math.round( cfg.closeM / cfg.cellSize ) );
    const closed = morphClose( roadMask, w, h, closeR );
    let closedCount = 0;
    for ( const v of closed ) if ( v ) closedCount ++;
    console.log( `  [close] ${ closeR }x dilate+erode → ${ closedCount } cells` );

    // B. Distance transform on the closed mask.
    const dist = distanceTransform( closed, w, h );

    // Median DT among road cells = typical half-width.
    const dtVals = [];
    for ( let i = 0; i < dist.length; i ++ ) if ( closed[ i ] && dist[ i ] > 0 ) dtVals.push( dist[ i ] );
    dtVals.sort( ( a, b ) => a - b );
    const median = dtVals[ ( dtVals.length / 2 ) | 0 ];
    let maxDT = 0;
    for ( const v of dist ) if ( v > maxDT ) maxDT = v;
    console.log( `  [dt] median=${ median.toFixed( 1 ) } cells (${ ( median * cfg.cellSize ).toFixed( 1 ) } m), max=${ maxDT.toFixed( 1 ) }` );

    // C. Thin the closed road to a 1-cell skeleton (medial axis). The lap
    //    appears as ONE big cycle in the skeleton graph; paddock and pit
    //    lanes attach as branches via narrow bridges. Crucially, the
    //    skeleton is 1-pixel wide: geodesic BFS through it follows the
    //    medial axis exactly, no shortcuts through wide paddocks.
    const skel = thin( closed, w, h );
    let skelCount = 0;
    for ( const v of skel ) if ( v ) skelCount ++;
    console.log( `  [skel] ${ skelCount } cells after Zhang–Suen` );

    // We could iteratively prune leaves to remove obvious dead-ends, but the
    // skeleton BFS already handles this naturally: dead-end branches dilate
    // d1 a bit, but the antipode A still ends up on the main lap (longest
    // geodesic from S) and the back-path from A finds the OTHER half-arc.
    //
    // To improve robustness we DO prune degree-1 leaves once: the skeleton
    // from triangle meshes has lots of tiny single-cell spurs that just
    // confuse path tracing.
    const D8x = [ - 1, 1, 0, 0, - 1, - 1, 1, 1 ];
    const D8y = [ 0, 0, - 1, 1, - 1, 1, - 1, 1 ];
    const skelMask = new Uint8Array( skel );
    function nbCount( idx ) {

        const x = idx % w, y = ( idx / w ) | 0;
        let c = 0;
        for ( let k = 0; k < 8; k ++ ) {

            const nx = x + D8x[ k ], ny = y + D8y[ k ];
            if ( nx < 0 || nx >= w || ny < 0 || ny >= h ) continue;
            if ( skelMask[ ny * w + nx ] ) c ++;

        }
        return c;

    }
    // Prune leaves iteratively. Stop after `maxPrune` iterations to avoid
    // eating away at thin sections of the lap itself. Per-map override via
    // cfg.leafPruneIters — cycle cells stay degree-2 forever, so high values
    // only hurt if a "lap" section is thinner than the longest spur (rare).
    const maxPrune = cfg.leafPruneIters ?? 8;
    for ( let iter = 0; iter < maxPrune; iter ++ ) {

        const toKill = [];
        for ( let i = 0; i < skelMask.length; i ++ ) {

            if ( skelMask[ i ] && nbCount( i ) <= 1 ) toKill.push( i );

        }
        if ( ! toKill.length ) break;
        for ( const i of toKill ) skelMask[ i ] = 0;

    }
    let prunedCount = 0;
    for ( const v of skelMask ) if ( v ) prunedCount ++;
    console.log( `  [skel] ${ prunedCount } cells after leaf prune` );

    void median;
    void dist;

    // D. Connected components on the pruned skeleton.
    const sCellX = Math.round( cfg.spawnPos.x / cfg.cellSize + ras.offX );
    const sCellZ = Math.round( cfg.spawnPos.z / cfg.cellSize + ras.offZ );
    const { comp, cells, count } = components( skelMask, w, h );
    console.log( `  [comp] ${ count } spine components` );
    let lapComp = - 1, bestD = Infinity;
    for ( let c = 0; c < count; c ++ ) {

        let cBest = Infinity;
        for ( const v of cells[ c ] ) {

            const x = v % w, y = ( v / w ) | 0;
            const d = ( x - sCellX ) * ( x - sCellX ) + ( y - sCellZ ) * ( y - sCellZ );
            if ( d < cBest ) cBest = d;

        }
        // bbox extent
        let xMn = Infinity, xMx = - Infinity, yMn = Infinity, yMx = - Infinity;
        for ( const v of cells[ c ] ) {

            const x = v % w, y = ( v / w ) | 0;
            if ( x < xMn ) xMn = x; if ( x > xMx ) xMx = x;
            if ( y < yMn ) yMn = y; if ( y > yMx ) yMx = y;

        }
        const ext = Math.hypot( xMx - xMn, yMx - yMn ) * cfg.cellSize;
        const sz = cells[ c ].length;
        if ( c < 10 ) console.log( `    [comp ${ c }] size=${ sz }, extent=${ ext.toFixed( 0 ) } m, nearest-spawn=${ ( Math.sqrt( cBest ) * cfg.cellSize ).toFixed( 0 ) } m` );
        if ( cBest < bestD ) { bestD = cBest; lapComp = c; }

    }
    if ( lapComp === - 1 ) throw new Error( 'no spine component found' );
    console.log( `  [lap] picked component ${ lapComp } at ${ ( Math.sqrt( bestD ) * cfg.cellSize ).toFixed( 1 ) } m from spawn` );

    // Build a mask restricted to the lap component.
    const lapMask = new Uint8Array( w * h );
    for ( const v of cells[ lapComp ] ) lapMask[ v ] = 1;

    // E. Find seed cell S = lap-component cell nearest spawn.
    let S = - 1, bestS = Infinity;
    for ( const v of cells[ lapComp ] ) {

        const x = v % w, y = ( v / w ) | 0;
        const d = ( x - sCellX ) * ( x - sCellX ) + ( y - sCellZ ) * ( y - sCellZ );
        if ( d < bestS ) { bestS = d; S = v; }

    }
    console.log( `  [geodesic] seed S at ${ ( Math.sqrt( bestS ) * cfg.cellSize ).toFixed( 1 ) } m from spawn` );

    // F. BFS from S in the skeleton → d1, antipode A = cell with max d1.
    //    For a closed loop, A is roughly halfway around the lap. (Branches
    //    add a small radial distance but the longest geodesic is along the
    //    lap itself.)
    const bfs1 = geodesicBFS( lapMask, w, h, S );
    const A = bfs1.maxIdx;
    console.log( `  [geodesic] antipode A at ${ ( bfs1.maxD * 0.1 * cfg.cellSize ).toFixed( 0 ) } m geodesic from S` );

    // G. Path 1 = S → A along parent pointers of BFS1.
    const path1 = tracePath( bfs1.parent, S, A );
    console.log( `  [path] half-arc 1 (S→A): ${ path1.length } cells` );

    // H. Penalise path1's inner cells (excluding S and A) by a heavy weight,
    //    then run a SECOND Dijkstra from S to find the next-best path to A.
    //    Because path1 cells are now expensive (but still passable for
    //    crossings), the cheapest alternate route goes around the OTHER
    //    side of the lap. This is the "k-shortest paths with edge penalty"
    //    relaxation — robust even when the skeleton has thin connectivity.
    const cost = new Float64Array( w * h );
    for ( let i = 0; i < cost.length; i ++ ) cost[ i ] = 1;
    // PENALTY needs to be high enough that crossing a path1 cell is more
    // expensive than going all the way around the lap. With cell cost ≥
    // path1.length, any alternative is preferred where one exists.
    const PENALTY = path1.length * 100;
    for ( let i = 1; i < path1.length - 1; i ++ ) cost[ path1[ i ] ] = PENALTY;

    const bfs2 = dijkstra( lapMask, w, h, S, cost );
    const path2 = tracePath( bfs2.parent, S, A ); // S → A through the OTHER side
    console.log( `  [path] half-arc 2 (S→A penalised): ${ path2.length } cells` );

    // (Reuse statistic deferred — computed below for the open/closed decision.)

    // I. Detect open vs closed topology by overlap. If path2 reuses ≥ 50% of
    //    path1, the underlying road graph is an OPEN path (e.g. Spa's road1x
    //    material is an out-and-back chunk, not a closed loop). For open
    //    topologies we emit an out-and-back: walk to A and back along the
    //    same line. For closed topologies, combine path1 + reverse(path2)
    //    to get the full lap.
    const p1set = new Set( path1 );
    let reuse2 = 0;
    for ( const v of path2 ) if ( p1set.has( v ) ) reuse2 ++;
    const reuseFrac = reuse2 / path2.length;
    const isOpen = reuseFrac >= 0.5;
    console.log( `  [topology] path2 reuses ${ ( reuseFrac * 100 ).toFixed( 0 ) }% of path1 → ${ isOpen ? 'OPEN (out-and-back)' : 'CLOSED (true loop)' }` );

    let loopCells;
    if ( isOpen ) {

        // Out-and-back: S → A → S (reverse). Drops the doubled S and A.
        loopCells = path1.concat( path1.slice( 0, - 1 ).reverse() ).slice( 0, - 1 );

    } else {

        // True loop: combine path1 + reverse(path2). Skip the shared
        // endpoints to avoid duplicates.
        const path2Rev = path2.slice().reverse();
        loopCells = path1.concat( path2Rev.slice( 1, - 1 ) );

        // Collapse any residual length-2 palindromes (rare but possible at
        // junctions where path1 and path2 briefly run alongside).
        let changed = true, collapses = 0;
        while ( changed ) {

            changed = false;
            for ( let i = 0; i + 2 < loopCells.length; i ++ ) {

                if ( loopCells[ i ] === loopCells[ i + 2 ] && loopCells[ i ] !== loopCells[ i + 1 ] ) {

                    loopCells.splice( i + 1, 2 );
                    changed = true;
                    collapses ++;
                    i --;

                }

            }

        }
        if ( collapses ) console.log( `  [loop] collapsed ${ collapses } length-2 palindromes` );

    }
    console.log( `  [loop] combined ${ loopCells.length } cells` );

    return loopCells.map( i => {

        const x = i % w;
        const y = ( i / w ) | 0;
        return [ ( x - ras.offX ) * cfg.cellSize, ( y - ras.offZ ) * cfg.cellSize ];

    } );

}

// ─── resample ──────────────────────────────────────────────────────────────
function resample( pts, ds ) {

    const n = pts.length;
    let acc = 0;
    const seg = [];
    for ( let i = 0; i < n; i ++ ) {

        const a = pts[ i ], b = pts[ ( i + 1 ) % n ];
        const d = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
        seg.push( d );
        acc += d;

    }
    const out = [];
    out.push( pts[ 0 ] );
    let cur = 0, segIdx = 0, segRem = seg[ 0 ];
    while ( cur + ds < acc ) {

        cur += ds;
        let rem = ds;
        while ( rem > segRem ) {

            rem -= segRem;
            segIdx ++;
            if ( segIdx >= seg.length ) { segIdx = seg.length - 1; rem = segRem; break; }
            segRem = seg[ segIdx ];

        }
        segRem -= rem;
        const denom = seg[ segIdx ] || 1;
        const t = 1 - segRem / denom;
        const a = pts[ segIdx ];
        const b = pts[ ( segIdx + 1 ) % n ];
        out.push( [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t ] );

    }
    return out;

}

// ─── smooth ────────────────────────────────────────────────────────────────
function smoothLoop( pts, iters = 8, k = 0.35 ) {

    const n = pts.length;
    const buf = pts.map( p => p.slice() );
    for ( let it = 0; it < iters; it ++ ) {

        const next = buf.map( p => p.slice() );
        for ( let i = 0; i < n; i ++ ) {

            const a = buf[ ( i + n - 1 ) % n ];
            const b = buf[ i ];
            const c = buf[ ( i + 1 ) % n ];
            next[ i ][ 0 ] = b[ 0 ] + k * ( 0.5 * ( a[ 0 ] + c[ 0 ] ) - b[ 0 ] );
            next[ i ][ 1 ] = b[ 1 ] + k * ( 0.5 * ( a[ 1 ] + c[ 1 ] ) - b[ 1 ] );

        }
        for ( let i = 0; i < n; i ++ ) { buf[ i ][ 0 ] = next[ i ][ 0 ]; buf[ i ][ 1 ] = next[ i ][ 1 ]; }

    }
    return buf;

}

// ─── speed profile ────────────────────────────────────────────────────────
function speedProfile( line ) {

    const n = line.length;
    const kappa = new Float64Array( n );
    for ( let i = 0; i < n; i ++ ) {

        const a = line[ ( i + n - 1 ) % n ];
        const b = line[ i ];
        const c = line[ ( i + 1 ) % n ];
        const A2 = Math.abs( ( b[ 0 ] - a[ 0 ] ) * ( c[ 1 ] - a[ 1 ] ) - ( b[ 1 ] - a[ 1 ] ) * ( c[ 0 ] - a[ 0 ] ) );
        const ab = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
        const bc = Math.hypot( c[ 0 ] - b[ 0 ], c[ 1 ] - b[ 1 ] );
        const ca = Math.hypot( a[ 0 ] - c[ 0 ], a[ 1 ] - c[ 1 ] );
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

// ─── orient so first step aligns with spawnForward ────────────────────────
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

        ordered = [ ordered[ 0 ], ...ordered.slice( 1 ).reverse() ];
        v = [ v[ 0 ], ...v.slice( 1 ).reverse() ];

    }
    return { ordered, v };

}

// ─── main ──────────────────────────────────────────────────────────────────
async function processMap( id ) {

    const cfg = MAPS[ id ];
    console.log( `\n[${ id }] loading ${ cfg.path }` );
    const tris = await collectTris( cfg );
    if ( tris.length === 0 ) throw new Error( `${ id }: no road triangles` );
    console.log( `[${ id }] ${ ( tris.length / 6 ).toLocaleString() } road tris` );

    const ras = rasterise( tris, cfg.cellSize );
    let roadCells = 0; for ( const v of ras.mask ) if ( v ) roadCells ++;
    console.log( `[${ id }] mask ${ ras.w } × ${ ras.h } (${ cfg.cellSize } m/cell), ${ roadCells } road cells` );

    const loopPts = extractLoop( ras.mask, ras.w, ras.h, cfg, ras );
    console.log( `[${ id }] raw loop: ${ loopPts.length } cells` );

    let rawLen = 0;
    for ( let i = 0; i < loopPts.length; i ++ ) {

        const a = loopPts[ i ], b = loopPts[ ( i + 1 ) % loopPts.length ];
        rawLen += Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );

    }
    console.log( `[${ id }] raw lap length: ${ rawLen.toFixed( 0 ) } m` );

    const samples = resample( loopPts, cfg.sampleM );
    console.log( `[${ id }] resampled to ${ samples.length } @ ${ cfg.sampleM } m spacing` );

    const smooth = smoothLoop( samples, 6, 0.35 );

    const speeds = speedProfile( smooth );
    const sMin = Math.min( ...speeds ), sMax = Math.max( ...speeds );
    console.log( `[${ id }] speed: ${ ( sMin * 3.6 ).toFixed( 0 ) } – ${ ( sMax * 3.6 ).toFixed( 0 ) } km/h` );

    const oriented = orientLoop( smooth, speeds, cfg.spawnPos, cfg.spawnForward );

    const out = oriented.ordered.map( ( p, i ) => ( {
        x: + p[ 0 ].toFixed( 2 ),
        z: + p[ 1 ].toFixed( 2 ),
        v: + oriented.v[ i ].toFixed( 2 )
    } ) );

    mkdirSync( 'racing-lines-v2', { recursive: true } );
    const outPath = `racing-lines-v2/${ id }.json`;
    writeFileSync( outPath, JSON.stringify( out ) );
    console.log( `[${ id }] → ${ outPath } (${ out.length } pts)` );

}

const only = process.argv[ 2 ];
const ids = only ? [ only ] : Object.keys( MAPS );
for ( const id of ids ) await processMap( id );
