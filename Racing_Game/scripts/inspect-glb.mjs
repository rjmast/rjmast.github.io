import { readFileSync } from 'node:fs';

const path = process.argv[ 2 ];
const buf = readFileSync( path );

const dv = new DataView( buf.buffer, buf.byteOffset, buf.byteLength );
const magic = dv.getUint32( 0, true );
if ( magic !== 0x46546C67 ) throw new Error( 'not a GLB' );

const jsonLen = dv.getUint32( 12, true );
const jsonBytes = new Uint8Array( buf.buffer, buf.byteOffset + 20, jsonLen );
const json = JSON.parse( new TextDecoder().decode( jsonBytes ) );

console.log( '--- top-level keys:', Object.keys( json ).join( ', ' ) );
console.log( '--- scene count:', json.scenes?.length, ' default:', json.scene );
console.log( '--- node count:', json.nodes?.length );
console.log( '--- mesh count:', json.meshes?.length );
console.log( '--- material count:', json.materials?.length );

console.log( '\n--- materials:' );
( json.materials || [] ).forEach( ( m, i ) => console.log( `  [${ i }] ${ m.name || '(unnamed)' }` ) );

console.log( '\n--- meshes (name, primitive count, material indices):' );
( json.meshes || [] ).forEach( ( m, i ) => {

    const mats = ( m.primitives || [] ).map( p => p.material ).join( ',' );
    console.log( `  [${ i }] ${ m.name || '(unnamed)' }  prims=${ m.primitives?.length }  mat=[${ mats }]` );

} );

console.log( '\n--- nodes (name, mesh, translation, scale):' );
( json.nodes || [] ).slice( 0, 40 ).forEach( ( n, i ) => {

    const t = n.translation ? `t=[${ n.translation.map( v => v.toFixed( 2 ) ).join( ',' ) }]` : '';
    const s = n.scale ? `s=[${ n.scale.map( v => v.toFixed( 2 ) ).join( ',' ) }]` : '';
    const mesh = n.mesh !== undefined ? `mesh=${ n.mesh }` : '';
    console.log( `  [${ i }] ${ n.name || '(unnamed)' }  ${ mesh } ${ t } ${ s }` );

} );

// Compute world AABB from accessor min/max via mesh primitive POSITION.
let gMin = [ Infinity, Infinity, Infinity ];
let gMax = [ - Infinity, - Infinity, - Infinity ];
const accessors = json.accessors || [];

( json.meshes || [] ).forEach( ( m ) => {

    ( m.primitives || [] ).forEach( ( p ) => {

        const pos = p.attributes?.POSITION;
        if ( pos === undefined ) return;
        const a = accessors[ pos ];
        if ( ! a?.min || ! a?.max ) return;
        for ( let k = 0; k < 3; k ++ ) {

            if ( a.min[ k ] < gMin[ k ] ) gMin[ k ] = a.min[ k ];
            if ( a.max[ k ] > gMax[ k ] ) gMax[ k ] = a.max[ k ];

        }

    } );

} );

console.log( '\n--- raw AABB (pre-transform):' );
console.log( '  min:', gMin.map( v => v.toFixed( 2 ) ).join( ', ' ) );
console.log( '  max:', gMax.map( v => v.toFixed( 2 ) ).join( ', ' ) );
console.log( '  size:', gMax.map( ( v, i ) => ( v - gMin[ i ] ).toFixed( 2 ) ).join( ' x ' ) );
