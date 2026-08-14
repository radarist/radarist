/**
 * A seeded random number generator (PRNG).
 *
 * This function implements a simple hash function (Mulberry32 or similar variant)
 * to generate a deterministic sequence of random numbers based on a seed string.
 * It is crucial for ensuring that radar blips are positioned consistently
 * across server-side rendering (SSR) and client-side hydration, preventing
 * layout shifts or React hydration mismatch errors.
 *
 * @param seed - The seed string to initialize the generator.
 * @returns A function that, when called, returns a pseudo-random number between 0 (inclusive) and 1 (exclusive).
 */
export function seedrandom(seed: string): () => number {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
        h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
        h = h << 13 | h >>> 19;
    }

    /**
     * The generator function.
     * @returns A float between 0 and 1.
     */
    return function() {
        h = Math.imul(h ^ h >>> 16, 2246822507);
        h = Math.imul(h ^ h >>> 13, 3266489909);
        return ((h ^= h >>> 16) >>> 0) / 4294967296;
    }
}
