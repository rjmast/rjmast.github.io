// Trystero wraps WebRTC + nostr signaling. Two peers in the same room name
// hand-shake through a public nostr relay, then talk direct P2P. No backend
// of our own — works fine on GitHub Pages.
//
// Trystero 0.25+ API: actions are single objects with .send / .onMessage
// (not the old [send, get] tuple) and onPeerJoin/onPeerLeave are setters.
import { joinRoom as tryJoinRoom, selfId } from 'trystero/nostr';

const APP_ID = 'cars_race_in_progress';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ambiguous chars omitted

export function generateRoomCode() {

    let s = '';
    for ( let i = 0; i < 5; i ++ ) s += CODE_CHARS[ Math.floor( Math.random() * CODE_CHARS.length ) ];
    return s;

}

// Open or join a room. The library is symmetric — "host" vs "joiner" only
// matters at the application layer (we track it locally). Returns a small
// facade object so main.js doesn't need to know Trystero specifics.
export function openRoom( roomCode, meta ) {

    const room = tryJoinRoom( { appId: APP_ID }, roomCode );

    // Trystero actions are bidirectional. We register a few:
    //   snap — high-frequency position/rotation/velocity broadcasts
    //   meta — sticky info (display name + chosen car index); resent on peer join
    //   race — race lifecycle events (start countdown, finish line crossed)
    const snapAction = room.makeAction( 'snap' );
    const metaAction = room.makeAction( 'meta' );
    const raceAction = room.makeAction( 'race' );

    const callbacks = {
        peerJoin: () => {},
        peerLeave: () => {},
        snapshot: () => {},
        meta: () => {},
        race: () => {}
    };

    room.onPeerJoin = ( peerId ) => {

        // Every new peer needs our meta — Trystero doesn't replay actions sent
        // before they joined, so we resend on connect.
        try { metaAction.send( facade.meta, { target: peerId } ); } catch {}
        callbacks.peerJoin( peerId );

    };

    room.onPeerLeave = ( peerId ) => callbacks.peerLeave( peerId );

    snapAction.onMessage = ( data, ctx ) => callbacks.snapshot( ctx.peerId, data );
    metaAction.onMessage = ( data, ctx ) => callbacks.meta( ctx.peerId, data );
    raceAction.onMessage = ( data, ctx ) => callbacks.race( ctx.peerId, data );

    const facade = {
        roomCode,
        selfId,
        meta, // mutable — when the player swaps car, update + call sendMeta()
        sendSnapshot: ( snap ) => snapAction.send( snap ),
        sendMeta: () => metaAction.send( facade.meta ),
        sendRace: ( evt ) => raceAction.send( evt ),
        on: ( eventName, cb ) => { callbacks[ eventName ] = cb; },
        peers: () => Object.keys( room.getPeers() ),
        leave: () => room.leave()
    };

    return facade;

}
