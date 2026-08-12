// Surgically delete the triangles in NODE.001 that form the rogue cube
// at world (-139.40, 9.68, -152.92). The rest of NODE.001 (the actual
// grandstand seats spread across the entire 2 km circuit) is preserved.
//
// Method: load the NODE.001 primitive's vertex positions + index buffer,
// transform every vertex to world space via the node's world matrix, and
// for every triangle whose three vertices are all within `radius` of the
// target point, drop that triangle from the index buffer. Rewrite the GLB
// with the patched indices.

import fs from 'node:fs';

const GLB_IN = '/Users/eemanmajumder/code_shit/car/race_in_progress/public/textures/models/suzuka.glb';
const GLB_OUT = GLB_IN;
const BACKUP = '/tmp/suzuka_pre_node_strip.glb';

// All targets to strip (world pos + radius in metres). Add more as the
// player flags more rogue NODE.001 cubes via the X-picker.
const STRIP_TARGETS = [
    { x: - 139.40, y: 9.68, z: - 152.92, r: 35 }
];

const buf = fs.readFileSync( GLB_IN );
fs.writeFileSync( BACKUP, buf );

const magic = buf.readUInt32LE( 0 );
if ( magic !== 0x46546c67 ) throw new Error( 'not a GLB' );
const totalLen = buf.readUInt32LE( 8 );
const jsonLen = buf.readUInt32LE( 12 );
const jsonStr = buf.subarray( 20, 20 + jsonLen ).toString( 'utf8' ).replace( /\0+$/, '' );
const json = JSON.parse( jsonStr );
const binChunkOff = 20 + ( ( jsonLen + 3 ) & ~3 );
const binLen = buf.readUInt32LE( binChunkOff );
const bin = buf.subarray( binChunkOff + 8, binChunkOff + 8 + binLen );

// Find the NODE.001 material index
let nodeMatIdx = - 1;
for ( let i = 0; i < json.materials.length; i ++ ) {
    if ( json.materials[ i ].name === 'NODE.001' ) { nodeMatIdx = i; break; }
}
if ( nodeMatIdx < 0 ) throw new Error( 'NODE.001 not found' );
console.log( `[mat] NODE.001 = idx ${ nodeMatIdx }` );

// World-matrix accumulation
function matMul( a, b ) { const r = new Float64Array( 16 ); for ( let c = 0; c < 4; c ++ ) for ( let r2 = 0; r2 < 4; r2 ++ ) { let s = 0; for ( let k = 0; k < 4; k ++ ) s += a[ k * 4 + r2 ] * b[ c * 4 + k ]; r[ c * 4 + r2 ] = s; } return r; }
function fromTRS( t, r, s ) { const tx = t ? t[ 0 ] : 0, ty = t ? t[ 1 ] : 0, tz = t ? t[ 2 ] : 0; const qx = r ? r[ 0 ] : 0, qy = r ? r[ 1 ] : 0, qz = r ? r[ 2 ] : 0, qw = r ? r[ 3 ] : 1; const sx = s ? s[ 0 ] : 1, sy = s ? s[ 1 ] : 1, sz = s ? s[ 2 ] : 1; const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz; const xx = qx * x2, xy = qx * y2, xz = qx * z2, yy = qy * y2, yz = qy * z2, zz = qz * z2; const wx = qw * x2, wy = qw * y2, wz = qw * z2; const m = new Float64Array( 16 ); m[ 0 ] = ( 1 - ( yy + zz ) ) * sx; m[ 1 ] = ( xy + wz ) * sx; m[ 2 ] = ( xz - wy ) * sx; m[ 3 ] = 0; m[ 4 ] = ( xy - wz ) * sy; m[ 5 ] = ( 1 - ( xx + zz ) ) * sy; m[ 6 ] = ( yz + wx ) * sy; m[ 7 ] = 0; m[ 8 ] = ( xz + wy ) * sz; m[ 9 ] = ( yz - wx ) * sz; m[ 10 ] = ( 1 - ( xx + yy ) ) * sz; m[ 11 ] = 0; m[ 12 ] = tx; m[ 13 ] = ty; m[ 14 ] = tz; m[ 15 ] = 1; return m; }
function localM( n ) { if ( n.matrix ) { const m = new Float64Array( 16 ); for ( let i = 0; i < 16; i ++ ) m[ i ] = n.matrix[ i ]; return m; } return fromTRS( n.translation, n.rotation, n.scale ); }
const parent = new Array( json.nodes.length ).fill( - 1 );
for ( const s of json.scenes ) { const stk = s.nodes.map( r => ( { i: r, p: - 1 } ) ); while ( stk.length ) { const { i, p } = stk.pop(); parent[ i ] = p; const c = json.nodes[ i ].children || []; for ( const ci of c ) stk.push( { i: ci, p: i } ); } }
const wMat = new Array( json.nodes.length ).fill( null );
function wmat( i ) { if ( wMat[ i ] ) return wMat[ i ]; const l = localM( json.nodes[ i ] ); const w = parent[ i ] >= 0 ? matMul( wmat( parent[ i ] ), l ) : l; wMat[ i ] = w; return w; }
function txf( m, p ) { const x = p[ 0 ], y = p[ 1 ], z = p[ 2 ]; return [ m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ], m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ], m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ] ]; }

// Find every (node, mesh, prim) triplet using NODE.001
const targets = [];
for ( let ni = 0; ni < json.nodes.length; ni ++ ) {
    const n = json.nodes[ ni ];
    if ( n.mesh == null ) continue;
    const mesh = json.meshes[ n.mesh ];
    for ( let pi = 0; pi < mesh.primitives.length; pi ++ ) {
        if ( mesh.primitives[ pi ].material === nodeMatIdx ) targets.push( { ni, mi: n.mesh, pi } );
    }
}
console.log( `[scan] ${ targets.length } primitive(s) use NODE.001` );

// Per-target, read positions + indices, classify triangles, build new index buffer
// Accessor-aware readers: use accessor.byteOffset + accessor.count, not the whole bufferView.
function readF32Acc( acc ) {
    const bv = json.bufferViews[ acc.bufferView ];
    const off = ( bv.byteOffset || 0 ) + ( acc.byteOffset || 0 );
    return new Float32Array( bin.buffer, bin.byteOffset + off, acc.count * 3 );
}
function readIdxAcc( acc ) {
    const bv = json.bufferViews[ acc.bufferView ];
    const off = ( bv.byteOffset || 0 ) + ( acc.byteOffset || 0 );
    if ( acc.componentType === 5125 ) return new Uint32Array( bin.buffer, bin.byteOffset + off, acc.count );
    if ( acc.componentType === 5123 ) return new Uint16Array( bin.buffer, bin.byteOffset + off, acc.count );
    if ( acc.componentType === 5121 ) return new Uint8Array(  bin.buffer, bin.byteOffset + off, acc.count );
    throw new Error( 'unsupported index componentType ' + acc.componentType );
}

// We'll append new bufferViews to bin and patch the primitives to point at them.
const newBinChunks = []; // [{ buffer: Uint8Array, byteOffset: assigned later, byteLength }]
const bvAdds = []; // new bufferView entries

let totalStripped = 0;
for ( const t of targets ) {
    const prim = json.meshes[ t.mi ].primitives[ t.pi ];
    const posAcc = json.accessors[ prim.attributes.POSITION ];
    const positions = readF32Acc( posAcc );
    const indAcc = json.accessors[ prim.indices ];
    const indices = readIdxAcc( indAcc );
    // Use the node's quaternion directly — wmat composition was tripping a
    // sign convention. q*v*q^-1 works regardless of column-vs-row-major.
    const nrot = json.nodes[ t.ni ].rotation || [ 0, 0, 0, 1 ];
    function qrot( p ) {
        const [ x, y, z ] = p;
        const [ qx, qy, qz, qw ] = nrot;
        const ix =  qw * x + qy * z - qz * y;
        const iy =  qw * y + qz * x - qx * z;
        const iz =  qw * z + qx * y - qy * x;
        const iw = - qx * x - qy * y - qz * z;
        return [
            ix * qw + iw * - qx + iy * - qz - iz * - qy,
            iy * qw + iw * - qy + iz * - qx - ix * - qz,
            iz * qw + iw * - qz + ix * - qy - iy * - qx,
        ];
    }

    const newIndices = [];
    const triCount = indices.length / 3;
    let stripped = 0;
    for ( let i = 0; i < triCount; i ++ ) {
        const a = indices[ i * 3 ], b = indices[ i * 3 + 1 ], c = indices[ i * 3 + 2 ];
        const va = qrot( [ positions[ a * 3 ], positions[ a * 3 + 1 ], positions[ a * 3 + 2 ] ] );
        const vb = qrot( [ positions[ b * 3 ], positions[ b * 3 + 1 ], positions[ b * 3 + 2 ] ] );
        const vc = qrot( [ positions[ c * 3 ], positions[ c * 3 + 1 ], positions[ c * 3 + 2 ] ] );
        // Triangle centroid for the inside-radius test
        const cx = ( va[ 0 ] + vb[ 0 ] + vc[ 0 ] ) / 3;
        const cy = ( va[ 1 ] + vb[ 1 ] + vc[ 1 ] ) / 3;
        const cz = ( va[ 2 ] + vb[ 2 ] + vc[ 2 ] ) / 3;
        let inside = false;
        for ( const s of STRIP_TARGETS ) {
            const dx = cx - s.x, dy = cy - s.y, dz = cz - s.z;
            if ( dx * dx + dy * dy + dz * dz <= s.r * s.r ) { inside = true; break; }
        }
        if ( inside ) { stripped ++; continue; }
        newIndices.push( a, b, c );
    }
    totalStripped += stripped;
    console.log( `[strip] prim ${ t.pi }: dropped ${ stripped }/${ triCount } triangles (kept ${ newIndices.length / 3 })` );

    // Build new index buffer at appropriate width
    let newBuf, componentType;
    const maxIdx = newIndices.reduce( ( m, v ) => v > m ? v : m, 0 );
    if ( maxIdx < 65536 ) {
        const arr = new Uint16Array( newIndices );
        newBuf = Buffer.from( arr.buffer, arr.byteOffset, arr.byteLength );
        componentType = 5123;
    } else {
        const arr = new Uint32Array( newIndices );
        newBuf = Buffer.from( arr.buffer, arr.byteOffset, arr.byteLength );
        componentType = 5125;
    }
    newBinChunks.push( newBuf );
    bvAdds.push( { primTargets: [ t ], byteLength: newBuf.length, componentType, count: newIndices.length } );
}

console.log( `[total] stripped ${ totalStripped } triangles` );
if ( totalStripped === 0 ) { console.log( 'nothing to strip; aborting' ); process.exit( 0 ); }

// Stitch new bin: original bin + (4-byte-aligned-pad + each new buffer with its own pad)
const origBinLen = bin.length;
const parts = [ bin ];
let cursor = origBinLen;
const newBVIndices = [];
for ( let i = 0; i < newBinChunks.length; i ++ ) {
    const pad = ( 4 - ( cursor % 4 ) ) % 4;
    if ( pad ) { parts.push( Buffer.alloc( pad ) ); cursor += pad; }
    const bc = newBinChunks[ i ];
    parts.push( bc );
    const bvIdx = json.bufferViews.length;
    json.bufferViews.push( { buffer: 0, byteOffset: cursor, byteLength: bc.length, target: 34963 } );
    newBVIndices.push( bvIdx );
    cursor += bc.length;
}
const newBin = Buffer.concat( parts );

// Patch each primitive's indices accessor: create a new accessor pointing at the new bufferView
for ( let i = 0; i < bvAdds.length; i ++ ) {
    const t = bvAdds[ i ].primTargets[ 0 ];
    const newAccIdx = json.accessors.length;
    json.accessors.push( {
        bufferView: newBVIndices[ i ],
        componentType: bvAdds[ i ].componentType,
        count: bvAdds[ i ].count,
        type: 'SCALAR'
    } );
    json.meshes[ t.mi ].primitives[ t.pi ].indices = newAccIdx;
}

// Update buffer length
json.buffers[ 0 ].byteLength = newBin.length;

// Re-pack
let newJsonStr = JSON.stringify( json );
while ( newJsonStr.length % 4 !== 0 ) newJsonStr += ' ';
const newJsonBuf = Buffer.from( newJsonStr, 'utf8' );
const binPad = ( 4 - ( newBin.length % 4 ) ) % 4;
const newBinAligned = binPad ? Buffer.concat( [ newBin, Buffer.alloc( binPad ) ] ) : newBin;
const newTotal = 12 + 8 + newJsonBuf.length + 8 + newBinAligned.length;
const out = Buffer.alloc( newTotal );
out.writeUInt32LE( 0x46546c67, 0 );
out.writeUInt32LE( 2, 4 );
out.writeUInt32LE( newTotal, 8 );
out.writeUInt32LE( newJsonBuf.length, 12 );
out.writeUInt32LE( 0x4E4F534A, 16 );
newJsonBuf.copy( out, 20 );
const binHdrOff = 20 + newJsonBuf.length;
out.writeUInt32LE( newBinAligned.length, binHdrOff );
out.writeUInt32LE( 0x004E4942, binHdrOff + 4 );
newBinAligned.copy( out, binHdrOff + 8 );

fs.writeFileSync( GLB_OUT, out );
console.log( `[out] ${ out.length } bytes -> ${ GLB_OUT } (backup at ${ BACKUP })` );
