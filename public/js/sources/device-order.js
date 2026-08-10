/**
 * How the HUNT list is ordered and how much of it is shown.
 *
 * Both decisions exist for the same reason, found by driving the tab on a real
 * phone in a busy room: the scan reached seventy-plus devices within a minute,
 * and ble-map.js sorts loudest-first on every poll. Two things follow from that,
 * and neither is a styling problem.
 *
 * Rows moved under the finger. RSSI changes every poll, so the sort reorders
 * continuously and a tap lands on whichever device slid into that position --
 * repeatedly selecting the wrong one. Freezing the order while a device is
 * selected fixes it without hiding anything: the strengths still update live in
 * place, only their positions stop moving.
 *
 * And the list buried everything under it. The radar and the range panel sit
 * below the list in the document, so an unbounded list pushes them past the end
 * of any reasonable scroll. Capping is what makes them reachable at all.
 *
 * Pure functions with no DOM, so `node --test` covers the part that has to be
 * right -- same split as radar-map.js and ruler-map.js.
 */

/**
 * First-sighting index per address, accumulated across polls.
 *
 * The caller owns the Map and passes it back in; this only ever adds, so an
 * address keeps the position it was first seen at for the whole session even if
 * it drops out of a poll and returns. That stability is the entire point --
 * a device that vanishes for one poll must not jump to the end when it comes
 * back.
 */
export function rememberFirstSeen(devices, seen = new Map()) {
  for (const device of devices ?? []) {
    const address = device?.address;
    if (address != null && !seen.has(address)) seen.set(address, seen.size);
  }
  return seen;
}

/**
 * Display order: incoming (loudest-first) normally, first-seen while frozen.
 *
 * Returns a copy in both cases so callers can never mutate the mapper's array
 * out from under themselves.
 */
export function orderForDisplay(devices, seen, { frozen = false } = {}) {
  const list = (devices ?? []).slice();
  if (!frozen) return list;
  return list.sort(
    (a, b) => (seen?.get(a?.address) ?? Infinity) - (seen?.get(b?.address) ?? Infinity),
  );
}

/** Enough rows to choose from without burying what sits below the list. */
export const DEFAULT_LIST_CAP = 8;

/**
 * The visible slice, plus how many rows were withheld.
 *
 * `pin` is load-bearing rather than a nicety: with the order frozen to
 * first-seen, the selected device can easily sit past the cap, and a hunt whose
 * own target has scrolled out of its list is worse than no cap at all. A pinned
 * address is always present, and stays in its natural position rather than
 * being hoisted -- moving it would reintroduce exactly the jumping this module
 * exists to stop.
 */
export function capList(devices, { limit = DEFAULT_LIST_CAP, expanded = false, pin = null } = {}) {
  const list = (devices ?? []).slice();
  if (expanded || list.length <= limit) return { shown: list, hidden: 0 };

  const shown = list.slice(0, limit);
  const pinned = pin == null ? -1 : list.findIndex((d) => d?.address === pin);
  // Past the cap: swap it in for the last row rather than appending, so the
  // list never grows past the limit it just promised.
  if (pinned >= limit) shown[limit - 1] = list[pinned];

  return { shown, hidden: list.length - shown.length };
}
