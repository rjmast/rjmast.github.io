// Per-material road signal: total triangle area + mesh count + texture color sample.
// Run: node scripts/inspect-road.mjs public/textures/models/<map>.glb
//
// Output: materials sorted by total triangle area (descending). Roads usually
// have one of the highest areas and a dark gray average color (~30–80).
import { NodeIO } from '@gltf-transform/core';

const path = process.argv[ 2 ];
if ( ! path ) throw new Error( 'usage: inspect-road.mjs <glb>' );

const io = new NodeIO();
const doc = await io.read( path );
const root = doc.getRoot();

const materials = root.listMaterials();

// Build matIndex -> stats by walking meshes.
const stats = new Map(); // matRef -> { area, meshes }

function triArea3( ax, ay, az, bx, by, bz, cx, cy, cz ) {

    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const cxr = uy * vz - uz * vy;
    const cyr = uz * vx - ux * vz;
    const czr = ux * vy - uy * vx;
    return 0.5 * Math.sqrt( cxr * cxr + cyr * cyr + czr * czr );

}

for ( const mesh of root.listMeshes() ) {

    for ( const prim of mesh.listPrimitives() ) {

        const mat = prim.getMaterial();
        if ( ! mat ) continue;
        const pos = prim.getAttribute( 'POSITION' );
        if ( ! pos ) continue;
        const positions = pos.getArray();
        const idx = prim.getIndices();

        let area = 0;
        if ( idx ) {

            const ind = idx.getArray();
            for ( let i = 0; i < ind.length; i += 3 ) {

                const a = ind[ i ] * 3, b = ind[ i + 1 ] * 3, c = ind[ i + 2 ] * 3;
                area += triArea3(
                    positions[ a ], positions[ a + 1 ], positions[ a + 2 ],
                    positions[ b ], positions[ b + 1 ], positions[ b + 2 ],
                    positions[ c ], positions[ c + 1 ], positions[ c + 2 ]
                );

            }

        } else {

            for ( let i = 0; i < positions.length; i += 9 ) {

                area += triArea3(
                    positions[ i ], positions[ i + 1 ], positions[ i + 2 ],
                    positions[ i + 3 ], positions[ i + 4 ], positions[ i + 5 ],
                    positions[ i + 6 ], positions[ i + 7 ], positions[ i + 8 ]
                );

            }

        }

        const cur = stats.get( mat ) || { area: 0, prims: 0 };
        cur.area += area;
        cur.prims += 1;
        stats.set( mat, cur );

    }

}

// Optional: dump baseColorTexture image bytes — average channel from a sparse
// pixel sample. We don't decode PNG/JPG (too heavy without deps); instead we
// just report baseColorFactor (vec4) which is the diffuse tint, and note
// whether a texture exists.

const rows = [];
for ( const mat of materials ) {

    const s = stats.get( mat );
    if ( ! s ) continue;
    const factor = mat.getBaseColorFactor();
    const tex = mat.getBaseColorTexture();
    const r255 = Math.round( factor[ 0 ] * 255 );
    const g255 = Math.round( factor[ 1 ] * 255 );
    const b255 = Math.round( factor[ 2 ] * 255 );
    rows.push( {
        name: mat.getName() || '(unnamed)',
        area: s.area,
        prims: s.prims,
        tex: tex ? ( tex.getName() || tex.getURI() || 'embedded' ) : '-',
        color: `#${ r255.toString( 16 ).padStart( 2, '0' ) }${ g255.toString( 16 ).padStart( 2, '0' ) }${ b255.toString( 16 ).padStart( 2, '0' ) }`
    } );

}

rows.sort( ( a, b ) => b.area - a.area );

console.log( `\n${ path }: ${ rows.length } materials\n` );
console.log( 'rank | area      | prims | color   | texture                              | name' );
console.log( '-----+-----------+-------+---------+--------------------------------------+--------------------------------' );
rows.forEach( ( r, i ) => {

    console.log(
        String( i + 1 ).padStart( 4 ) + ' | ' +
        r.area.toFixed( 0 ).padStart( 9 ) + ' | ' +
        String( r.prims ).padStart( 5 ) + ' | ' +
        r.color + ' | ' +
        ( r.tex.slice( 0, 36 ) ).padEnd( 36 ) + ' | ' +
        r.name
    );

} );
