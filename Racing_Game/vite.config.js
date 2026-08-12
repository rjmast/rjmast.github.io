import { defineConfig } from 'vite';

// Hosted at https://eeman1113.github.io/race_in_progress/ — assets need the
// repo path as their base in production but stay at / in dev.
export default defineConfig( ( { command } ) => ( {
    base: './',
    build: {
        target: 'esnext',
        sourcemap: false
    }
} ) );
