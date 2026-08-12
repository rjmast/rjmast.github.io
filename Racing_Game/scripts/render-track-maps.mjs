// Render a top-down PNG of just the road for each map.
// 1. Walks the GLB, applies node transforms (incl. Sketchfab_model Y-up rotation + map scale)
// 2. Keeps only triangles whose material name ∈ MAPS[id].roadMaterials
// 3. Projects world XZ to pixels, fits bbox into the canvas with PADDING
// 4. Rasterizes triangles to an RGBA buffer, encodes via pngjs
// 5. ImageMagick overlays the map label in Didot Italic, top-left
//
// Output: track-maps/<id>.png

import { NodeIO } from '@gltf-transform/core';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
// FONT_PATH is referenced by the PIL helper (scripts/_overlay-label.py).

const SIZE = 2400;
const PADDING = 140;
const ROAD_RGBA = [ 28, 28, 30, 255 ];
const BG_RGBA = [ 255, 255, 255, 255 ];

// Replicated from src/main.js MAPS, just the bits this script needs.
const MAPS = {
    nurburgring: {
        label: 'Nürburgring · Nordschleife',
        path: 'public/textures/models/nurburgring.glb',
        scale: 1,
        roadMaterials: new Set( [ 'Material' ] )
    },
    nurburgring_gp: {
        label: 'Nürburgring · GP',
        path: 'public/textures/models/nurburgring_gp.glb',
        scale: 2,
        roadMaterials: new Set( [ 'Esdanurburgring2022681Mtl' ] )
    },
    spa: {
        label: 'Spa-Francorchamps',
        path: 'public/textures/models/spa.glb',
        scale: 1,
        roadMaterials: new Set( [
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
        ] )
    },
    suzuka: {
        label: 'Suzuka Circuit',
        path: 'public/textures/models/suzuka.glb',
        scale: 1,
        roadMaterials: new Set( [
            'ROAD01', 'ROAD02', 'ROAD03', 'ROAD04', 'ROAD05', 'ROAD06', 'ROAD07',
            'ROADD', 'ROADX',
            'PITROAD', 'RDPITLTA', 'YLOPITLTA', 'PITEXITLINE'
        ] )
    }
};

const FONT_PATH = '/System/Library/Fonts/Supplemental/Didot.ttc';

// ---------------- minimal mat4 (column-major) ----------------
function mat4Identity() {

    return new Float64Array( [ 1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 1, 0,  0, 0, 0, 1 ] );

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

function nodeLocalMatrix( node ) {

    const mat = node.getMatrix();
    if ( mat ) {

        const m = new Float64Array( 16 );
        for ( let i = 0; i < 16; i ++ ) m[ i ] = mat[ i ];
        return m;

    }
    return mat4FromTRS( node.getTranslation(), node.getRotation(), node.getScale() );

}

function transformPoint( m, x, y, z, out ) {

    const w = m[ 3 ] * x + m[ 7 ] * y + m[ 11 ] * z + m[ 15 ];
    out[ 0 ] = ( m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ] ) / w;
    out[ 1 ] = ( m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ] ) / w;
    out[ 2 ] = ( m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ] ) / w;

}

// ---------------- collect road triangles in world XZ ----------------
async function collectRoadTris( cfg ) {

    const io = new NodeIO();
    const doc = await io.read( cfg.path );
    const root = doc.getRoot();
    const scene = root.getDefaultScene() || root.listScenes()[ 0 ];

    // Outer scale matches main.js track.scale.setScalar(mapCfg.scale).
    const s = cfg.scale || 1;
    const rootMat = mat4FromTRS( [ 0, 0, 0 ], [ 0, 0, 0, 1 ], [ s, s, s ] );

    const tris = []; // [x1,z1,x2,z2,x3,z3,...]
    const tmp = [ 0, 0, 0 ];

    function visit( node, parentMat ) {

        const worldMat = mat4Mul( parentMat, nodeLocalMatrix( node ) );
        const mesh = node.getMesh();
        if ( mesh ) {

            for ( const prim of mesh.listPrimitives() ) {

                const mat = prim.getMaterial();
                const name = mat ? ( mat.getName() || '' ) : '';
                if ( ! cfg.roadMaterials.has( name ) ) continue;

                const posAttr = prim.getAttribute( 'POSITION' );
                if ( ! posAttr ) continue;
                const posArr = posAttr.getArray();
                const vCount = ( posArr.length / 3 ) | 0;

                // Pre-transform every vertex once → world XZ.
                const wxz = new Float64Array( vCount * 2 );
                for ( let i = 0; i < vCount; i ++ ) {

                    transformPoint( worldMat, posArr[ i * 3 ], posArr[ i * 3 + 1 ], posArr[ i * 3 + 2 ], tmp );
                    wxz[ i * 2 ] = tmp[ 0 ];
                    wxz[ i * 2 + 1 ] = tmp[ 2 ];

                }

                const idxAttr = prim.getIndices();
                const idx = idxAttr ? idxAttr.getArray() : null;
                const triCount = idx ? ( idx.length / 3 ) | 0 : ( vCount / 3 ) | 0;

                for ( let i = 0; i < triCount; i ++ ) {

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
        for ( const child of node.listChildren() ) visit( child, worldMat );

    }

    for ( const node of scene.listChildren() ) visit( node, rootMat );
    return tris;

}

// ---------------- triangle rasterizer (barycentric, no AA) ----------------
function rasterizeTri( buf, w, h, x1, y1, x2, y2, x3, y3, r, g, b ) {

    const xMin = Math.max( 0, Math.floor( Math.min( x1, x2, x3 ) ) );
    const xMax = Math.min( w - 1, Math.ceil( Math.max( x1, x2, x3 ) ) );
    const yMin = Math.max( 0, Math.floor( Math.min( y1, y2, y3 ) ) );
    const yMax = Math.min( h - 1, Math.ceil( Math.max( y1, y2, y3 ) ) );

    const den = ( y2 - y3 ) * ( x1 - x3 ) + ( x3 - x2 ) * ( y1 - y3 );
    if ( Math.abs( den ) < 1e-7 ) return;
    const invDen = 1 / den;

    for ( let py = yMin; py <= yMax; py ++ ) {

        const cy = py + 0.5;
        for ( let px = xMin; px <= xMax; px ++ ) {

            const cx = px + 0.5;
            const w1 = ( ( y2 - y3 ) * ( cx - x3 ) + ( x3 - x2 ) * ( cy - y3 ) ) * invDen;
            const w2 = ( ( y3 - y1 ) * ( cx - x3 ) + ( x1 - x3 ) * ( cy - y3 ) ) * invDen;
            const w3 = 1 - w1 - w2;
            if ( w1 >= 0 && w2 >= 0 && w3 >= 0 ) {

                const idx = ( py * w + px ) * 4;
                buf[ idx ] = r;
                buf[ idx + 1 ] = g;
                buf[ idx + 2 ] = b;
                buf[ idx + 3 ] = 255;

            }

        }

    }

}

// ---------------- per-map render ----------------
async function renderMap( id ) {

    const cfg = MAPS[ id ];
    console.log( `[${ id }] loading ${ cfg.path }` );
    const tris = await collectRoadTris( cfg );
    const triCount = tris.length / 6;
    if ( triCount === 0 ) {

        console.warn( `[${ id }] no road triangles found — check roadMaterials` );
        return;

    }

    // World XZ bbox of road only.
    let xMin = Infinity, xMax = - Infinity, zMin = Infinity, zMax = - Infinity;
    for ( let i = 0; i < tris.length; i += 2 ) {

        const x = tris[ i ], z = tris[ i + 1 ];
        if ( x < xMin ) xMin = x;
        if ( x > xMax ) xMax = x;
        if ( z < zMin ) zMin = z;
        if ( z > zMax ) zMax = z;

    }

    const dx = xMax - xMin, dz = zMax - zMin;
    const inner = SIZE - 2 * PADDING;
    const scale = inner / Math.max( dx, dz );
    // Center the bbox in the canvas.
    const offX = PADDING + ( inner - dx * scale ) * 0.5;
    const offY = PADDING + ( inner - dz * scale ) * 0.5;

    console.log( `[${ id }] ${ triCount.toLocaleString() } road tris, bbox ${ dx.toFixed( 0 ) } × ${ dz.toFixed( 0 ) } m, ${ scale.toFixed( 2 ) } px/m` );

    // Fill canvas white.
    const buf = Buffer.alloc( SIZE * SIZE * 4 );
    for ( let i = 0; i < buf.length; i += 4 ) {

        buf[ i ] = BG_RGBA[ 0 ];
        buf[ i + 1 ] = BG_RGBA[ 1 ];
        buf[ i + 2 ] = BG_RGBA[ 2 ];
        buf[ i + 3 ] = BG_RGBA[ 3 ];

    }

    // Rasterize.
    for ( let i = 0; i < tris.length; i += 6 ) {

        const px1 = offX + ( tris[ i ] - xMin ) * scale;
        const py1 = offY + ( tris[ i + 1 ] - zMin ) * scale;
        const px2 = offX + ( tris[ i + 2 ] - xMin ) * scale;
        const py2 = offY + ( tris[ i + 3 ] - zMin ) * scale;
        const px3 = offX + ( tris[ i + 4 ] - xMin ) * scale;
        const py3 = offY + ( tris[ i + 5 ] - zMin ) * scale;
        rasterizeTri( buf, SIZE, SIZE, px1, py1, px2, py2, px3, py3, ROAD_RGBA[ 0 ], ROAD_RGBA[ 1 ], ROAD_RGBA[ 2 ] );

    }

    // Encode road base PNG.
    const png = new PNG( { width: SIZE, height: SIZE } );
    buf.copy( png.data );
    const baseBuf = PNG.sync.write( png );
    const basePath = `track-maps/.tmp-${ id }-base.png`;
    const outPath = `track-maps/${ id }.png`;
    writeFileSync( basePath, baseBuf );

    // Overlay map label in Didot Italic via PIL (ImageMagick on this box has
    // no font index support for TTCs and can't find Didot by PostScript name).
    const res = spawnSync( 'python3', [ 'scripts/_overlay-label.py', basePath, outPath, cfg.label ], { stdio: 'inherit' } );
    if ( res.status !== 0 ) throw new Error( `overlay failed for ${ id }` );

    // Drop the intermediate.
    spawnSync( 'rm', [ basePath ] );

    console.log( `[${ id }] → ${ outPath }` );

}

// ---------------- main ----------------
const onlyId = process.argv[ 2 ];
const ids = onlyId ? [ onlyId ] : Object.keys( MAPS );
for ( const id of ids ) await renderMap( id );
