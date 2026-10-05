/** The tab ids of `admin/jsonConfig.json` — the only values the tab memory can hold for this adapter. */
const OWN_TAB_IDS = new Set(["_main", "_expert"]);

/** What the tab memory is kept in: a real Storage, or the admin's server-synced object without enumeration. */
type TabMemoryStorage = Pick<Storage, "getItem" | "removeItem"> & Partial<Pick<Storage, "length" | "key">>;

/**
 * Forget which tab was open last, so the next visit to the instance settings starts on the main tab.
 *
 * The admin's json-config remembers the last tab per adapter (measured by govee-smart on Admin 8.0.12 /
 * json-config 10.0.0, `ConfigTabs`): every tab switch writes `localStorage["<dialogName || 'App'>.<adapter>"]`,
 * and the dialog opens on that entry whenever the URL names no tab — which a fresh open never does. Without
 * this, the settings would open on the Expert tab from the first report on. The card mounts when the tab
 * is entered (after that write) and unmounts when the settings close — the entry is removed at both ends.
 *
 * With "store GUI settings on the server", `window._localStorage` is a plain object with getItem / setItem /
 * removeItem only (no `length`, no `key()`), so the known key is asked for directly; the enumeration only
 * covers a real Storage. Only this adapter's entries holding one of its own tab ids are touched.
 *
 * @param namespace the instance, e.g. `yamaha.0`
 */
export function forgetLastTab(namespace: string): void {
  const adapterName = namespace.split(".")[0];
  try {
    const w = window as Window & { _localStorage?: TabMemoryStorage };
    const storage: TabMemoryStorage = w._localStorage ?? window.localStorage;
    const stale = new Set<string>();
    const known = `App.${adapterName}`;
    if (OWN_TAB_IDS.has(storage.getItem(known) ?? "")) {
      stale.add(known);
    }
    if (typeof storage.length === "number" && typeof storage.key === "function") {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key?.endsWith(`.${adapterName}`) && OWN_TAB_IDS.has(storage.getItem(key) ?? "")) {
          stale.add(key);
        }
      }
    }
    // Collect first, then remove — deleting while indexing skips entries.
    for (const key of stale) {
      storage.removeItem(key);
    }
  } catch {
    // Storage blocked (private window, disabled site data): nothing to forget.
  }
}
