import { setTimeout } from "timers/promises";

/**
 * Returns a promise that resolves in the given number of milliseconds.
 * (A replica of bluebird.delay using native promises.)
 *
 * @deprecated: Use setTimeout of "timers/promises" instead
 */
export const delay = setTimeout;
