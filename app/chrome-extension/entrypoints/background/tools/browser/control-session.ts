import { TOOL_NAMES } from 'chrome-mcp-shared';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { installCursor, setFaviconBadge, hideCursor } from '@/utils/page-overlay';

/**
 * Control session: a session-scoped layer over mcp-chrome's per-call CDP usage.
 *
 * Goals (parity with desktop assistants that drive the user's real browser):
 *  1. keep ONE debugger attachment alive per touched tab, so the browser shows a
 *     single steady "is debugging this browser" bar instead of a flicker per call;
 *  2. mark controlled tabs (tab group + action badge + favicon badge);
 *  3. give the page a visible cursor overlay while acting;
 *  4. never bring the tab or its window to the foreground.
 */

export const CONTROL_SESSION_OWNER = 'control-session';
const STATE_KEY = 'dsh.controlSession';
const SUSPEND_KEY = 'dsh.controlSuspended';

export interface ControlSessionPolicy {
  background: boolean;
  group: boolean;
  cursor: boolean;
  favicon: boolean;
}

export interface ControlSessionState {
  sessionId: string;
  /** MCP session that owns this control session. */
  owner: string;
  label: string;
  startedAt: number;
  tabIds: number[];
  policy: ControlSessionPolicy;
}

let current: ControlSessionState | null = null;
const pinned = new Set<number>();
/** MCP session id currently driving this extension (set by the tool dispatcher). */
let activeOwner = '';
/** Set after the user cancels the debug bar; blocks silent auto re-attach. */
let suspendedOwner = '';
let lastActivityAt = 0;
const groupByWindow = new Map<number, number>();

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false };
}

function normalizePolicy(partial?: Partial<ControlSessionPolicy>): ControlSessionPolicy {
  return {
    background: partial?.background ?? true,
    group: partial?.group ?? true,
    cursor: partial?.cursor ?? true,
    favicon: partial?.favicon ?? true,
  };
}

export function getControlSession(): ControlSessionState | null {
  return current;
}

export function setActiveOwner(owner: string): void {
  activeOwner = owner || '';
}

let lastPersistAt = 0;

export function touchActivity(owner?: string): void {
  // Only a real owning session may refresh the lease. An empty id (UI / SSE
  // paths) must never extend it, otherwise a stale owner never times out.
  if (!owner) return;
  if (current && current.owner && owner !== current.owner) return;
  lastActivityAt = Date.now();
  // Persist sparingly so a service-worker restart keeps the takeover clock.
  if (lastActivityAt - lastPersistAt > 3000) {
    lastPersistAt = lastActivityAt;
    try {
      void chrome.storage.session.set({ 'dsh.controlLastActivity': lastActivityAt });
    } catch {
      // ignore
    }
  }
}

export function getSessionOwner(): string {
  return current?.owner || '';
}

/** True when the user canceled debugging for this owner and we must not act. */
export function isSuspendedFor(_owner: string): boolean {
  // Suspension is global: after a user cancel nobody may act until a begin
  // clears it, otherwise a fresh MCP session id would bypass the cancel.
  return !!suspendedOwner;
}

export function getSuspensionOwner(): string {
  return suspendedOwner;
}

export function isControlSessionActive(): boolean {
  return current !== null;
}

async function persist(): Promise<void> {
  try {
    const storage = chrome.storage.session;
    if (!storage) return;
    if (current) await storage.set({ [STATE_KEY]: current });
    else await storage.remove(STATE_KEY);
  } catch {
    // best effort
  }
}

async function ensureGrouped(tabId: number, label: string): Promise<void> {
  if (!current?.policy.group) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;
    let groupId = groupByWindow.get(windowId);
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      groupByWindow.set(windowId, groupId);
      await chrome.tabGroups.update(groupId, {
        title: 'DSH · ' + label,
        color: 'blue',
        collapsed: false,
      });
    } else {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    }
  } catch (error) {
    console.warn('[control-session] tab group failed', error);
  }
}

async function ensureMarked(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: 'AI' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1d4ed8' });
  } catch {
    // action API unavailable on some channels
  }
  if (current?.policy.favicon) await setFaviconBadge(tabId, true);
  if (current?.policy.cursor) await installCursor(tabId);
}

async function unmark(tabId: number): Promise<void> {
  // Ungroup FIRST: it is the most visible residue, and cosmetics below may be
  // slow enough to consume the caller's budget.
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {
    // tab may be gone or never grouped
  }
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    // ignore
  }
  await setFaviconBadge(tabId, false);
  await hideCursor(tabId);
}

/** Pin a tab to the active control session (idempotent). */
/** Never let one slow step (attach/group/badge) hold an entire session begin. */
function withBudget<R>(work: Promise<R>, ms: number, label: string): Promise<R | undefined> {
  return Promise.race([
    work,
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]).catch(() => undefined);
}

export async function ensurePinned(tabId: number): Promise<boolean> {
  if (!current) return false;
  if (suspendedOwner && suspendedOwner === current.owner) return false;
  if (pinned.has(tabId)) return cdpSessionManager.isAttached(tabId);
  lastActivityAt = Date.now();
  try {
    const attached = await withBudget(
      cdpSessionManager.attach(tabId, CONTROL_SESSION_OWNER),
      8000,
      'attach',
    );
    if (attached === undefined && !cdpSessionManager.isAttached(tabId)) {
      console.warn('[control-session] attach timed out for tab', tabId);
      return false;
    }
    pinned.add(tabId);
    if (!current.tabIds.includes(tabId)) {
      current.tabIds.push(tabId);
      void persist();
    }
    // Group + badge are cosmetic: never block the session on them.
    await withBudget(ensureGrouped(tabId, current.label), 6000, 'group');
    await withBudget(ensureMarked(tabId), 5000, 'badge');
    return true;
  } catch (error) {
    console.warn('[control-session] failed to pin tab', tabId, error);
    return false;
  }
}

export async function beginControlSession(
  options: {
    label?: string;
    tabIds?: number[];
    policy?: Partial<ControlSessionPolicy>;
  } = {},
): Promise<ControlSessionState> {
  if (!activeOwner && current && current.owner) {
    // Anonymous callers (UI path) must not hijack or extend an agent session.
    throw new Error('E_SESSION_BUSY: an agent session already owns the browser control session');
  }
  if (current && current.owner && activeOwner && current.owner !== activeOwner) {
    const idleMs = lastActivityAt ? Date.now() - lastActivityAt : Number.MAX_SAFE_INTEGER;
    if (idleMs < 120000) {
      throw new Error(
        'E_SESSION_BUSY: another agent session (' + current.owner + ') owns the browser control session',
      );
    }
    // Owner vanished (crash / host restart): reclaim after 2 quiet minutes.
    await endControlSession(true);
  }
  if (suspendedOwner) {
    // Any session may resume: the user already saw the bar disappear and the
    // new session re-establishes control explicitly.
    suspendedOwner = '';
    try {
      void chrome.storage.session.remove(SUSPEND_KEY);
    } catch {
      // ignore
    }
  }
  if (!current) {
    current = {
      sessionId: 'dsh-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      owner: activeOwner,
      label: options.label || 'DSH',
      startedAt: Date.now(),
      tabIds: [],
      policy: normalizePolicy(options.policy),
    };
    lastActivityAt = Date.now();
    await persist();
  }
  await Promise.allSettled((options.tabIds || []).map((tabId) => ensurePinned(tabId)));
  return current;
}

export async function endControlSession(force = false): Promise<ControlSessionState | null> {
  const previous = current;
  if (!force && previous && previous.owner && activeOwner && previous.owner !== activeOwner) {
    throw new Error('E_SESSION_BUSY: only the owning session may end the control session');
  }
  current = null;
  const tabs = [...pinned];
  pinned.clear();
  groupByWindow.clear();
  // Cleanup must be bounded and independent per tab: one slow tab must never
  // leave the others attached (that is how sessions used to leak debuggers).
  await Promise.allSettled(
    tabs.map(async (tabId) => {
      await withBudget(chrome.tabs.ungroup(tabId).catch(() => undefined), 3000, 'ungroup');
      const detached = await withBudget(
        cdpSessionManager.detach(tabId, CONTROL_SESSION_OWNER),
        5000,
        'detach',
      );
      if (detached === undefined && cdpSessionManager.isAttached(tabId)) {
        // Last resort: force a raw detach so the debug banner cannot stick.
        await withBudget(chrome.debugger.detach({ tabId }).catch(() => undefined), 4000, 'force-detach');
      }
      await withBudget(unmark(tabId), 4000, 'unmark');
    }),
  );
  await withBudget(persist(), 3000, 'persist-end');
  return previous;
}

/** Remove control groups left behind by a crash or an extension reload. */
async function cleanupOrphanGroups(): Promise<void> {
  try {
    const groups = await chrome.tabGroups.query({});
    for (const group of groups) {
      if (!group.id || !String(group.title || '').startsWith('DSH · ')) continue;
      const tabs = await chrome.tabs.query({ groupId: group.id });
      const ids = tabs.map((tab) => tab.id).filter((id): id is number => typeof id === 'number');
      if (ids.length) await chrome.tabs.ungroup(ids);
    }
  } catch {
    // best effort
  }
}

/** Re-attach pinned tabs after a service-worker restart. */
export async function restoreControlSession(): Promise<void> {
  await cleanupOrphanGroups();
  try {
    const stored = await chrome.storage.session.get([STATE_KEY, SUSPEND_KEY]);
    const suspended = stored?.[SUSPEND_KEY] as string | undefined;
    const storedActivity = stored?.['dsh.controlLastActivity'] as number | undefined;
    if (typeof storedActivity === 'number' && storedActivity > lastActivityAt) lastActivityAt = storedActivity;
    if (suspended) suspendedOwner = suspended;
    const state = stored?.[STATE_KEY] as ControlSessionState | undefined;
    if (!state) return;
    current = state;
    pinned.clear();
    // A suspension survives the SW restart: never silently re-attach.
    if (suspendedOwner && suspendedOwner === state.owner) return;
    // chrome.debugger keeps attachments across a service-worker restart while
    // our in-memory bookkeeping does not. Drop the orphans first so the
    // ref-counted manager starts from a clean, truthful state.
    for (const tabId of state.tabIds || []) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // not attached: fine
      }
    }
    for (const tabId of state.tabIds || []) await ensurePinned(tabId);
  } catch {
    // ignore
  }
}

// Respect an explicit user cancel: end the session and stop auto re-attaching.
try {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (reason !== 'canceled_by_user') return;
    if (!current) return;
    if (typeof source.tabId !== 'number') return;
    suspendedOwner = current.owner;
    try {
      void chrome.storage.session.set({ [SUSPEND_KEY]: suspendedOwner });
    } catch {
      // ignore
    }
    void endControlSession(true).catch(() => {});
    console.warn('[control-session] user canceled debugging; session suspended');
  });
} catch {
  // listener registration is best effort
}

// Lease: if the agent disappears (crash, harness restart, idle), clean up.
const LEASE_IDLE_MS = 10 * 60 * 1000;
try {
  chrome.alarms.create('dsh-session-lease', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'dsh-session-lease') return;
    if (!current) return;
    if (lastActivityAt && Date.now() - lastActivityAt < LEASE_IDLE_MS) return;
    console.warn('[control-session] lease expired; releasing browser resources');
    void endControlSession(true).catch(() => {});
  });
} catch {
  // alarms are best effort
}

// Auto-pin every tab the AI touches while a session is active.
cdpSessionManager.setPinHook((tabId) => {
  void ensurePinned(tabId);
});

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (!pinned.delete(tabId)) return;
    if (current) {
      current.tabIds = current.tabIds.filter((id) => id !== tabId);
      void persist();
    }
  });
} catch {
  // ignore
}

class ControlSessionTool {
  name = TOOL_NAMES.BROWSER.CONTROL_SESSION;

  async execute(args: any = {}): Promise<ToolResult> {
    const action = String(args?.action || 'status');
    try {
      if (action === 'begin') {
        const state = await beginControlSession({
          label: typeof args?.label === 'string' ? args.label : undefined,
          tabIds: Array.isArray(args?.tabIds)
            ? args.tabIds.filter((n: any) => typeof n === 'number')
            : undefined,
          policy: args?.policy && typeof args.policy === 'object' ? args.policy : undefined,
        });
        return ok({
          ok: true,
          action,
          session: state,
          pinnedTabs: [...pinned],
          attachedTabs: cdpSessionManager.attachedTabIds(),
        });
      }

      if (action === 'end') {
        const previous = await endControlSession();
        return ok({
          ok: true,
          action,
          ended: previous,
          attachedTabs: cdpSessionManager.attachedTabIds(),
        });
      }

      let debuggerTargets: number[] = [];
      try {
        const targets = await chrome.debugger.getTargets();
        debuggerTargets = targets
          .filter((t) => t.attached && typeof t.tabId === 'number')
          .map((t) => t.tabId as number);
      } catch {
        // debugger API unavailable
      }
      if (action === 'policy') {
        // Accept both the documented `mode` and the historic `confirmMode`.
        const rawMode = args?.confirmMode ?? args?.mode ?? args?.policy?.confirmMode;
        const mode = String(rawMode || '');
        if (!['narrow', 'always', 'off'].includes(mode)) {
          return createErrorResponse(
            'E_BAD_ARG: confirmMode must be narrow | always | off (use confirmMode, or mode as an alias)',
          );
        }
        try {
          await chrome.storage.local.set({ 'dsh.policy': { confirmMode: mode } });
        } catch {
          return createErrorResponse('E_STORAGE: could not persist policy');
        }
        return ok({ ok: true, action: 'policy', confirmMode: mode });
      }

      if (action === 'audit') {
        const limit = Math.max(1, Math.min(200, Number(args?.limit) || 50));
        try {
          const got = await chrome.storage.local.get('dsh.audit');
          const list = Array.isArray(got?.['dsh.audit']) ? got['dsh.audit'] : [];
          return ok({ ok: true, action: 'audit', total: list.length, entries: list.slice(-limit) });
        } catch {
          return ok({ ok: true, action: 'audit', total: 0, entries: [] });
        }
      }

      return ok({
        ok: true,
        action: 'status',
        session: current,
        pinnedTabs: [...pinned],
        attachedTabs: cdpSessionManager.attachedTabIds(),
        debuggerTargets,
        suspendedOwner: suspendedOwner || null,
      });
    } catch (error) {
      return createErrorResponse(
        'control_session failed: ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

export const controlSessionTool = new ControlSessionTool();
